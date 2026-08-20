# wolfeintelligence.com

The live site. Plain static HTML plus Vercel serverless functions — no build
step, no bundler, no framework CLI. Edit a file, push, it deploys.

```
index.html       landing page
portal.html      the portal — one sign-in for everyone. Clients: Home (inquiries,
                 Google setup) and Results (funnel by source). Owner: the console.
os.js + os.css   the owner console (Wolfe OS), embedded in the portal page for an
                 owner session; os.html only redirects to /portal
lead-status.html one-tap outcome page opened from the new-inquiry email
favicon.svg      the W mark
robots.txt       crawl rules
sitemap.xml      submitted to Search Console
assets/          fonts, images, the social card, and the vendored runtime + React
ws.js + ws.css   the workspace browser — the client-facing view of the graph
api/             serverless functions (auth, chat, provisioning, the graph)
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
| `CHAT_MODEL` | Defaults to `claude-sonnet-5` (thinking off, low effort, 350-token cap); falls back to `claude-opus-5`, then `claude-haiku-4-5`, on overload or error. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Portal provisioning reports "storage not configured", and rate limits fall back to per-instance memory. Add Upstash Redis from the Vercel Marketplace to set both automatically. |
| `RESEND_API_KEY` | New-inquiry emails are not sent (leads are still stored). The console's Leads tab shows a warning while this is unset. |
| `LEAD_FROM` | Sender for those emails. Defaults to `Wolfe Intelligence <leads@wolfeintelligence.com>`; the domain must be verified in Resend. |
| `PUBLIC_BASE` | Base URL used in email links. Defaults to `https://www.wolfeintelligence.com`. |

## Engagement types (the console)

One client record carries one engagement. The type — set when the client is
added, changeable on the Client tab — decides the intake fields, the routing
gates, the step list the client's portal renders, and the launch checks. All
three are deterministic; nothing calls a model.

| Type | Intake asks | Route decided by | Steps |
| --- | --- | --- | --- |
| `google` — Get found and measured | shape, coverage, the five gates (capacity, verified, signage, reviews, insurance), budget, site | the gates, in order; LSA vs. website+search ads | 15, incl. the Google-owned verification wait |
| `ai` — Private AI assistant | the five jobs, owner who checks answers, one metric + baseline, where the knowledge lives and its shape, where it runs, data sensitivity, must-nevers, review level, owner's hours | knowledge in heads → capture first; no metric → name it first; else build local or in-account | 13, ending in a scored acceptance test and a two-week review |
| `automation` — one process | trigger, steps today, tools, customer-facing?, seven suitability scores (frequency, rules, inputs, stability, error cost, access, exceptions), owner, review level, baseline | average score: ≥4 build now, 3–4 pilot reviewed 30 days, 2–3 fix the process first, <2 do not build | 11, reviewed before unattended, re-measured at the end |

