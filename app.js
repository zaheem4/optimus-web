/* OPTIMUS — static, client-only build.
   No backend. Everything (chat history, memory, projects, files) lives in
   this browser's localStorage. Your API key never leaves the browser except
   to call Google's Gemini endpoint directly. Good for GitHub Pages / any
   static host. For multi-device sync or a shared database, use the
   FastAPI backend version instead. */

const view = document.getElementById("view"), toast = document.getElementById("toast");
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.1-flash-lite"; // current stable, low-cost Gemini model (Sept 2026)
const IMAGE_MODEL = "gemini-3.1-flash-image";   // current Gemini image ("Nano Banana") model

let conversationId = null;

const state = {
  apiKey: localStorage.getItem("optimus_api_key") || "",
  model: localStorage.getItem("optimus_model") || DEFAULT_MODEL,
};

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

let conversations = load("optimus_conversations", []); // [{id,title,messages:[{role,content}],updated_at}]
let memories = load("optimus_memories", []);            // [{id,content}]
let projects = load("optimus_projects", []);            // [{id,name,description}]
let files = load("optimus_files", []);                  // [{id,name,mime,size,text}]
let images = load("optimus_images", []);                // [{id,prompt,dataUrl,mime,created_at}]

function nextId(arr) { return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1; }
function notify(t) { toast.textContent = t; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2200); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function saveSettings() {
  state.apiKey = document.getElementById("apiKey").value.trim();
  state.model = document.getElementById("model").value.trim() || DEFAULT_MODEL;
  localStorage.setItem("optimus_api_key", state.apiKey);
  localStorage.setItem("optimus_model", state.model);
  document.getElementById("modelPill").textContent = "● " + state.model;
  notify("Settings saved");
}
function clearKey() {
  state.apiKey = "";
  localStorage.removeItem("optimus_api_key");
  document.getElementById("apiKey").value = "";
  notify("API key cleared");
}
function needKey() { if (!state.apiKey) { page("settings"); notify("Add your API key first"); return false; } return true; }
function setNav(p) { document.querySelectorAll(".nav").forEach(x => x.classList.toggle("active", x.dataset.page === p)); }
function page(p) { setNav(p); ({ home, chat, projects: projectsPage, files: filesPage, images: imagesPage, memory: memoryPage, agents, settings, research }[p] || home)(); }
function newChat() { conversationId = null; chat(); }
function card(i, t, d, p) { return `<button class="card" style="text-align:left;color:inherit;cursor:pointer" onclick="${p === "research" ? "research()" : `page('${p}')`}"><div class="icon">${i}</div><h3>${t}</h3><p>${d}</p></button>`; }

/* ---------- Gemini calls (direct from the browser) ---------- */
async function geminiChat(messages, temperature = 0.7) {
  let system = null;
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") { system = m.content; continue; }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] });
  }
  const payload = { contents, generationConfig: { temperature } };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch(`${GEMINI_URL}/${state.model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": state.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini API error ${r.status}`);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("") || "I received an empty response.";
}
async function geminiSearch(query) {
  const payload = { contents: [{ role: "user", parts: [{ text: query }] }], tools: [{ google_search: {} }] };
  const r = await fetch(`${GEMINI_URL}/${state.model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": state.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini search error ${r.status}`);
  return data;
}
async function geminiGenerateImage(prompt) {
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };
  const r = await fetch(`${GEMINI_URL}/${IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": state.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini image error ${r.status}`);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData || p.inline_data);
  if (!imgPart) throw new Error("No image returned. Try rephrasing the prompt.");
  const inline = imgPart.inlineData || imgPart.inline_data;
  return { mime: inline.mimeType || inline.mime_type || "image/png", b64: inline.data };
}
async function geminiTranscribeAudio(base64, mime) {
  const payload = {
    contents: [{ role: "user", parts: [
      { text: "Transcribe this audio verbatim. Reply with ONLY the transcribed text, no commentary, no quotes." },
      { inlineData: { mimeType: mime, data: base64 } },
    ] }],
  };
  const r = await fetch(`${GEMINI_URL}/${state.model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": state.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini transcription error ${r.status}`);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("").trim();
}

const SYSTEM = `You are OPTIMUS, a helpful personal AI workspace.
Be accurate and transparent. Do not claim an action happened unless it actually happened.
When a task needs a tool, explain what will be done. Never perform destructive, financial,
account, or computer-control actions through this web app. Keep answers useful and concise.`;

