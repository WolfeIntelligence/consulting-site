# Site expansion brief — patent & IP workflow services
**From the main session, 2026-08-31. Zach's instruction: add patent workflows to the site while keeping everything that exists.**

## What Zach said
"Start adjusting or planning to adjust the site to reflect patent workflows as well as the old stuff. I don't mind keeping things for other firms and for trades. That's totally fine to me. I just wanna make sure that we start including the patent stuff."

## The new capability, stated truthfully
Zach has a physics degree and expertise across physics **and electrical engineering**, and years of professional experience reading and classifying patents at high volume. His technical domains — use these to make the copy specific instead of generic:
- Measurement and instrumentation
- Solid state physics and **semiconductors**
- Power systems
- Lighting
- Cameras / imaging and optics

The offering to frame: **AI document workflows for IP professionals** — prior-art search support, patent classification and landscape analysis, claim charting, and document pipelines — for patent attorneys, patent agents, small IP boutiques, and in-house IP teams, strongest in the electrical/physics arts above. A generalist "AI for law firms" pitch already failed an audit; a "physics/EE person who has classified thousands of patents and builds AI document pipelines" pitch is specific, true, and rare.

## Hard limits on claims (non-negotiable)
1. Zach is **NOT** a registered patent agent or attorney. No claims of USPTO representation, patent prosecution, legal advice, or patentability *opinions*. Search, analysis, classification, and workflow automation only. (He may sit the patent bar later — the site says nothing about that until it happens.)
2. **Do not name his employer or describe his day job specifically.** "Years of professional patent analysis and classification experience" is the ceiling. No company names, no client names.
3. **DEPLOY GATE: do not push any patent-services copy live until Zach confirms he has checked his employment agreement** for moonlighting/conflict clauses. Draft, stage, and preview freely. As of this brief he has NOT confirmed.

## Standing rules that carry over (do not relearn these the hard way)
- **No visible pricing anywhere a visitor can reach** — pages, meta tags, JSON-LD, chat fallbacks, everything.
- American spelling. Plain voice — no consultant maxims, no "leverage/unlock/empower."
- No Claude/AI attribution anywhere.
- Assets are cached immutable: any changed asset gets a new filename.
- Do not undo the entity work: "Zachary Wolfe" in visible copy, schema @id, `sameAs` LinkedIn, Lakeland FL locality, author meta. The patent/physics positioning *helps* the Matt Wolfe disambiguation (his LinkedIn already indexes as "Physicist and IP Specialist") — lean into it in schema (`knowsAbout`: patent analysis, prior art search, semiconductors, electrical engineering...) once copy is staged.
- Site Guide / chat facts (api/chat.js) must be updated in the same change as the page, so the widget and the page never disagree.
- Remote-first delivery framing throughout; no in-person default.

## Suggested shape (site agent's call on final design)
- A third audience lane alongside trades and professional firms: "IP & patent teams" or similar — services grid entry, a short section, FAQ additions, schema updates.
- Keep the existing hero and structure unless a better idea survives the existing copy standards (burstiness ≥ ~0.55, no kicker-ending every card).
