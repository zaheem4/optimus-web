# OPTIMUS — static build (GitHub Pages ready)

This is a **backend-free** version of OPTIMUS. It's three files — `index.html`,
`styles.css`, `app.js` — with no build step, no server, and no database.
It calls Google's Gemini API **directly from your browser** and stores your
chats, memory, projects and files in this browser's `localStorage`.

This is what you deploy to GitHub Pages, since Pages only serves static
files and can't run the Python/FastAPI backend from the original project.

## Deploy to GitHub Pages (free)

1. Create a new GitHub repo (or use an existing one) and push these 3 files
   to it, e.g. at the repo root.
2. On GitHub: **Settings → Pages → Build and deployment → Source: "Deploy
   from a branch"**, branch `main`, folder `/ (root)` → **Save**.
3. Wait ~1 minute, then open the URL GitHub shows you
   (`https://<your-username>.github.io/<repo-name>/`).
4. In the app, go to **Settings**, paste a Gemini API key from
   [Google AI Studio](https://aistudio.google.com/apikey), and start chatting.

That's it — no server to run or pay for.

## What's different from the backend version

- No shared database — everything is per-browser (`localStorage`). Clearing
  browser data or switching devices loses your history. Use **Settings →
  Export data** to back it up as a `.json` file.
- Your API key is sent only to `generativelanguage.googleapis.com`, straight
  from your browser. It is **not** hidden from anyone using the same browser
  profile — don't use this build on a shared/public computer.
- PDF and DOCX text extraction now happens in-browser (via pdf.js and
  mammoth.js, loaded from cdnjs on first use) instead of on a Python server.
- There's no rate limiting, audit log, or multi-user support, since there's
  no server to enforce any of that. This build is meant for personal,
  single-user use.

## Want the full backend version instead?

The original FastAPI + SQLite backend (with server-side rate limiting, audit
log, and multi-format file parsing) is still the better choice if you want
a shared/multi-device deployment. GitHub Pages can't run it, but free tiers
on Render, Fly.io, or Hugging Face Spaces can — see the main project's
README for a one-click-ish path.