function buildContext() {
  let ctx = SYSTEM;
  if (memories.length) ctx += "\n\nUSER MEMORY:\n" + memories.map(x => "- " + x.content).join("\n");
  const withText = files.filter(f => f.text).slice(0, 5);
  if (withText.length) ctx += "\n\nRECENT UPLOADED FILE CONTEXT:\n" + withText.map(f => `FILE: ${f.name}\n${f.text}`).join("\n\n");
  return ctx;
}

/* ---------- Pages ---------- */
function home() {
  view.innerHTML = `<section class="hero"><h1>Hello, I'm <b>Optimus</b></h1><p>Your AI workspace for ideas, code, research and creation.</p><div class="composer"><textarea id="prompt" rows="1" placeholder="Ask Optimus anything..."></textarea><button class="sendBtn" onclick="sendHome()">↑</button></div><div class="chips"><button class="chip" onclick="quick('Research')">⌕ Research</button><button class="chip" onclick="quick('Create')">✧ Create</button><button class="chip" onclick="quick('Code')">&lt;/&gt; Code</button><button class="chip" onclick="quick('Analyze')">▥ Analyze</button><button class="chip" onclick="page('agents')">＋ More</button></div></section><section class="grid">${card("⌘", "Write Code", "Build, debug and improve your code.", "chat")}${card("◇", "Turn Ideas Into Plans", "Get structured steps for your goals.", "agents")}${card("⌕", "Deep Research", "Explore topics with live search grounding.", "research")}${card("▧", "Generate Images", "Create images with Gemini, right in your browser.", "images")}</section>`;
  document.getElementById("prompt").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendHome(); } });
}
function quick(t) { document.getElementById("prompt").value = t + " — "; document.getElementById("prompt").focus(); }
async function sendHome() { const p = document.getElementById("prompt").value.trim(); if (!p) return; if (!needKey()) return; chat(p); }

