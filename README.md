# Deploy to Vercel

This folder is a complete site: static pages (`index.html`, `portal.html`) plus serverless functions in `api/` (auth, deploys, chatbot). No build step.

## Environment variables (Vercel → Project → Settings → Environment Variables)

Auth (portal login):
- `OWNER_CODE` — your access code. Owner login = zachary@wolfeintelligence.com + this code. **Required for real auth**; without it the portal runs in preview mode.
- `SESSION_SECRET` — any long random string (signs login tokens).
- `OWNER_EMAIL` — optional, defaults to zachary@wolfeintelligence.com.
- `CLIENT_ACCOUNTS` — optional quick client list: `a@b.com:code1,c@d.com:code2`.

Deploys & provisioning from the portal (owner-only "Deploy to a customer"):
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — add Upstash Redis from the Vercel Marketplace (Storage tab); these are set automatically. Without them, deploys report "storage not configured".

Chatbot (Site Guide goes from scripted to live model):
- `ANTHROPIC_API_KEY` — your Anthropic key. Stays server-side; the site only calls `/api/chat`.
- `CHAT_MODEL` — optional, defaults to `claude-3-5-haiku-latest`.

## Option 1 — Drag & drop (fastest)

1. Go to https://vercel.com/new
2. Drag this whole `deploy` folder onto the page.
3. Vercel detects "Other / static" — just click **Deploy**.

Live in ~20 seconds at `your-project.vercel.app`.

## Option 2 — Vercel CLI

```bash
npm i -g vercel
cd deploy
vercel          # preview deploy
vercel --prod   # production
```

## Option 3 — Git (best for ongoing updates) ← current setup

Repo: `WolfeIntelligence/consulting-site` (branch `main`).

First push (repo is empty) — easiest without a terminal:
1. Go to https://github.com/WolfeIntelligence/consulting-site
2. Click **uploading an existing file** (or Add file → Upload files).
3. Drag in `index.html`, `portal.html`, `vercel.json`, `README.md`, and the `api` folder → **Commit**.

Or with git:
```bash
cd deploy
git init && git add . && git commit -m "Initial site"
git branch -M main
git remote add origin https://github.com/WolfeIntelligence/consulting-site.git
git push -u origin main
```

Then on vercel.com → **Add New → Project** → import the repo. Framework preset: **Other**, no build command, output directory `.`. Every push to `main` redeploys automatically — after any design update here, download the fresh `deploy` folder and repeat the upload.

## Custom domain

Vercel dashboard → your project → **Settings → Domains** → add `wolfeintelligence.com`, then point your registrar's nameservers or add the A/CNAME records Vercel shows.

## Updating the site

Edit the design in this project, then re-export a fresh `index.html` and re-deploy (drag-drop again, or `vercel --prod`, or push to Git).

## Before you go live

- Replace the workspace/product imagery as real screenshots become available.
- Set the env vars above — until then: portal opens in preview mode, deploys don't persist, and the chatbot answers from its fixed script.
- Confirm `hello@wolfeintelligence.com` is a live inbox.
