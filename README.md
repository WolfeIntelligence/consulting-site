[README.md](https://github.com/user-attachments/files/31104604/README.md)
# Deploy to Vercel

This folder is a complete static site. `index.html` is fully self-contained — no build step, no dependencies.

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

## Option 3 — Git (best for ongoing updates)

1. Push this folder to a GitHub repo.
2. On vercel.com → **Add New → Project** → import the repo.
3. Framework preset: **Other**. Root directory: `deploy` (or repo root if you push only this folder). No build command, output directory `.`.
4. Every push to `main` redeploys automatically.

## Custom domain

Vercel dashboard → your project → **Settings → Domains** → add `wolfeintelligence.com`, then point your registrar's nameservers or add the A/CNAME records Vercel shows.

## Updating the site

Edit the design in this project, then re-export a fresh `index.html` and re-deploy (drag-drop again, or `vercel --prod`, or push to Git).

## Before you go live

- Replace the three image placeholders (advisor portrait, workspace shot, portal dashboard).
- Swap the placeholder testimonials for real ones.
- Point the "Book a free consult" buttons at your real scheduler (Cal.com, Calendly, etc.).
- Confirm `hello@wolfeintelligence.com` is a live inbox.