function chat(prefill = "") {
  view.innerHTML = `<div class="chatWrap"><div class="sectionTitle"><h2>Chat</h2><p>Conversation, memory and file context stay connected.</p></div><div id="messages" class="messages"></div><div class="composer chatComposer"><button class="micBtn" id="micBtn" onclick="toggleRecording()" title="Voice input">🎤</button><textarea id="chatInput" rows="2" placeholder="Ask Optimus anything...">${esc(prefill)}</textarea><button class="sendBtn" onclick="sendChat()">↑</button></div></div>`;
  loadMessages();
  if (!(navigator.mediaDevices && window.MediaRecorder)) {
    const mb = document.getElementById("micBtn");
    mb.disabled = true; mb.style.opacity = .35; mb.title = "Voice input isn't supported in this browser";
  }
  document.getElementById("chatInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
}
function loadMessages() {
  if (!conversationId) { document.getElementById("messages").innerHTML = ""; return; }
  const convo = conversations.find(c => c.id === conversationId);
  document.getElementById("messages").innerHTML = (convo?.messages || []).map(m => `<div class="bubble ${m.role}">${esc(m.content)}</div>`).join("");
}
async function sendChat() {
  if (!needKey()) return;
  const input = document.getElementById("chatInput"), text = input.value.trim();
  if (!text) return;
  const box = document.getElementById("messages");
  box.innerHTML += `<div class="bubble user">${esc(text)}</div><div class="bubble assistant" id="typing"><span class="spinner"></span> Thinking...</div>`;
  box.scrollTop = box.scrollHeight;
  input.value = "";
  if (conversationId === null) {
    conversationId = nextId(conversations);
    conversations.unshift({ id: conversationId, title: text.slice(0, 80), messages: [], updated_at: Date.now() });
  }
  const convo = conversations.find(c => c.id === conversationId);
  convo.messages.push({ role: "user", content: text });
  try {
    const history = convo.messages.slice(-30);
    const answer = await geminiChat([{ role: "system", content: buildContext() }, ...history]);
    convo.messages.push({ role: "assistant", content: answer });
    convo.updated_at = Date.now();
    save("optimus_conversations", conversations);
    document.getElementById("typing").outerHTML = `<div class="bubble assistant">${esc(answer)}</div>`;
  } catch (e) {
    document.getElementById("typing").outerHTML = `<div class="bubble assistant danger">${esc(e.message)}</div>`;
  }
}

/* ---------- Voice input: record in-browser, transcribe with Gemini ----------
   Uses MediaRecorder (works on Android Chrome, iOS Safari 14.3+, and desktop
   browsers) instead of the inconsistent Web Speech API, then sends the audio
   to Gemini for transcription so quality is the same on every platform. */
let mediaRecorder = null, audioChunks = [], recordingMime = "";
function pickMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg"];
  for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  return ""; // let the browser choose (e.g. iOS Safari)
}
async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.stop(); return; }
  if (!needKey()) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingMime = pickMime();
    mediaRecorder = recordingMime ? new MediaRecorder(stream, { mimeType: recordingMime }) : new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      document.getElementById("micBtn")?.classList.remove("recording");
      const mime = mediaRecorder.mimeType || recordingMime || "audio/webm";
      const blob = new Blob(audioChunks, { type: mime });
      if (blob.size < 500) { notify("Recording was too short"); return; }
      const input = document.getElementById("chatInput");
      const original = input.value;
      input.value = original + (original ? " " : "") + "(transcribing...)";
      try {
        const base64 = await blobToBase64(blob);
        const text = await geminiTranscribeAudio(base64, mime);
        input.value = (original + " " + text).trim();
        input.focus();
      } catch (e) {
        input.value = original;
        notify("Transcription failed: " + e.message);
      }
    };
    mediaRecorder.start();
    document.getElementById("micBtn")?.classList.add("recording");
  } catch (e) {
    notify("Microphone access denied or unavailable");
  }
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* ---------- Image generation ---------- */
function imagesPage() {
  view.innerHTML = `<div class="sectionTitle"><h2>Create Images</h2><p>Generated with Gemini's image model, directly from your browser.</p></div><div class="list"><div class="card"><textarea class="textarea" id="imgPrompt" placeholder="A watercolor fox reading a book under a maple tree"></textarea><button class="action" onclick="generateImage()">Generate</button></div><div id="imgStatus"></div><div class="imgGrid" id="imgGrid"></div></div>`;
  renderImages();
}
function renderImages() {
  document.getElementById("imgGrid").innerHTML = images.length ? images.map(x => `<div class="imgCard"><img src="${x.dataUrl}" alt="${esc(x.prompt)}"><div class="imgMeta">${esc(x.prompt.slice(0, 60))}<br><a href="${x.dataUrl}" download="optimus-${x.id}.png" style="color:#cfe0ff">Download</a> · <a href="#" onclick="delImage(${x.id});return false" style="color:#ff9e9e">Delete</a></div></div>`).join("") : `<div class="drop">No images yet — describe one above.</div>`;
}
async function generateImage() {
  if (!needKey()) return;
  const prompt = document.getElementById("imgPrompt").value.trim(); if (!prompt) return;
  document.getElementById("imgStatus").innerHTML = `<div class="card"><span class="spinner"></span> Generating image...</div>`;
  try {
    const { mime, b64 } = await geminiGenerateImage(prompt);
    images.unshift({ id: nextId(images), prompt, mime, dataUrl: `data:${mime};base64,${b64}`, created_at: Date.now() });
    save("optimus_images", images);
    document.getElementById("imgStatus").innerHTML = "";
    renderImages();
  } catch (e) {
    document.getElementById("imgStatus").innerHTML = `<div class="card danger">${esc(e.message)}</div>`;
  }
}
function delImage(id) { images = images.filter(x => x.id !== id); save("optimus_images", images); renderImages(); }

function projectsPage() {
  view.innerHTML = `<div class="sectionTitle"><h2>Projects</h2><p>Separate workspaces for different goals.</p></div><div class="list"><div class="card"><div class="formRow"><input class="input" id="pn" placeholder="Project name"><button class="action" onclick="addProject()">Create</button></div><label class="label">Description</label><input class="input" id="pd" placeholder="Optional project context"></div><div id="projectList"></div></div>`;
  refreshProjects();
}
function refreshProjects() {
  document.getElementById("projectList").innerHTML = projects.length ? projects.map(x => `<div class="card"><b>${esc(x.name)}</b><p>${esc(x.description || "No description")}</p><button class="action danger" onclick="delProject(${x.id})">Delete</button></div>`).join("") : `<div class="drop">No projects yet.</div>`;
}
function addProject() {
  const name = document.getElementById("pn").value.trim(); if (!name) return;
  projects.unshift({ id: nextId(projects), name, description: document.getElementById("pd").value.trim() });
  save("optimus_projects", projects); notify("Project created"); refreshProjects();
}
function delProject(id) { projects = projects.filter(x => x.id !== id); save("optimus_projects", projects); refreshProjects(); }