The AI and automation intakes follow published readiness practice rather than
house opinion. Automation suitability scoring on rule clarity, volume, input
structure, stability, error cost and system access is the common core of the
RPA-selection literature and the practitioner scorecards
([Forge RPA](https://forgerpa.com/blog/automation-assessment-framework/),
[NextPage](https://nextpageit.com/blog/rpa-readiness-assessment),
[Nordflux](https://nordflux.de/en/guides/rpa-process-selection-criteria-catalog-for-automatable-processes),
[Bédard 2024](https://onlinelibrary.wiley.com/doi/10.1002/smr.2709)); the
thresholds are Forge's. AI readiness — a describable workflow, accessible
data, one named human owner, and a metric with a baseline before anything is
built, starting with a narrow pilot — is the shared shape of the small-business
readiness checklists ([Infinity Sky](https://infinitysky.ai/blog/ai-readiness-assessment-small-business-2026),
[Progressive Robot](https://www.progressiverobot.com/2026/05/10/ai-readiness-assessment/),
[200OK](https://www.200oksolutions.com/blog/ai-readiness-assessment-framework-2026/)).
The acceptance-test step for private assistants — real questions with known
answers, scored not eyeballed — is standard RAG evaluation practice
([Evidently](https://www.evidentlyai.com/llm-guide/rag-evaluation)). Local
hardware guidance in the AI blocker (a recent machine with a proper graphics
card; roughly 16 GB RAM minimum) follows the 2026 local-LLM hardware guides.

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
   /portal   client sees inquiries (uncontacted first, with age), taps outcomes, logs calls
   /portal   owner: the console — Client (intake facts, routing verdict, packet, remove),
             Progress (the 15 steps the client sees + launch checks), Leads (funnel by
             source, median time to call back, per-lead controls, Ads export)
```

Outcome timestamps (`contactedAt`, `bookedAt`, `wonAt`) are stamped once,
server-side; `contactedAt` is the speed-to-lead clock and `bookedAt`/`wonAt`
feed the export's Conversion Time. A client token can only change outcome
fields on its own leads; capture fields are evidence and never editable by the
client. `node tests/run.js` covers all of it against a mocked KV and Resend.

Phone normalization assumes US numbers (+1). Make it per-client the day a
client is not.

## Client workspaces (the object graph)

Every client business gets a workspace: its own object types, its own records,
its own documents, its own people. The shape of a business is stored as data,
not written out in code — which is the whole point, because `os.js` currently
carries three complete copies of one idea (a phase list, a field list, routing
logic, blockers and a packet template, written once for Google engagements,
once for private AI and once for automation) and a fourth engagement type would
mean a fourth copy.

```
lib/kv.js         Redis primitives — POST-body commands and pipelining
lib/digest.js     canonical JSON and stable hashes
lib/tenancy.js    workspaces, membership, which workspace a session may see
lib/authority.js  the capability table — the ONLY copy of it
lib/types.js      the 18 property types: coerce, validate, format
lib/schema.js     the metamodel: types, links, the closed rule registry, compile
lib/ontology.js   records, links, history, referential integrity
lib/actions.js    governed write-back
lib/receipts.js   idempotency
lib/audit.js      the append-only trail
lib/files.js      documents
lib/templates.js  the seed schemas
lib/migrate.js    keeping the graph in step with the older records
api/graph.js      one route, 24 operations
```

`node tests/graph.js` covers this layer against `tests/kvmock.js`, an in-memory
Redis that speaks both REST shapes the codebase uses.

### Things that will bite you here

**The capability table lives in `lib/authority.js` and nowhere else.** There was
briefly a second copy in `lib/tenancy.js`. Two copies of one policy table start
out agreeing and quietly stop.

**Authority has four states, not two.** Allowed, approval-required, forbidden,
and unclassified. A capability with no row for a role resolves to
*unclassified*, which refuses — it does not fall through to allowed. Adding an
operation to `api/graph.js` without adding it to the table means it does not
work, on purpose.

**Every op in `OPS` must have a `case` in the dispatch switch, and vice versa.**
A command with no control and a control with no command are both invisible to
typechecking. There is a parity check for this; run it if you add an operation.

**A workspace you are not a member of returns 404, not 403.** On a public URL a
403 confirms the workspace exists. Do not "fix" this.

**Isolation is the key layout, not a filter.** Every key is addressed under a
workspace id, so there is no "all records" key to accidentally read from. Do not
add one.

**Objects are archived, never deleted**, and a record something links to cannot
even be archived until the link is removed. The refusal names what points at it.

**Writes carry the revision they read.** A mismatch is refused as stale rather
than silently overwriting whoever saved first.

**The rule registry in `lib/schema.js` is closed.** Six rules, and adding one is
a deliberate edit. A free-text condition would let someone write a rule that
quietly does nothing and never find out. A stored rule this build cannot read
*refuses* rather than passes — dropping a check the client believes is
protecting them is the worse failure.

**Checks compile with their wording frozen.** Renaming a property later must not
change what an older refusal claimed happened.

**The audit trail has no update or delete function.** Not by policy — there is
no such method to call. Entries are written after something has happened; there
is no "about to" event.

**Documents are capped at 400 KB and stored beside the record.** That covers
PDFs, spreadsheets and exports. Phone photos (2–5 MB) do not fit. Large-file
storage needs a blob store created on the hosting account; `lib/files.js`
detects `BLOB_READ_WRITE_TOKEN` and refuses clearly until the backend is wired,
rather than guessing at an unofficial upload endpoint.

**`lib/migrate.js` is not a migration you run.** It is the sync that keeps the
graph in step with the old records, and it is called from the places a client
comes into being rather than from a button: `api/apps.js` on provision, on an
engagement save and on a lead being logged; `api/lead.js` when a lead arrives;
`api/graph.js` when the operator lists workspaces, and when a client lists an
empty one. `ensureFor(email)` is the whole surface — after it returns, that
client has a workspace, is its admin, and their inquiries are in it.

It never writes the old keys: `leads`, `onboarding` and `deployments` are read
only. It is re-runnable — `ws:<id>:legacy` maps each old lead id to the object
it became, so a second pass skips it — and a value the new type will not accept
costs that field, not the whole record.

Two things to keep true. Every call site goes through `quietly()`, so a storage
failure in the graph can never be the reason a lead is lost — the lead is stored
first and the next pass picks up what did not finish. And `backfill` only
re-reads already-carried records when `refresh` is set, which is one call site:
the console recording an outcome. Turning that on everywhere would put a read
per inquiry on every portal load.

**The storage substrate is deliberately provisional.** Per-record keys with set
indexes, on the Redis already provisioned. Honest for one to a few dozen
clients; it cannot do ad-hoc queries or multi-key transactions. `lib/kv.js` is
the seam if that changes.


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

## Site Guide (the homepage chat)

`api/chat.js` answers only from a fixed fact list in its system prompt. Every
visitor turn is wrapped in `<visitor>` tags and a reminder rides on the last
turn, so instructions inside a message are content, not commands; the reply is
filtered on the way out (no links, no markdown, hard length cap) and the widget
adds the one relevant action itself (book, sample portal, email). A refusal, a
timeout, or an upstream error falls back to the widget's fixed answers and the
header says so. After ~75 s of visible time the launcher glows once and offers
help (`?guide=now` previews it); the offer is remembered per browser session.

## Ad spend (the console)

The Leads tab carries a month-by-month spend table — Google Ads and Local
Services — saved on the client record (`spend`, whitelisted in `api/apps.js`)
and shown against the leads each channel bought, with cost per inquiry, per
booked estimate and per customer. The client's Results page shows the same
cost per customer. This replaces the lead tracker spreadsheet.

## Rate limits

`lib/ratelimit.js` counts per IP, backed by Upstash when configured and by
per-instance memory otherwise.

- `/api/chat` — 15 messages per 10 min, 60 per day per IP, and 1,500 per day across the whole site
- `/api/login` — 10 attempts per 15 min

Both also reject browser requests whose `Origin` is not this site.

## Still worth doing

- `assets/newsreader.woff2` is 123 KB, the largest asset. It is a variable font
  covering weights 400–600; splitting it into static instances would save
  roughly 30 KB, at the cost of an extra request.
- Confirm `support@wolfeintelligence.com` is a live, monitored inbox — the Site
  Guide sends people there whenever it refuses a question.
