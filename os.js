/* Wolfe OS — owner console.
 *
 * Deterministic throughout: the routing gates, the progress steps and the audit
 * are plain logic, not a model. Records live in Vercel KV behind the existing
 * owner token, so the console works from any machine and the client's portal
 * reflects it without an export step.
 *
 * The page CSP forbids inline script, which is why this is a separate file.
 */
(function () {
  'use strict';

  var S = { authed: false, email: '', token: '', clients: [], sel: null, tab: 'intake',
            emailDraft: '', codeDraft: '', err: '', busy: false, saveError: '',
            adding: false, newEmail: '', newName: '' };

  /* ------------------------------------------------------------ helpers */
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(m) {
    var d = el('div', 'toast', m);
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 2600);
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function cur() {
    for (var i = 0; i < S.clients.length; i++) if (S.clients[i].email === S.sel) return S.clients[i];
    return null;
  }

  /* -------------------------------------------------------------- model */
  // Fourth field is whose turn the step is. Google binds five actions to the
  // business owner and nobody else can do them, so the client's portal can say
  // plainly when it is waiting on them rather than leaving them guessing.
  var PHASES = [
    ['intake', 'Intake complete', 'Facts gathered by conversation, not a form', 'wolfe'],
    ['account', 'Google account created or confirmed', '', 'you'],
    ['twofa', '2-Step Verification on, backup codes saved offline', 'The whole continuity plan for a solo operator', 'you'],
    ['search', 'Searched Google and Maps for an existing listing', 'Before creating anything', 'wolfe'],
    ['profile', 'Profile created or claimed', 'A claim inherits old settings — re-check them', 'wolfe'],
    ['verifySub', 'Verification video recorded', 'Filmed live, one take, name on something permanent', 'you'],
    ['verifyPass', 'Verification approved by Google', 'Days, sometimes weeks. Silence is normal', 'google'],
    ['manager', 'Wolfe added as Manager', 'Never Owner', 'you'],
    ['reviews', 'Review drive started', 'Free, and usually beats early ad spend', 'you'],
    ['photos', 'Real photos added', '', 'you'],
    ['booking', 'Booking page live', '', 'wolfe'],
    ['bookLink', 'Booking link added to the profile', 'Only possible after verification', 'wolfe'],
    ['adsAcct', 'Advertising account set up', 'Route decided first', 'wolfe'],
    ['testLead', 'Test lead booked end to end, then deleted', 'The only step that proves the funnel works', 'wolfe'],
    ['handoff', 'Handoff sent', '', 'wolfe']
  ];

  var AUDIT = [
    ['id', 'Google identity', 'Signs in unaided, 2FA on, recovery details their own'],
    ['recovery', 'Recovery survivable', 'Backup codes saved offline'],
    ['owner', 'Ownership', 'Client is Primary Owner, Wolfe is Manager'],
    ['accuracy', 'Profile accuracy', 'Name, category, service area, hours'],
    ['address', 'Address exposure', 'Checked SIGNED OUT. A claimed profile inherits old settings'],
    ['verified', 'Verified and publicly visible', ''],
    ['reviewsA', 'Reviews and photos', 'Nothing incentivized — Google prohibits it'],
    ['route', 'Advertising route matches the gates', ''],
    ['adsState', 'Nothing spending that nobody designed', ''],
    ['bookingA', 'Booking page correct', 'Fields, buffers, honest hours'],
    ['reach', 'Booking reachable from the profile', 'Record the hops'],
    ['hours', 'Hours and availability differences are deliberate', "Ask, don't assume"],
    ['reminders', 'A reminder route is in place', ''],
    ['test', 'TEST LEAD passes end to end', 'Everything above can be green while this fails']
  ];

  var FIELDS = [
    ['Business', [
      ['businessName', 'Exact business name', 'text', 'What is on the truck'],
      ['phone', 'Public phone', 'text', ''],
      ['website', 'Website', 'text', 'Leave blank if none'],
      ['whatTheyDo', 'What they actually do', 'textarea', 'In their words']
    ]],
    ['Shape and coverage', [
      ['businessType', 'Business shape', 'select:field_service=Field service (drives to customers)|storefront=Storefront|remote=Remote', 'Decides which checks apply at all'],
      ['baseAddress', 'Base address', 'text', 'Needed for verification even when hidden'],
      ['serviceArea', 'Service area', 'text', 'Where the last ten jobs actually were'],
      ['hours', 'Hours they will really answer', 'text', '']
    ]],
    ['Gates', [
      ['capacity', 'Room for more work', 'select:=—|room=Real room|seasonal=Seasonal gaps|full=Full or nearly full', 'Ask first'],
      ['verified', 'Profile verified', 'select:=—|yes=Verified|no=Not yet|exists=Unclaimed listing exists', ''],
      ['signage', 'Name on something permanent', 'select:=—|yes=Yes|no=No|unsure=Unknown', 'Gates the verification video'],
      ['reviewsCount', 'Google reviews today', 'select:=—|none=Under 5|some=5 to 19|many=20 or more', ''],
      ['insurance', 'Liability insurance + background check', 'select:=—|yes=Yes|no=No|unsure=Need to check', 'Gates Local Services Ads'],
      ['budget', 'Monthly ad budget', 'select:=—|none=Nothing yet|low=Under $300|mid=$300 to $800|high=Over $800', 'Separate from your fee'],
      ['site', 'Website status', 'select:=—|none=None|social=Facebook only|real=Real site', ''],
      ['workType', 'Work they want more of', 'select:=—|recurring=Recurring contracts|oneoff=One-off jobs|both=Both', '']
    ]],
    ['Decisions to settle before the session', [
      ['category', 'Primary category', 'text', 'What they mainly do, not what sounds best'],
      ['secondary', 'Secondary categories', 'text', ''],
      ['description', 'Profile description', 'textarea', '750 characters. You write it; read it back for a factual check']
    ]],
    ['Accounts and booking', [
      ['googleAccount', 'Google account', 'text', ''],
      ['existingListing', 'Existing listing found', 'text', 'Leave blank if none'],
      ['paidPlan', 'Paid Google plan', 'text', 'Blank = free tier, so no booking reminders'],
      ['bookingTitle', 'Booking page title', 'text', 'Customer-facing'],
      ['apptMin', 'Appointment minutes', 'text', ''],
      ['bufferMin', 'Buffer minutes', 'text', ''],
      ['bookingFields', 'Booking questions', 'text', 'Worded for the trade']
    ]]
  ];

  /* ------------------------------------------------- routing (the gates) */
  function blockers(a) {
    var b = [];
    if (a.verified === 'no' && a.signage === 'no')
      b.push('No permanent signage — verification will fail until they get a truck sign or similar.');
    if (a.verified === 'no' && a.signage === 'unsure')
      b.push('Signage unconfirmed. Ask before booking the session; it is the commonest verification failure.');
    if (a.verified === 'exists')
      b.push('A listing already exists — claim it, never create a second. A claim inherits the old settings, so re-check service area and address exposure afterwards.');
    if (a.insurance === 'unsure' && (a.budget === 'mid' || a.budget === 'high'))
      b.push('LSA eligibility unconfirmed. Get the insurance answer before promising a channel.');
    if (a.businessType === 'remote' && a.serviceArea)
      b.push('Remote business with a service area filled in — remote work has no geography to claim.');
    return b;
  }

  function decide(a) {
    var answered = ['capacity', 'verified', 'reviewsCount', 'insurance', 'budget'].some(function (k) { return a[k]; });
    if (!answered) return { kind: 'none', badge: 'Awaiting intake', title: 'Start with capacity',
      lead: 'The first gate can end the conversation, so answer it before anything else.', deliver: [], next: [] };

    if (a.capacity === 'full') return { kind: 'stop', badge: 'Do not sell ads', title: 'Foundation and pricing only',
      lead: 'A full route means paid leads get turned away or stretch their drive time. Advertising here damages the engagement.',
      deliver: ['<strong>Profile and reviews</strong> so the leads they do get are better',
                '<strong>Pricing and route review</strong> — replacing low-value customers beats adding volume',
                '<strong>Booking page</strong> so enquiries stop getting lost while they work'],
      next: ['Revisit advertising when they add capacity or raise prices enough to free some.'] };

    if (a.verified === 'no' || a.verified === 'exists') return { kind: 'found', badge: 'Phase zero', title: 'Get verified first',
      lead: 'Nothing paid starts before the listing is approved. Verification takes days and sometimes weeks.',
      deliver: ['<strong>Profile ' + (a.verified === 'exists' ? 'claim' : 'creation') + '</strong> and verification, video prep included',
                '<strong>Booking page</strong>, and the link on the profile once approved',
                '<strong>Lead log</strong> from the first enquiry, to build a pre-spend baseline'],
      next: ['Re-check this once Google approves — the channel answer may change.'] };

    if (a.reviewsCount === 'none') return { kind: 'found', badge: 'Foundation first', title: 'Reviews before advertising',
      lead: 'Under five reviews, paid clicks land on a profile that gives nobody a reason to choose them. On Local Services Ads the review score shows on the ad itself.',
      deliver: ['<strong>Review drive</strong> across the existing customer base',
                '<strong>Photos</strong> of real finished work',
                '<strong>Four to six weeks of baseline</strong> in the lead log with zero spend'],
      next: ['That baseline is what later proves the ads did something rather than the season doing it.'] };

    if (a.budget === 'none' || a.budget === 'low') return { kind: 'found', badge: 'Organic only', title: 'Profile, reviews and booking',
      lead: "Below roughly $300 a month there isn't enough spend to gather signal, and the fee eats the budget.",
      deliver: ['<strong>Profile optimization</strong> and ongoing review collection',
                '<strong>Booking page</strong> linked directly on the profile',
                '<strong>Monthly reporting</strong> from the lead log'],
      next: ['Revisit paid channels once they will commit real monthly spend.'] };

    var wantsSite = a.site === 'none' || a.site === 'social';
    if (a.insurance === 'yes') return { kind: 'lsa', badge: 'Recommended',
      title: 'Local Services Ads management' + (wantsSite ? ' + simple site' : ''),
      lead: 'They clear the gate, so LSA is the better first channel: charged per lead, leads arrive already attributed, junk is disputable.' +
            (wantsSite ? " A simple site is worth adding — LSA doesn't need one, but it is where tracking becomes possible later." : ''),
      deliver: ['<strong>LSA setup</strong> — background check, insurance, license verification',
                '<strong>Lead management</strong> in the LSA inbox, marking booked and won',
                wantsSite ? '<strong>Simple site</strong> with an enquiry form, capturing the GCLID from day one'
                          : '<strong>Tracking on their existing site</strong>, capturing the GCLID from day one',
                '<strong>Lead log</strong> as the source of truth for cost per recurring customer'],
      next: ['Capture the GCLID from day one — it cannot be recovered retroactively.',
             a.workType === 'oneoff'
               ? 'They want one-off work, so watch cost per lead closely — a one-off job absorbs far less acquisition cost.'
               : 'Track recurring and one-off separately or the averages will flatter the result.'] };

    return { kind: 'site', badge: a.insurance === 'no' ? 'LSA unavailable' : 'Pending LSA answer',
      title: 'Website build plus search ads',
      lead: (a.insurance === 'no'
          ? 'Without insurance or a background check LSA is off the table, so search ads are the route. '
          : 'Until the insurance answer is confirmed, plan for search ads. ') +
        'That makes the site mandatory rather than optional — it is the only place a conversion can be measured.',
      deliver: ['<strong>Site build</strong> with an enquiry form as the primary call to action',
                '<strong>Conversion tracking</strong> on form submission, plus GCLID capture',
                '<strong>Search campaigns</strong> geo-fenced tightly around their existing route',
                '<strong>Lead log</strong> reconciling spend against customers won'],
      next: ['Make the form the main call to action. A booking link straight to Google Calendar cannot be tracked.',
             'Hold off on uploading offline conversions until volume justifies it. Capture the GCLIDs now regardless.'] };
  }

  /* ----------------------------------------------------------- transport */
  function api(method, body) {
    var opt = { method: method, headers: { authorization: 'Bearer ' + S.token } };
    if (body) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch('/api/apps', opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('http-' + r.status));
        return d;
      });
    });
  }

  function loadClients() {
    return api('GET').then(function (d) {
      S.clients = (d.onboarding || []).map(function (o) {
        o.intake = o.intake || {};
        o.phaseState = o.phaseState || {};
        o.audit = o.audit || {};
        // Steps are the client-facing projection; rebuild local state from them.
        (o.steps || []).forEach(function (s, i) {
          var key = PHASES[i] && PHASES[i][0];
          if (key) o.phaseState[key] = { done: !!s.done, date: s.date || '' };
        });
        return o;
      });
      render();
    });
  }

  /* Persist a client. `steps` is what the client's portal renders, so it is
     built here from the same phase list rather than stored twice. */
  function persist(c, quiet) {
    var v = decide(c.intake);
    var steps = PHASES.map(function (p) {
      var st = (c.phaseState || {})[p[0]] || {};
      return { label: p[1], done: !!st.done, date: st.date || '', owner: p[3] };
    });
    var doneCount = steps.filter(function (s) { return s.done; }).length;
    var rec = {
      email: c.email,
      businessName: c.intake.businessName || c.businessName || '',
      route: v.title,
      phase: doneCount === steps.length ? 'Complete' : (v.badge || 'In progress'),
      nextAction: (steps.filter(function (s) { return !s.done; })[0] || {}).label || 'Nothing outstanding',
      steps: steps,
      intake: c.intake
    };
    // Local state kept alongside so the console does not lose audit marks that
    // the client-facing record has no place for.
    rec.audit = c.audit;
    // Resolves true only when the server actually stored it. A failed save must
    // never look like a successful one — the banner stays up until it works.
    return api('POST', { action: 'onboarding', record: rec }).then(function () {
      var had = S.saveError;
      S.saveError = '';
      if (!quiet) toast('Saved — client portal updated');
      if (had) renderMain();
      return true;
    }).catch(function (e) {
      S.saveError = e.message === 'storage-not-configured'
        ? 'Nothing is being saved. This project has no KV storage connected, so every change here is lost on reload. Connect a Redis/KV store to the Vercel project, redeploy, then reload this page.'
        : 'Nothing is being saved. The server rejected the write (' + e.message + ').';
      renderMain();
      return false;
    });
  }

  /* -------------------------------------------------------------- render */
  function render() {
    var app = document.getElementById('app');
    app.innerHTML = '';
    if (!S.authed) return renderGate(app);

    var top = el('div', 'top');
    var h1 = el('h1', null, 'WOLFE OS'); top.appendChild(h1);
    top.appendChild(el('span', 'sub', 'client engagement console'));
    top.appendChild(el('span', 'spacer'));
    top.appendChild(el('span', 'who', S.email));
    var out = el('button', 'ghost', 'Sign out');
    out.onclick = function () {
      try { sessionStorage.removeItem('wolfe-os-auth'); } catch (e) {}
      S.authed = false; S.token = ''; S.clients = []; S.sel = null; render();
    };
    top.appendChild(out);
    app.appendChild(top);

    var shell = el('div', 'shell');
    var rail = el('div', 'rail');
    rail.appendChild(el('h2', null, 'Clients'));
    var list = el('div');
    if (!S.clients.length) list.appendChild(el('div', 'note', 'No clients yet.'));
    S.clients.forEach(function (c) {
      var v = decide(c.intake);
      var done = PHASES.filter(function (p) { return ((c.phaseState || {})[p[0]] || {}).done; }).length;
      var b = el('button', 'cbtn' + (c.email === S.sel ? ' sel' : ''));
      b.innerHTML = '<b>' + esc(c.intake.businessName || c.businessName || c.email) + '</b>' +
                    '<span>' + esc(v.badge) + ' · ' + done + '/' + PHASES.length + ' steps</span>';
      b.onclick = function () { S.sel = c.email; render(); };
      list.appendChild(b);
    });
    rail.appendChild(list);
    var add = el('button', 'newbtn', '+ New client');
    add.onclick = newClient;
    rail.appendChild(add);
    var n = el('div', 'note', 'Stored on the server, behind your owner login. The client sees their progress in the portal.');
    n.style.marginTop = 'auto';
    rail.appendChild(n);
    shell.appendChild(rail);

    var main = el('main');
    main.id = 'main';
    shell.appendChild(main);
    app.appendChild(shell);
    renderMain();
  }

  function renderGate(app) {
    var g = el('div', 'gate');
    g.appendChild(el('h2', null, 'Wolfe OS'));
    g.appendChild(el('p', null, 'Owner access only. Same credentials as the portal.'));
    var e = el('label'); e.appendChild(el('span', null, 'Email'));
    var ei = el('input'); ei.type = 'email'; ei.value = S.emailDraft;
    ei.oninput = function () { S.emailDraft = ei.value; };
    e.appendChild(ei); g.appendChild(e);
    var c = el('label'); c.appendChild(el('span', null, 'Access code'));
    var ci = el('input'); ci.type = 'password'; ci.value = S.codeDraft;
    ci.oninput = function () { S.codeDraft = ci.value; };
    ci.onkeydown = function (ev) { if (ev.key === 'Enter') doLogin(); };
    c.appendChild(ci); g.appendChild(c);
    var b = el('button', 'newbtn', S.busy ? 'Signing in…' : 'Sign in');
    b.style.width = '100%'; b.style.marginTop = '6px';
    b.onclick = doLogin;
    g.appendChild(b);
    g.appendChild(el('div', 'err', S.err));
    app.appendChild(g);
    ei.focus();
  }

  function doLogin() {
    if (S.busy) return;
    var email = (S.emailDraft || '').trim().toLowerCase(), code = (S.codeDraft || '').trim();
    if (!email || !code) { S.err = 'Enter your email and access code.'; return render(); }
    S.busy = true; S.err = ''; render();
    fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ email: email, code: code }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
      .then(function (x) {
        S.busy = false;
        if (!x.r.ok || !x.d.token) {
          S.err = x.r.status === 401 ? 'Wrong email or access code.'
                : x.r.status === 429 ? 'Too many attempts. Wait a few minutes.'
                : 'Sign-in unavailable right now.';
          return render();
        }
        if (x.d.role !== 'owner') { S.err = 'This console is owner-only.'; return render(); }
        S.authed = true; S.email = x.d.email; S.token = x.d.token; S.codeDraft = '';
        try { sessionStorage.setItem('wolfe-os-auth', JSON.stringify({ email: S.email, token: S.token })); } catch (e) {}
        loadClients().catch(function (e) { toast('Could not load clients: ' + e.message); render(); });
      })
      .catch(function () { S.busy = false; S.err = 'Could not reach the sign-in service.'; render(); });
  }

  // An inline form rather than prompt(): a native dialog cannot be validated,
  // cannot be styled, and blocks the whole page while it is open.
  function addFormNode() {
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'New client'));
    var g = el('div', 'grid');

    var le = el('label');
    le.appendChild(el('span', null, "Client's email address"));
    var ie = el('input'); ie.type = 'email';
    ie.placeholder = 'How their portal login is matched';
    ie.value = S.newEmail;
    ie.oninput = function () { S.newEmail = ie.value; };
    le.appendChild(ie);
    le.appendChild(el('span', 'hint', 'Get this right — it is the key their portal signs in on.'));

    var ln = el('label');
    ln.appendChild(el('span', null, 'Business name'));
    var inm = el('input'); inm.type = 'text';
    inm.placeholder = 'What is on the truck';
    inm.value = S.newName;
    inm.oninput = function () { S.newName = inm.value; };
    ln.appendChild(inm);

    g.appendChild(le); g.appendChild(ln);
    fs.appendChild(g);

    var err = el('div'); err.style.cssText = 'color:var(--stop);font-size:13px;min-height:18px;margin-top:8px;';
    fs.appendChild(err);

    var bar = el('div', 'bar');
    var add = el('button', 'newbtn', 'Add client');
    add.onclick = function () {
      var email = (S.newEmail || '').trim().toLowerCase();
      var name = (S.newName || '').trim();
      if (email.indexOf('@') < 1 || email.indexOf('.') < 0) { err.textContent = 'That does not look like an email address.'; return; }
      if (!name) { err.textContent = 'Give the business a name.'; return; }
      for (var i = 0; i < S.clients.length; i++) {
        if (S.clients[i].email === email) { err.textContent = 'That client already exists.'; return; }
      }
      err.textContent = '';
      add.disabled = true; add.textContent = 'Saving…';
      var c = { email: email, businessName: name,
                intake: { businessName: name, businessType: 'field_service', bookingTitle: 'Free Estimate' },
                phaseState: {}, audit: {}, steps: [] };
      // Only keep it locally once the server has it. Otherwise a storage outage
      // leaves a client sitting in the rail that does not exist anywhere.
      persist(c, true).then(function (ok) {
        if (!ok) { add.disabled = false; add.textContent = 'Add client'; render(); return; }
        S.clients.push(c); S.sel = email; S.tab = 'intake';
        S.adding = false; S.newEmail = ''; S.newName = '';
        render();
      });
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = function () { S.adding = false; S.newEmail = ''; S.newName = ''; render(); };
    bar.appendChild(add); bar.appendChild(cancel);
    fs.appendChild(bar);
    return fs;
  }

  function newClient() { S.adding = true; S.sel = null; render(); }

  function fieldNode(c, f) {
    var k = f[0], lab = f[1], type = f[2], hint = f[3];
    var w = el('label');
    w.appendChild(el('span', null, lab));
    var inp;
    if (type === 'textarea') inp = el('textarea');
    else if (type.indexOf('select:') === 0) {
      inp = el('select');
      type.slice(7).split('|').forEach(function (o) {
        var p = o.split('='), op = el('option');
        op.value = p[0]; op.textContent = p[1] || '—';
        inp.appendChild(op);
      });
    } else { inp = el('input'); inp.type = 'text'; }
    inp.value = c.intake[k] || '';
    // A select cannot show a placeholder, so its hint goes underneath. Inputs and
    // textareas carry it as placeholder text — showing both reads as a mistake.
    if (hint && type.indexOf('select:') !== 0) inp.placeholder = hint;
    var commit = function () { c.intake[k] = inp.value; renderVerdict(); };
    inp.oninput = commit;
    inp.onchange = function () { commit(); persist(c, true); renderRail(); };
    w.appendChild(inp);
    if (hint && type.indexOf('select:') === 0) w.appendChild(el('span', 'hint', hint));
    return w;
  }

  function renderRail() {
    var c = cur(); if (!c) return;
    var btns = document.querySelectorAll('.rail .cbtn');
    var i = S.clients.indexOf(c);
    if (btns[i]) {
      var v = decide(c.intake);
      var done = PHASES.filter(function (p) { return ((c.phaseState || {})[p[0]] || {}).done; }).length;
      btns[i].innerHTML = '<b>' + esc(c.intake.businessName || c.email) + '</b>' +
                          '<span>' + esc(v.badge) + ' · ' + done + '/' + PHASES.length + ' steps</span>';
    }
  }

  function verdictNode(c) {
    var v = decide(c.intake), b = blockers(c.intake);
    var d = el('div', 'verdict v-' + (v.kind === 'none' ? '' : v.kind));
    var h = '<span class="chip c-' + (v.kind === 'none' ? 'none' : v.kind) + '">' + esc(v.badge) + '</span>' +
            '<h3>' + esc(v.title) + '</h3><p>' + v.lead + '</p>';
    if (b.length) h += '<div class="blk"><b>Resolve first</b><ul>' +
      b.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    if (v.deliver.length) h += '<div class="lbl">Wolfe delivers</div><ul>' +
      v.deliver.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
    if (v.next.length) h += '<div class="lbl">Watch for</div><ul>' +
      v.next.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
    d.innerHTML = h;
    return d;
  }

  function renderVerdict() {
    var host = document.getElementById('verdictHost');
    if (!host) return;
    var c = cur(); if (!c) return;
    host.innerHTML = '';
    host.appendChild(verdictNode(c));
  }

  /* ------------------------------------------------------------ overview */
  function daysSince(iso) {
    if (!iso) return null;
    var t = Date.parse(iso + 'T00:00:00');
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  // Google publishes no review SLA, and profiles do sometimes sit for weeks or
  // land in a loop where video is accepted repeatedly and never completes. So
  // these are chase prompts, not deadlines: check in at 5 days so silence does
  // not read as abandonment, escalate at 14.
  function stall(c) {
    var sub = (c.phaseState || {}).verifySub || {};
    var pass = (c.phaseState || {}).verifyPass || {};
    if (!sub.done || pass.done) return null;
    var d = daysSince(sub.date);
    if (d == null) return null;
    if (d >= 14) return { level: 'stop', text: d + ' days since the video went in. Escalate to Google support — repeated accepted videos that never complete is a known loop.' };
    if (d >= 5) return { level: 'warn', text: d + ' days waiting on Google. Message the client either way so the silence does not read as abandonment.' };
    return null;
  }

  function overviewNode() {
    var wrap = el('div');
    var h = el('div', 'hd');
    h.innerHTML = '<h2>All clients</h2>';
    wrap.appendChild(h);
    wrap.appendChild(el('p', 'sub', S.clients.length + (S.clients.length === 1 ? ' engagement' : ' engagements')));

    var flagged = 0;
    S.clients.forEach(function (c) {
      var v = decide(c.intake);
      var steps = PHASES.filter(function (p) { return ((c.phaseState || {})[p[0]] || {}).done; });
      var next = null;
      for (var i = 0; i < PHASES.length; i++) {
        if (!((c.phaseState || {})[PHASES[i][0]] || {}).done) { next = PHASES[i]; break; }
      }
      var st = stall(c);
      if (st) flagged++;

      var r = el('div', 'row');
      r.style.cursor = 'pointer';
      r.style.flexDirection = 'column';
      r.style.gap = '6px';
      r.onclick = function () { S.sel = c.email; S.tab = 'progress'; render(); };

      var top = el('div');
      top.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;width:100%;';
      top.innerHTML = '<b style="font-size:15px;">' + esc(c.intake.businessName || c.email) + '</b>'
        + '<span class="chip c-' + (v.kind === 'none' ? 'none' : v.kind) + '">' + esc(v.badge) + '</span>'
        + '<span style="flex:1"></span>'
        + '<span style="font-family:\'Space Mono\',monospace;font-size:11px;color:var(--faint);">'
        + steps.length + '/' + PHASES.length + '</span>';
      r.appendChild(top);

      var line = el('div');
      line.style.cssText = 'font-size:13px;color:var(--muted);';
      line.textContent = next
        ? (next[3] === 'you' ? 'Waiting on the client — ' : next[3] === 'google' ? 'With Google — ' : 'Next — ') + next[1]
        : 'Complete';
      r.appendChild(line);

      if (st) {
        var w = el('div');
        w.style.cssText = 'font-size:12.5px;padding:7px 9px;border-radius:3px;width:100%;background:'
          + (st.level === 'stop' ? 'var(--stop-bg);color:var(--stop)' : 'var(--warn-bg);color:var(--warn)') + ';';
        w.textContent = st.text;
        r.appendChild(w);
      }
      wrap.appendChild(r);
    });

    var n = el('p', 'note', flagged
      ? flagged + ' onboarding' + (flagged === 1 ? '' : 's') + ' needs chasing. Everything else is moving.'
      : 'Nothing is stalled. Verification waits are flagged here at 5 days and escalated at 14.');
    wrap.appendChild(n);
    return wrap;
  }

  function renderMain() {
    var m = document.getElementById('main');
    if (!m) return;
    m.innerHTML = '';

    if (S.saveError) {
      var warn = el('div', 'blk');
      warn.style.marginBottom = '18px';
      warn.appendChild(el('b', null, 'Not saving'));
      warn.appendChild(el('div', null, S.saveError));
      m.appendChild(warn);
    }

    if (S.adding) { m.appendChild(addFormNode()); return; }

    var c = cur();
    // With clients on the books the useful default is the overview, not a
    // placeholder — the daily question is which engagement needs chasing.
    if (!c && S.clients.length) { m.appendChild(overviewNode()); return; }
    if (!c) {
      var e = el('div', 'empty');
      e.innerHTML = '<h2>No client selected</h2>' +
        '<p>Add one to start an engagement. The console holds the intake, works out which package fits, ' +
        'tracks the onboarding through the verification wait, and writes progress straight into the ' +
        "client's portal.</p>" +
        '<p>Everything here is deterministic — the same gates the checklists use. Nothing calls a model, ' +
        'so nothing is billed per click and nothing can be confidently wrong.</p>';
      m.appendChild(e);
      return;
    }

    var v = decide(c.intake);
    var hd = el('div', 'hd');
    hd.innerHTML = '<h2>' + esc(c.intake.businessName || c.email) + '</h2>' +
                   '<span class="chip c-' + (v.kind === 'none' ? 'none' : v.kind) + '">' + esc(v.badge) + '</span>';
    m.appendChild(hd);
    m.appendChild(el('p', 'sub', c.email + (c.updatedAt ? ' · updated ' + c.updatedAt.slice(0, 10) : '')));

    var tabs = el('div', 'tabs');
    [['intake', 'Intake'], ['route', 'Direction'], ['progress', 'Progress'], ['audit', 'Audit'], ['export', 'Export']]
      .forEach(function (t) {
        var b = el('button', S.tab === t[0] ? 'on' : null, t[1]);
        b.onclick = function () { S.tab = t[0]; renderMain(); };
        tabs.appendChild(b);
      });
    m.appendChild(tabs);

    if (S.tab === 'intake') {
      FIELDS.forEach(function (grp) {
        var fs = el('fieldset');
        fs.appendChild(el('legend', null, grp[0]));
        var g = el('div', 'grid');
        grp[1].forEach(function (f) { g.appendChild(fieldNode(c, f)); });
        fs.appendChild(g);
        m.appendChild(fs);
      });
      var host = el('div'); host.id = 'verdictHost'; m.appendChild(host); renderVerdict();
    }

    if (S.tab === 'route') {
      var h2 = el('div'); h2.id = 'verdictHost'; m.appendChild(h2); renderVerdict();
      m.appendChild(el('p', 'note',
        'Gates run in order and stop at the first failure: capacity, verification, reviews, budget, then LSA eligibility. Change an answer on the Intake tab and this updates.'));
    }

    if (S.tab === 'progress') {
      PHASES.forEach(function (p) {
        var st = c.phaseState[p[0]] = c.phaseState[p[0]] || {};
        var r = el('div', 'row' + (st.done ? ' done' : ''));
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!st.done;
        // A bare checkbox announces as "checkbox" with no name; give it the step.
        cb.setAttribute('aria-label', p[1]);
        cb.onchange = function () {
          st.done = cb.checked;
          if (st.done && !st.date) st.date = today();
          persist(c).then(function () { renderMain(); renderRail(); });
        };
        var t = el('div', 't');
        t.innerHTML = '<b>' + esc(p[1]) + '</b>' + (p[2] ? '<p>' + esc(p[2]) + '</p>' : '');
        // The label text is the biggest target on the row; make it toggle too.
        t.style.cursor = 'pointer';
        t.onclick = function () { cb.checked = !cb.checked; cb.onchange(); };
        var dt = el('input'); dt.type = 'date'; dt.value = st.date || '';
        dt.setAttribute('aria-label', 'Date completed: ' + p[1]);
        dt.onchange = function () { st.date = dt.value; persist(c, true); };
        r.appendChild(cb); r.appendChild(t); r.appendChild(dt);
        m.appendChild(r);
      });
      m.appendChild(el('p', 'note', 'Ticking a step updates the client portal immediately.'));
    }

    if (S.tab === 'audit') {
      AUDIT.forEach(function (a) {
        var r = el('div', 'row');
        var t = el('div', 't');
        t.innerHTML = '<b>' + esc(a[1]) + '</b>' + (a[2] ? '<p>' + esc(a[2]) + '</p>' : '');
        var s = el('select');
        [['', '—'], ['Pass', 'Pass'], ['Fail', 'Fail'], ['N/A', 'N/A'], ['Not checked', 'Not checked']]
          .forEach(function (o) { var op = el('option'); op.value = o[0]; op.textContent = o[1]; s.appendChild(op); });
        s.setAttribute('aria-label', 'Result: ' + a[1]);
        s.value = c.audit[a[0]] || '';
        s.onchange = function () { c.audit[a[0]] = s.value; persist(c, true); };
        r.appendChild(t); r.appendChild(s);
        m.appendChild(r);
      });
      m.appendChild(el('p', 'note',
        "Mark rows N/A with a reason when they genuinely don't apply — a remote business has no service area, and scoring that as a failure invents problems. The failure mode of this audit is false positives, not missed findings."));
    }

    if (S.tab === 'export') {
      var bar = el('div', 'bar');
      var save = el('button', 'ghost', 'Save now');
      save.onclick = function () { persist(c); };
      bar.appendChild(save);
      // Inline confirmation for the same reason the new-client prompt went:
      // a native dialog blocks the page and cannot be styled or automated.
      var del = el('button', 'ghost', 'Remove client');
      var confirmBox = el('div');
      confirmBox.style.display = 'none';
      confirmBox.style.cssText += 'margin-top:12px;padding:12px 14px;border-radius:3px;'
        + 'background:var(--stop-bg);max-width:60ch;';
      var msg = el('div');
      msg.style.cssText = 'color:var(--stop);font-size:13.5px;margin-bottom:10px;';
      msg.textContent = 'Remove ' + (c.intake.businessName || c.email)
        + '? Their onboarding disappears from their portal too, and the intake is not recoverable.';
      var cbar = el('div', 'bar');
      cbar.style.marginTop = '0';
      var yes = el('button', 'ghost', 'Yes, remove');
      yes.style.cssText += 'border-color:var(--stop);color:var(--stop);';
      yes.onclick = function () {
        yes.disabled = true; yes.textContent = 'Removing…';
        api('POST', { action: 'onboarding-remove', email: c.email }).then(function () {
          S.clients = S.clients.filter(function (x) { return x.email !== c.email; });
          S.sel = null; toast('Removed'); render();
        }).catch(function (e) {
          yes.disabled = false; yes.textContent = 'Yes, remove';
          toast('Could not remove: ' + e.message);
        });
      };
      var no = el('button', 'ghost', 'Keep it');
      no.onclick = function () { confirmBox.style.display = 'none'; del.style.display = ''; };
      cbar.appendChild(yes); cbar.appendChild(no);
      confirmBox.appendChild(msg); confirmBox.appendChild(cbar);
      del.onclick = function () { del.style.display = 'none'; confirmBox.style.display = 'block'; };
      bar.appendChild(del);
      m.appendChild(bar);
      m.appendChild(confirmBox);
      m.appendChild(el('p', 'note', 'What the client currently sees in their portal:'));
      var pre = el('pre', 'mono');
      var steps = PHASES.map(function (p) {
        var st = (c.phaseState || {})[p[0]] || {};
        return (st.done ? '[x] ' : '[ ] ') + p[1] + (st.date ? '  (' + st.date + ')' : '');
      }).join('\n');
      pre.textContent = (c.intake.businessName || c.email) + '\n' + decide(c.intake).title + '\n\n' + steps;
      m.appendChild(pre);
    }
  }

  /* ---------------------------------------------------------------- boot */
  try {
    var raw = sessionStorage.getItem('wolfe-os-auth');
    if (raw) {
      var ses = JSON.parse(raw);
      if (ses && ses.token && ses.email) {
        S.authed = true; S.email = ses.email; S.token = ses.token;
        loadClients().catch(function () {
          try { sessionStorage.removeItem('wolfe-os-auth'); } catch (e) {}
          S.authed = false; S.token = ''; render();
        });
      }
    }
  } catch (e) {}
  render();
})();