function memoryPage() {
  view.innerHTML = `<div class="sectionTitle"><h2>Memory</h2><p>Facts OPTIMUS can use across conversations.</p></div><div class="list"><div class="card"><div class="formRow"><input class="input" id="mem" placeholder="e.g. My main project is OPTIMUS"><button class="action" onclick="addMem()">Remember</button></div></div>${memories.length ? memories.map(x => `<div class="card">${esc(x.content)} <button class="action danger" onclick="delMem(${x.id})">Delete</button></div>`).join("") : `<div class="drop">No memories saved.</div>`}</div>`;
}
function addMem() {
  const v = document.getElementById("mem").value.trim(); if (!v) return;
  memories.unshift({ id: nextId(memories), content: v }); save("optimus_memories", memories); memoryPage(); notify("Memory saved");
}
function delMem(id) { memories = memories.filter(x => x.id !== id); save("optimus_memories", memories); memoryPage(); }

function filesPage() {
  view.innerHTML = `<div class="sectionTitle"><h2>Files</h2><p>Upload TXT, Markdown, CSV, JSON, PDF or DOCX for context. Extraction happens fully in your browser. You can edit the extracted text before OPTIMUS uses it.</p></div><div class="list"><div class="card"><input type="file" id="file" accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx,text/*,application/pdf,application/json,.doc"><button class="action" onclick="uploadFile()">Upload</button><p id="uploadStatus" class="muted">Maximum 20 MB. Text is stored in this browser only.</p></div>${files.length ? files.map(x => `<div class="card"><b>${esc(x.name)}</b><p>${esc(x.mime || "file")} · ${x.size} bytes ${x.text ? "· text extracted" : "· no text extracted"}</p>${x.text ? `<button class="action" onclick="toggleEdit(${x.id})">View / Edit text</button>` : ""} <button class="action danger" onclick="delFile(${x.id})">Delete</button><div id="editWrap-${x.id}" style="display:none"><textarea class="input fileEditBox" id="editArea-${x.id}">${esc(x.text || "")}</textarea><button class="action" onclick="saveFileEdit(${x.id})">Save edits</button></div></div>`).join("") : `<div class="drop">No files uploaded.</div>`}</div>`;
}
function toggleEdit(id) {
  const w = document.getElementById(`editWrap-${id}`);
  w.style.display = w.style.display === "none" ? "block" : "none";
}
function saveFileEdit(id) {
  const val = document.getElementById(`editArea-${id}`).value;
  const f = files.find(x => x.id === id); if (!f) return;
  f.text = val; save("optimus_files", files);
  notify("Saved — OPTIMUS will use your edited text");
}
function delFile(id) { files = files.filter(x => x.id !== id); save("optimus_files", files); filesPage(); }
async function uploadFile() {
  const input = document.getElementById("file");
  const f = input.files[0]; if (!f) return;
  const statusEl = document.getElementById("uploadStatus");
  if (f.size > 20 * 1024 * 1024) { notify("File is larger than 20 MB."); return; }
  let text = "";
  statusEl.textContent = "Reading file...";
  try {
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    const isDocx = /\.docx$/i.test(f.name) || (f.type || "").includes("wordprocessingml");
    const isPlain = /^text\//.test(f.type) || /json$/.test(f.type) || /\.(txt|md|markdown|csv|json)$/i.test(f.name);
    if (isPdf) {
      statusEl.textContent = "Loading PDF reader...";
      text = (await extractPdfText(f)).slice(0, 50000);
    } else if (isDocx) {
      statusEl.textContent = "Loading Word reader...";
      text = (await extractDocxText(f)).slice(0, 50000);
    } else if (isPlain) {
      text = (await f.text()).slice(0, 50000);
    } else {
      notify("Unsupported file type — try TXT, MD, CSV, JSON, PDF or DOCX.");
      statusEl.textContent = "Maximum 20 MB. Text is stored in this browser only.";
      return;
    }
  } catch (e) {
    notify("Couldn't extract text: " + e.message);
    text = "";
  }
  files.unshift({ id: nextId(files), name: f.name, mime: f.type || "application/octet-stream", size: f.size, text });
  save("optimus_files", files);
  notify(text ? "File uploaded and text extracted" : "File uploaded (no text extracted)");
  input.value = "";
  filesPage();
}
async function extractPdfText(file) {
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    out += tc.items.map(it => it.str).join(" ") + "\n";
  }
  return out;
}
async function extractDocxText(file) {
  try {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.21/mammoth.browser.min.js");
  } catch {
    await loadScript("https://cdn.jsdelivr.net/npm/mammoth@1.7.0/mammoth.browser.min.js");
  }
  const buf = await file.arrayBuffer();
  const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return res.value || "";
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

function agents() {
  view.innerHTML = `<div class="sectionTitle"><h2>Agents</h2><p>Turn a goal into a safe, inspectable plan.</p></div><div class="list"><div class="card"><textarea class="textarea" id="goal" placeholder="Build a portfolio website for my software projects"></textarea><button class="action" onclick="makePlan()">Create Plan</button></div><div id="plan"></div></div>`;
}
function makePlan() {
  const goal = document.getElementById("goal").value.trim(); if (!goal) return;
  const steps = [
    { id: 1, name: "Understand", status: "ready", risk: "low" },
    { id: 2, name: "Plan", status: "ready", risk: "low" },
    { id: 3, name: "Use approved tools", status: "requires_tool_selection", risk: "medium" },
    { id: 4, name: "Verify", status: "ready", risk: "low" },
    { id: 5, name: "Report", status: "ready", risk: "low" },
  ];
  document.getElementById("plan").innerHTML = `<div class="card"><b>Goal</b><p>${esc(goal)}</p><pre>${esc(JSON.stringify(steps, null, 2))}</pre><p>High-risk actions require explicit confirmation and are disabled in this web app.</p></div>`;
}

function research() {
  if (!needKey()) return;
  view.innerHTML = `<div class="sectionTitle"><h2>Deep Research</h2><p>Uses Gemini search grounding when supported by your configured model/account.</p></div><div class="list"><div class="card"><textarea class="textarea" id="rq" placeholder="What should OPTIMUS research?"></textarea><button class="action" onclick="runResearch()">Research</button></div><div id="rr"></div></div>`;
}
async function runResearch() {
  const q = document.getElementById("rq").value.trim(); if (!q) return;
  document.getElementById("rr").innerHTML = `<div class="card"><span class="spinner"></span> Researching...</div>`;
  try {
    const d = await geminiSearch(q);
    document.getElementById("rr").innerHTML = `<div class="card"><pre>${esc(JSON.stringify(d, null, 2))}</pre></div>`;
  } catch (e) {
    document.getElementById("rr").innerHTML = `<div class="card danger">${esc(e.message)}</div>`;
  }
}

function settings() {
  view.innerHTML = `<div class="settings"><div class="sectionTitle"><h2>Settings</h2><p>Connect the AI brain to OPTIMUS.</p></div><div class="card"><label class="label">Gemini API Key</label><input class="input" id="apiKey" type="password" value="${esc(state.apiKey)}" placeholder="Paste your key here"><label class="label">Model</label><input class="input" id="model" value="${esc(state.model)}" placeholder="${DEFAULT_MODEL}"><div style="height:12px"></div><button class="action" onclick="saveSettings()">Save on this device</button> <button class="action" onclick="clearKey()">Clear key</button></div><div class="notice" style="margin-top:12px">This is a fully client-side build: your key lives only in this browser's localStorage and is sent only to Google's Gemini endpoint, directly from your browser. Nothing passes through a server. Anyone with access to this browser profile can read the key — don't use this on a shared computer.</div><div class="card" style="margin-top:12px"><b>System</b><p>Static site · No backend · Data stored in this browser's localStorage · Direct Gemini REST calls (chat, image generation, voice transcription) · Computer control disabled.</p></div><div class="card" style="margin-top:12px"><b>Export / Reset</b><p>Your conversations, memory, projects and files live only in this browser.</p><button class="action" onclick="exportData()">Export data (.json)</button> <button class="action danger" onclick="resetData()">Erase all local data</button></div></div>`;
}
function exportData() {
  const blob = new Blob([JSON.stringify({ conversations, memories, projects, files, images }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "optimus-export.json"; a.click();
}
function resetData() {
  if (!confirm("This deletes all conversations, memory, projects, files and images stored in this browser. Continue?")) return;
  ["optimus_conversations", "optimus_memories", "optimus_projects", "optimus_files", "optimus_images"].forEach(k => localStorage.removeItem(k));
  conversations = []; memories = []; projects = []; files = []; images = []; conversationId = null;
  notify("Local data erased"); page("home");
}

document.getElementById("modelPill").textContent = "● " + state.model;
page("home");
