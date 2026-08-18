# wolfeintelligence.com

The live site. Plain static HTML plus Vercel serverless functions — no build
step, no bundler, no framework CLI. Edit a file, push, it deploys.

```
index.html       landing page
portal.html      the portal — one sign-in for everyone. Clients: Home (enquiries,
                 Google setup) and Results (funnel by source). Owner: the console.
os.js + os.css   the owner console (Wolfe OS), embedded in the portal page for an
                 owner session; os.html only redirects to /portal
lead-status.html one-tap outcome page opened from the new-enquiry email
favicon.svg      the W mark
robots.txt       crawl rules
sitemap.xml      submitted to Search Console
assets/          fonts, images, the social card, and the vendored runtime + React
api/             serverless functions (auth, chat, provisioning)
lib/             shared helpers — NOT routes (see below)
vercel.json      security headers, caching, clean URLs
```

## Deploying

Repo `WolfeIntelligence/consulting-site`, branch `main`. Every push redeploys.

```bash
git add . && git commit -m "..." && git push
```

## Environment variables

Vercel → Project → Settings → Environment Variables.

| Variable | Effect if missing |
| --- | --- |
| `OWNER_CODE` | Portal sign-in returns 503; **nobody can get in** (fails closed). |
| `SESSION_SECRET` | Same as above. Any long random string. |
| `OWNER_EMAIL` | Defaults to `zachary@wolfeintelligence.com`. |
| `CLIENT_ACCOUNTS` | Optional quick client list: `a@b.com:code1,c@d.com:code2`. |
| `ANTHROPIC_API_KEY` | Site Guide falls back to its scripted answer set. |
| `CHAT_MODEL` | Defaults to `claude-haiku-4-5`. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Portal provisioning reports "storage not configured", and rate limits fall back to per-instance memory. Add Upstash Redis from the Vercel Marketplace to set both automatically. |
| `RESEND_API_KEY` | New-enquiry emails are not sent (leads are still stored). The console's Leads tab shows a warning while this is unset. |
| `LEAD_FROM` | Sender for those emails. Defaults to `Wolfe Intelligence <leads@wolfeintelligence.com>`; the domain must be verified in Resend. |
| `PUBLIC_BASE` | Base URL used in email links. Defaults to `https://www.wolfeintelligence.com`. |

## The lead pipeline

```
client's site  --beacon-->  /api/visit  (public; counts per client/day/source bucket; no PII)
client's site  --POST-->    /api/lead   (public; client must exist; honeypot + dwell check; rate limited)
                              |  stores the lead with gclid/gbraid/wbraid, UTM, landing, referrer,
                              |  SMS consent, hashed email/phone (enhanced conversions), repeat flag
                              |  emails client + owner via Resend with signed one-tap links;
                              |  auto-replies to the lead if they left an email
                              v
   /lead-status?t=…&set=contacted|booked|won|lost  ->  GET shows it, POST records it
   /portal   client sees enquiries (uncontacted first, with age), taps outcomes, logs calls
   /portal   owner: the console — Client (intake facts, routing verdict, packet, remove),
             Progress (the 15 steps the client sees + launch checks), Leads (funnel by
             source, median time to call back, per-lead controls, Ads export)
```

Outcome timestamps (`contactedAt`, `bookedAt`, `wonAt`) are stamped once,
server-side; `contactedAt` is the speed-to-lead clock and `bookedAt`/`wonAt`
feed the export's Conversion Time. A client token can only change outcome
fields on its own leads; capture fields are evidence and never editable by the
client. `node tests/run.js` covers all of it against a mocked KV and Resend.

Phone normalisation assumes US numbers (+1). Make it per-client the day a
client is not.

## Things that will bite you

**Every `.js` file in `api/` becomes a public endpoint.** Shared helpers go in
`lib/`, which Vercel bundles by dependency tracing. A helper left in `api/`
ships as a route that 500s on any request.

**The booking calendar is pop-out only.** No iframe — the CTA opens Google
Calendar in a new tab. That is why the CSP sets `frame-src 'none'`; if an embed
is ever reintroduced, that directive has to allow `calendar.app.google` again or
the frame will be blocked.

**`www` is the canonical host** and the apex 308s to it. Canonical tags, `og:url`
and the sitemap must all use `www.wolfeintelligence.com` — pointing them at a
URL that redirects defeats the purpose.

**Assets are cached for a year as immutable.** If you change the *contents* of
anything in `assets/`, rename the file too. Browsers that already have the old
one will not re-fetch it otherwise.

**The CSP allows `'unsafe-eval'`.** The page runtime evaluates the component
logic class as a string, so the site renders blank without it. Everything else
is locked down — no external scripts, no external fonts, frames limited to the
Google Calendar booking widget. If the render path ever stops needing `eval`,
drop it from `vercel.json`.

**React is served from `assets/`, not a CDN.** `assets/resources.js` maps the
runtime's hardcoded unpkg.com URLs to local copies. Delete that file and the
site silently starts loading React from a third party — which breaks the CSP,
adds an outage dependency, and leaks visitor IPs to unpkg.

**The portal fails closed.** Any response from `/api/login` other than a signed
token keeps the gate shut. `?tour=1` is the only credential-free way in; it
shows a labelled sample client (the data lives only in `tourData()` in
portal.html), carries no token, and cannot reach `/api/apps`. It is safe to send
to a prospect.

**The console is the portal's owner view.** `os.js` renders into `#app`, which
sits *outside* the runtime root on purpose — the page runtime re-renders its
own tree and would wipe the console. The portal hands the owner session over
via `window.__wolfeOs` and the `wolfe-os-session` / `wolfe-os-signout` events;
the console fires `wolfe-os-expired` when its token dies. `os.css` is scoped to
`#app` so it cannot touch the portal's own styles. Portal access codes for
clients are set from the console (client header → "Give portal access").

## Rate limits

`lib/ratelimit.js` counts per IP, backed by Upstash when configured and by
per-instance memory otherwise.

- `/api/chat` — 15 messages per 10 min, 60 per day
- `/api/login` — 10 attempts per 15 min

Both also reject browser requests whose `Origin` is not this site.

## Still worth doing

- `assets/newsreader.woff2` is 123 KB, the largest asset. It is a variable font
  covering weights 400–600; splitting it into static instances would save
  roughly 30 KB, at the cost of an extra request.
- Confirm `support@wolfeintelligence.com` is a live, monitored inbox — the Site
  Guide sends people there whenever it refuses a question.
