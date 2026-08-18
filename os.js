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

  var S = { authed: false, email: '', token: '', clients: [], sel: null, tab: 'client',
            emailDraft: '', codeDraft: '', err: '', busy: false, saveError: '',
            adding: false, newEmail: '', newName: '', expired: false,
            leads: [], visits: {}, addingLead: false, newLead: {}, config: {},
            exportOpen: false, exportTz: 'America/New_York', exportFormat: 'enhanced',
            exportBookedName: 'Estimate booked', exportWonName: 'Customer won' };

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
    ['booking', 'Website and estimate form live', 'The page ads land on; every inquiry lands here', 'wolfe'],
    ['bookLink', 'Website link added to the profile', 'Only possible after verification', 'wolfe'],
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
    ['hours', 'Hours and availability differences are deliberate', "Ask, don't assume"],
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
    ['Accounts', [
      ['googleAccount', 'Google account', 'text', ''],
      ['existingListing', 'Existing listing found', 'text', 'Leave blank if none']
    ]]
  ];

  /* ------------------------------------------------- routing (the gates) */
  function blockers_google(a) {
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

  function decide_google(a) {
    var answered = ['capacity', 'verified', 'reviewsCount', 'insurance', 'budget'].some(function (k) { return a[k]; });
    if (!answered) return { kind: 'none', badge: 'Awaiting intake', title: 'Start with capacity',
      lead: 'The first gate can end the conversation, so answer it before anything else.', deliver: [], next: [] };

    if (a.capacity === 'full') return { kind: 'stop', badge: 'Do not sell ads', title: 'Foundation and pricing only',
      lead: 'A full route means paid leads get turned away or stretch their drive time. Advertising here damages the engagement.',
      deliver: ['<strong>Profile and reviews</strong> so the leads they do get are better',
                '<strong>Pricing and route review</strong> — replacing low-value customers beats adding volume',
                '<strong>Estimate form on their page</strong> so inquiries stop getting lost while they work'],
      next: ['Revisit advertising when they add capacity or raise prices enough to free some.'] };

    if (a.verified === 'no' || a.verified === 'exists') return { kind: 'found', badge: 'Phase zero', title: 'Get verified first',
      lead: 'Nothing paid starts before the listing is approved. Verification takes days and sometimes weeks.',
      deliver: ['<strong>Profile ' + (a.verified === 'exists' ? 'claim' : 'creation') + '</strong> and verification, video prep included',
                '<strong>Their page with the estimate form</strong>, and the link on the profile once approved',
                '<strong>Lead log</strong> from the first inquiry, to build a pre-spend baseline'],
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
                '<strong>Their page with the estimate form</strong> linked directly on the profile',
                '<strong>Monthly reporting</strong> from the lead log'],
      next: ['Revisit paid channels once they will commit real monthly spend.'] };

    var wantsSite = a.site === 'none' || a.site === 'social';
    if (a.insurance === 'yes') return { kind: 'lsa', badge: 'Recommended',
      title: 'Local Services Ads management' + (wantsSite ? ' + simple site' : ''),
      lead: 'They clear the gate, so LSA is the better first channel: charged per lead, leads arrive already attributed, junk is disputable.' +
            (wantsSite ? " A simple site is worth adding — LSA doesn't need one, but it is where tracking becomes possible later." : ''),
      deliver: ['<strong>LSA setup</strong> — background check, insurance, license verification',
                '<strong>Lead management</strong> in the LSA inbox, marking booked and won',
                wantsSite ? '<strong>Simple site</strong> with an inquiry form, capturing the GCLID from day one'
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
      deliver: ['<strong>Site build</strong> with an inquiry form as the primary call to action',
                '<strong>Conversion tracking</strong> on form submission, plus GCLID capture',
                '<strong>Search campaigns</strong> geo-fenced tightly around their existing route',
                '<strong>Lead log</strong> reconciling spend against customers won'],
      next: ['Make the form the main call to action. A booking link straight to Google Calendar cannot be tracked.',
             'Hold off on uploading offline conversions until volume justifies it. Capture the GCLIDs now regardless.'] };
  }

  /* ------------------------------------------------- engagement types */
  // One console, three kinds of engagement. Each type carries its own intake
  // fields, its own routing gates, its own step list (what the client's portal
  // renders) and its own launch checks. Everything above this comment is the
  // Google engagement; the two below come from the same discipline applied to
  // private-AI and automation work.
  //
  // The AI and automation intakes lean on published readiness practice rather
  // than invention: process-automation suitability is scored on rule clarity,
  // volume, input structure, stability, error cost and system access (the
  // RPA-selection literature and the Forge/NextPage scorecards all converge on
  // those six); AI readiness asks for a describable workflow, accessible data,
  // a named human owner, and one metric with a baseline before anything is
  // built. Neither of those is a Wolfe opinion — they are what the field has
  // learned the hard way. Sources are listed in the README.

  var PHASES_AI = [
    ['intake', 'Intake complete', 'Facts gathered by conversation, not a form', 'wolfe'],
    ['metric', 'Success number and today’s baseline written down', 'If nobody can say what moved, nobody can say it worked', 'wolfe'],
    ['sources', 'Knowledge sources handed over', 'Price sheets, FAQs, past replies, the documents they already trust', 'you'],
    ['machine', 'Machine or account confirmed and ready', 'Where it runs, and that it can', 'you'],
    ['evalset', 'Acceptance test written from their real questions', 'Twenty real questions with the answers they would give', 'wolfe'],
    ['kb', 'Knowledge base built and indexed', '', 'wolfe'],
    ['assistant', 'Assistant set up where agreed', 'Their machine or their account — keys stay with them', 'wolfe'],
    ['guardrails', 'Guardrails encoded', 'What it must never say or do, and what it hands to a human', 'wolfe'],
    ['evalpass', 'Acceptance test passed', 'Answers checked against theirs, not eyeballed', 'wolfe'],
    ['trained', 'Owner trained — first coaching session', '', 'you'],
    ['twoweeks', 'Two weeks of real use, then a review', 'The questions it got wrong go into the test set', 'you'],
    ['upkeep', 'Update routine agreed', 'Who refreshes the knowledge, and when', 'you'],
    ['handoff', 'Handoff sent', '', 'wolfe']
  ];

  var AUDIT_AI = [
    ['where', 'Runs where agreed', 'On their machine or in their account; provider keys are theirs'],
    ['residue', 'Nothing of theirs left on Wolfe machines', 'Documents, exports, test transcripts'],
    ['guard', 'Guardrails hold', 'Tried the forbidden asks; it refused or handed off'],
    ['eval', 'Acceptance test at the agreed pass rate', 'Scored, not eyeballed'],
    ['restart', 'Owner can restart it unaided', 'Watched them do it'],
    ['upkeepOwner', 'Knowledge update has a named owner and a cadence', ''],
    ['metricMoved', 'Success number re-measured against the baseline', 'Two weeks in']
  ];

  var FIELDS_AI = [
    ['Business', [
      ['businessName', 'Business name', 'text', ''],
      ['phone', 'Phone', 'text', ''],
      ['website', 'Website', 'text', 'Leave blank if none'],
      ['whatTheyDo', 'What they actually do', 'textarea', 'In their words']
    ]],
    ['The job', [
      ['topTasks', 'The five things they want it to do', 'textarea', 'In their words, most valuable first'],
      ['users', 'Who will use it', 'text', 'Owner only, or the crew too'],
      ['champion', 'Who owns it and checks its answers', 'text', 'One named person'],
      ['successMetric', 'The one number this should move', 'text', 'Minutes a day, quotes a week, replies answered'],
      ['baseline', 'That number today', 'text', 'Measured, not guessed']
    ]],
    ['Knowledge', [
      ['knowledgeSources', 'Where the answers live today', 'textarea', 'Price sheet, FAQ, old emails, a binder, someone’s head'],
      ['knowledgeShape', 'Shape of that knowledge', 'select:=—|digital=Digital and organized|scattered=Digital but scattered|heads=Mostly on paper or in heads', 'Decides whether the first weeks are building or capturing'],
      ['updateOwner', 'Who keeps it current', 'text', 'Prices change; someone has to tell it'],
      ['evalSet', 'Real questions with known answers', 'select:=—|have=Have 20 or more|can=Can assemble them|no=Not really', 'The acceptance test is built from these']
    ]],
    ['Where it runs', [
      ['runWhere', 'Where it should run', 'select:=—|local=Their own machine|cloud=Their own cloud account|unsure=Not decided', 'Local keeps data home; an account is simpler to keep running'],
      ['machine', 'The machine', 'text', 'OS, RAM, graphics card and its memory'],
      ['dataSensitivity', 'What the data contains', 'select:=—|none=Nothing sensitive|pii=Customer names and contact details|regulated=Health, financial or legal records', 'Regulated data stays local unless their own account is cleared for it'],
      ['mustNever', 'What it must never do or say', 'textarea', 'Quote a price, promise a date, give legal or medical advice, email anyone'],
      ['humanReview', 'Human review', 'select:=—|always=Someone reads every answer|customer=Only customer-facing answers reviewed|none=Runs on its own', 'Start reviewed; loosen once the test set says so']
    ]],
    ['Time', [
      ['learnTime', 'Hours a week the owner will give it', 'select:=—|low=Under one|mid=One or two|high=Three or more', 'Below one, coaching stalls']
    ]]
  ];

  function blockersAi(a) {
    var b = [];
    if (a.dataSensitivity === 'regulated' && a.runWhere === 'cloud')
      b.push('Regulated records in a cloud account: confirm the account’s terms cover it, or run it locally.');
    if (a.runWhere === 'local' && !(a.machine || '').trim())
      b.push('Machine unknown. A responsive local assistant wants a recent machine with a proper graphics card; a thin laptop will disappoint. Get the specs before promising local.');
    if (!(a.champion || '').trim() && (a.topTasks || a.knowledgeSources))
      b.push('No named owner. Without one person checking answers, nobody notices when it drifts.');
    if (a.humanReview === 'none' && a.mustNever)
      b.push('Runs unreviewed but has things it must never do — keep a review step until the acceptance test proves the guardrails.');
    return b;
  }

  function decideAi(a) {
    var answered = ['topTasks', 'knowledgeShape', 'runWhere', 'successMetric', 'evalSet'].some(function (k) { return a[k]; });
    if (!answered) return { kind: 'none', badge: 'Awaiting intake', title: 'Start with the job',
      lead: 'What are the five things they want it to do, in their words? Everything else follows from that.', deliver: [], next: [] };

    if (a.knowledgeShape === 'heads') return { kind: 'fix', badge: 'Capture first', title: 'Knowledge capture, then the assistant',
      lead: 'The answers live in someone’s head or a binder. An assistant built on that has nothing to stand on — the first weeks are capture, and that is the deliverable, not a delay.',
      deliver: ['<strong>Capture sessions</strong> — the price sheet, the standard answers, the way they actually quote',
                '<strong>A written knowledge base</strong> they own regardless of what happens next',
                '<strong>The assistant</strong> once there is something real to ground it in'],
      next: ['Write the success number down anyway; capture is measured too.'] };

    if (!(a.successMetric || '').trim()) return { kind: 'fix', badge: 'Name the number', title: 'One metric before anything is built',
      lead: 'The commonest way an AI setup fails is quietly: nobody can say whether it worked, so nobody knows whether to keep it. Name the number and measure today’s value first.',
      deliver: ['<strong>One metric and its baseline</strong> — minutes a day, quotes a week, whatever they feel',
                '<strong>Then</strong> the build'],
      next: ['Ask what they would stop doing if it worked. That is usually the number.'] };

    var local = a.runWhere === 'local';
    return { kind: 'go', badge: 'Recommended', title: local ? 'Private assistant on their own machine' : 'Private assistant in their own account',
      lead: (local ? 'Their data stays on their machine and the keys are theirs. ' : 'Simpler to keep running, still their account and their keys. ')
          + 'Built from their own knowledge, tested against their own questions, reviewed by a named owner until the test set says it can run alone.',
      deliver: ['<strong>Knowledge base</strong> from ' + (a.knowledgeShape === 'scattered' ? 'their scattered sources, gathered and organized' : 'their existing documents'),
                '<strong>The assistant</strong> ' + (local ? 'on their machine' : 'in their account') + ', working from that knowledge and nothing else',
                '<strong>Guardrails</strong> for what it must never do, and a hand-off to a human when it should not answer',
                '<strong>Acceptance test</strong> — ' + (a.evalSet === 'have' ? 'their 20 real questions' : 'twenty real questions assembled with them') + ', scored before go-live',
                '<strong>Coaching</strong> until the owner runs and updates it unaided'],
      next: [a.evalSet === 'no' ? 'No test set yet — build it in the first session from real questions; nothing ships until it passes.' : 'Score the acceptance test; do not eyeball it.',
             a.humanReview === 'none' ? 'They want it unreviewed. Start reviewed anyway and loosen once the test set earns it.' : 'Keep the review step until the test set says otherwise.',
             a.learnTime === 'low' ? 'Under an hour a week from the owner — coaching will stall. Say so now.' : 'Book the two-week review before handoff, not after.'] };
  }

  var PHASES_AUTO = [
    ['intake', 'Intake complete', 'One process, walked step by step', 'wolfe'],
    ['baseline', 'Baseline measured', 'Minutes per run, runs per week, mistakes per month — today', 'wolfe'],
    ['owner', 'Owner named', 'One person who checks the output and can switch it off', 'you'],
    ['access', 'Access granted to the tools it touches', 'Email, calendar, forms, invoicing — their accounts, their consent', 'you'],
    ['design', 'Flow written and agreed', 'Trigger, steps, exceptions, what goes to a human', 'wolfe'],
    ['built', 'Automation built', '', 'wolfe'],
    ['reviewed', 'Runs with the owner approving each result', 'Two weeks minimum, longer if customer-facing', 'you'],
    ['exceptions', 'Exceptions reviewed and the flow tightened', 'The ones a human had to catch', 'wolfe'],
    ['unattended', 'Switched to unattended, if earned', 'Only when the review period says so', 'wolfe'],
    ['remeasured', 'Re-measured against the baseline', 'Same three numbers', 'wolfe'],
    ['handoff', 'Handoff sent — how to pause it, how to change it', '', 'wolfe']
  ];

  var AUDIT_AUTO = [
    ['ownerCan', 'Owner can pause it and see what it did', 'Watched them do it'],
    ['humanPath', 'Exceptions reach a human', 'Tried one; it did not vanish'],
    ['consent', 'Only touches accounts the owner authorized', 'Their accounts, their consent, revocable'],
    ['baselineKept', 'Baseline and re-measure recorded', 'Same numbers, same method'],
    ['customerSafe', 'Customer-facing output was reviewed before it went unattended', ''],
    ['noResidue', 'No client data left on Wolfe systems', '']
  ];

  var FIELDS_AUTO = [
    ['Business', [
      ['businessName', 'Business name', 'text', ''],
      ['phone', 'Phone', 'text', ''],
      ['website', 'Website', 'text', 'Leave blank if none'],
      ['whatTheyDo', 'What they actually do', 'textarea', 'In their words']
    ]],
    ['The one process', [
      ['processName', 'The process to automate first', 'text', 'One. The next one comes after this one works'],
      ['trigger', 'What starts it', 'text', 'A call, a form, a Friday, an invoice going overdue'],
      ['stepsToday', 'The steps today, in order', 'textarea', 'As they actually happen, not as the manual says'],
      ['whoDoes', 'Who does it now', 'text', ''],
      ['systems', 'Tools it touches', 'text', 'Email, calendar, forms, invoicing app, spreadsheets'],
      ['customerFacing', 'Does the output reach a customer', 'select:=—|no=No, internal only|yes=Yes, customers see it', 'Customer-facing runs stay reviewed longer']
    ]],
    ['Suitability', [
      ['frequency', 'How often it runs', 'select:=—|5=Many times a day|4=Daily|3=A few times a week|2=Weekly|1=Monthly or rarer', 'Rare processes rarely pay back'],
      ['rules', 'How rule-based it is', 'select:=—|5=Fully rule-based|4=Mostly, a few judgment calls|2=Mostly judgment|1=Pure judgment', 'The heaviest weight. Judgment calls need a human or an AI-assist, not an automation'],
      ['inputs', 'What the inputs look like', 'select:=—|5=Digital and structured (forms, fields)|3=Digital but messy (free-text emails)|1=Paper, photos, voicemail', 'Messy inputs may mean a form is the real fix'],
      ['stability', 'How often the steps change', 'select:=—|5=Unchanged for a year or more|3=Changes now and then|1=Changes constantly', ''],
      ['errorCost', 'What a mistake costs', 'select:=—|5=Costly — money, a customer, a deadline|3=Annoying|1=Harmless', 'High-cost errors are the best reason to automate, and the best reason to keep review'],
      ['access', 'How the tools can be reached', 'select:=—|5=They have integrations or an API|3=Web app only|1=Locked down or desktop-only', 'Web-only means brittle; ask about exports'],
      ['exceptions', 'How often a human has to step in', 'select:=—|5=Under one run in ten|3=One to three in ten|1=More than three in ten', 'Over three in ten, narrow the scope to the common path']
    ]],
    ['Ownership and measure', [
      ['owner', 'Who owns it and checks the output', 'text', 'One named person'],
      ['review', 'Review to start with', 'select:=—|each=Owner approves each run|spot=Owner spot-checks|none=Unattended from day one', 'Start with approval; earn unattended'],
      ['minutesPer', 'Minutes per run today', 'text', 'Timed, not guessed'],
      ['perWeek', 'Runs per week today', 'text', ''],
      ['successMetric', 'The number this should move', 'text', 'Hours a week back, invoices paid sooner, no missed follow-ups']
    ]]
  ];

  // The six-criteria suitability score used across the process-automation
  // literature: each 1 to 5, averaged. Above 4 automate now; 3 to 4 pilot it;
  // 2 to 3 fix the process first; under 2 do not build.
  function autoScore(a) {
    var keys = ['frequency', 'rules', 'inputs', 'stability', 'errorCost', 'access', 'exceptions'];
    var vals = keys.map(function (k) { return parseInt(a[k], 10); }).filter(function (n) { return isFinite(n); });
    if (vals.length < 4) return null;
    return vals.reduce(function (t, n) { return t + n; }, 0) / vals.length;
  }

  function blockersAuto(a) {
    var b = [];
    if (a.rules === '1' || a.rules === '2')
      b.push('Mostly judgment. That is not an automation — it is either an AI-assist with a human deciding, or a different process to start with.');
    if (a.exceptions === '1')
      b.push('More than three runs in ten need a human. Narrow the scope to the common path, or the exceptions become the job.');
    if (a.inputs === '1')
      b.push('Inputs are paper, photos or voicemail. Put a form in front of it first — that step alone may be the win.');
    if (a.access === '1')
      b.push('Tools are locked down or desktop-only. Ask about exports or an integration before promising anything; screen-driving breaks.');
    if (a.customerFacing === 'yes' && a.review === 'none')
      b.push('Customer-facing and unattended from day one. Not on the first process — the owner approves each run until the exceptions are known.');
    if ((a.processName || a.stepsToday) && !(a.owner || '').trim())
      b.push('No named owner. Name one before anything is built.');
    return b;
  }

  function decideAuto(a) {
    var s = autoScore(a);
    var answered = ['processName', 'trigger', 'frequency', 'rules'].some(function (k) { return a[k]; });
    if (!answered) return { kind: 'none', badge: 'Awaiting intake', title: 'Start with one process',
      lead: 'Not the flashiest one — the one with a clear trigger, digital inputs, a human owner and a number that moves.', deliver: [], next: [] };
    if (s == null) return { kind: 'none', badge: 'Score incomplete', title: 'Answer the suitability questions',
      lead: 'Frequency, rules, inputs, stability, error cost, access and exceptions. The score decides the route.', deliver: [], next: [] };

    var sc = s.toFixed(1);
    if (s < 2) return { kind: 'stop', badge: 'Do not build · ' + sc, title: 'Redesign the process, or pick another',
      lead: 'Scores under 2 mean the process is unstable, judgment-heavy, or unreachable. Automating it hard-codes the mess.',
      deliver: ['<strong>Process review</strong> — what would have to be true for this to be automatable',
                '<strong>A different first process</strong> from the same conversation'],
      next: ['The next candidate should score above 3 before anything is promised.'] };

    if (s < 3) return { kind: 'fix', badge: 'Fix first · ' + sc, title: 'Straighten the process, then automate it',
      lead: 'Between 2 and 3 the process is nearly there but something — messy inputs, shifting steps, too many exceptions — will keep breaking the automation. Fix that first; it is usually a form or a rule.',
      deliver: ['<strong>Process fix</strong> — the one change that makes it automatable',
                '<strong>Baseline</strong> measured while it is still manual',
                '<strong>The automation</strong> once the score clears 3'],
      next: ['Re-score after the fix; do not build on the old answers.'] };

    if (s < 4) return { kind: 'pilot', badge: 'Pilot · ' + sc, title: 'Build it, run it reviewed for 30 days',
      lead: 'A good candidate with a soft spot somewhere. Build it, have the owner approve each run for a month, tighten the exceptions, then decide about unattended.',
      deliver: ['<strong>Baseline</strong> — minutes per run, runs per week, mistakes per month',
                '<strong>The automation</strong>, with every exception routed to the owner',
                '<strong>30 reviewed days</strong> and a written list of what it got wrong',
                '<strong>Re-measure</strong>, then unattended if earned'],
      next: [a.customerFacing === 'yes' ? 'Customer-facing: the review period is not negotiable.' : 'Internal only, so the review period can be shorter if the exceptions are quiet.',
             'The exception list is the deliverable that makes the second month better than the first.'] };

    return { kind: 'go', badge: 'Automate now · ' + sc, title: 'Strong candidate — build it',
      lead: 'Frequent, rule-based, digital, stable and reachable. This is what automation is for. Still starts reviewed — unattended is earned, not assumed.',
      deliver: ['<strong>Baseline</strong> measured first',
                '<strong>The automation</strong> across ' + (a.systems ? esc(a.systems) : 'the tools it touches'),
                '<strong>Exception path</strong> to the owner, with a pause switch they control',
                '<strong>Two reviewed weeks</strong>, then unattended, then re-measure'],
      next: ['Ask for the second process now; a strong first one usually has siblings.',
             a.errorCost === '5' ? 'Costly mistakes: keep spot-checks even after unattended.' : 'Log what it did somewhere the owner actually looks.'] };
  }

  var ENGAGEMENTS = {
    google: { label: 'Get found and measured', short: 'Google', fields: FIELDS, phases: PHASES, audit: AUDIT,
              decide: decide_google, blockers: blockers_google, packet: packetGoogle },
    ai: { label: 'Private AI assistant', short: 'Private AI', fields: FIELDS_AI, phases: PHASES_AI, audit: AUDIT_AI,
          decide: decideAi, blockers: blockersAi, packet: packetAi },
    automation: { label: 'Automation', short: 'Automation', fields: FIELDS_AUTO, phases: PHASES_AUTO, audit: AUDIT_AUTO,
                  decide: decideAuto, blockers: blockersAuto, packet: packetAuto }
  };
  function E(c) { return ENGAGEMENTS[(c && c.engagement) || 'google'] || ENGAGEMENTS.google; }
  function decide(c) { return E(c).decide((c && c.intake) || {}); }
  function blockers(c) { return E(c).blockers((c && c.intake) || {}); }

  // Engagement-specific packet sections (the settled decisions and readiness).
  function packetGoogle(c, L) {
    var a = c.intake;
    var g = function (k, lab) { L.push('- **' + lab + ':** ' + (a[k] || '_______')); };
    L.push(''); L.push('## Decisions (settled — do not re-open in front of the client)'); L.push('');
    g('businessName', 'Business name'); g('category', 'Primary category');
    g('secondary', 'Secondary categories'); g('businessType', 'Business shape');
    g('serviceArea', 'Service area'); g('hours', 'Hours'); g('phone', 'Phone'); g('website', 'Website');
    L.push(''); L.push('**Description**'); L.push('');
    L.push('> ' + (a.description || '[write before the session]'));
    L.push(''); L.push('## Verification readiness'); L.push('');
    L.push('- Permanent signage: ' + (a.signage === 'yes' ? 'confirmed'
      : '**NOT CONFIRMED — the commonest cause of failure**'));
    L.push('- Film at: ' + (a.baseAddress || '_______'));
    L.push('- Route: signage → equipment → vehicle → sign into the account. '
      + 'One live take, 30+ seconds, no edits.');
  }
  function packetAi(c, L) {
    var a = c.intake;
    var g = function (k, lab) { L.push('- **' + lab + ':** ' + (a[k] || '_______')); };
    L.push(''); L.push('## The job'); L.push('');
    L.push(a.topTasks || '_______');
    L.push('');
    g('users', 'Who uses it'); g('champion', 'Owner who checks answers');
    g('successMetric', 'Success number'); g('baseline', 'Baseline today');
    L.push(''); L.push('## Knowledge and where it runs'); L.push('');
    g('knowledgeShape', 'Knowledge shape'); g('updateOwner', 'Keeps it current'); g('evalSet', 'Test questions');
    g('runWhere', 'Runs'); g('machine', 'Machine'); g('dataSensitivity', 'Data'); g('humanReview', 'Review');
    L.push(''); L.push('**Sources**'); L.push(''); L.push('> ' + (a.knowledgeSources || '_______'));
    L.push(''); L.push('**Must never**'); L.push(''); L.push('> ' + (a.mustNever || '_______'));
  }
  function packetAuto(c, L) {
    var a = c.intake, s = autoScore(a);
    var g = function (k, lab) { L.push('- **' + lab + ':** ' + (a[k] || '_______')); };
    L.push(''); L.push('## The process'); L.push('');
    g('processName', 'Process'); g('trigger', 'Trigger'); g('whoDoes', 'Done today by'); g('systems', 'Tools');
    g('customerFacing', 'Customer-facing');
    L.push(''); L.push('**Steps today**'); L.push(''); L.push('> ' + (a.stepsToday || '_______'));
    L.push(''); L.push('## Suitability score: ' + (s == null ? 'incomplete' : s.toFixed(1) + ' / 5')); L.push('');
    [['frequency', 'Frequency'], ['rules', 'Rule-based'], ['inputs', 'Inputs'], ['stability', 'Stability'],
     ['errorCost', 'Error cost'], ['access', 'Access'], ['exceptions', 'Exceptions']].forEach(function (p) {
      L.push('- ' + p[1] + ': ' + (a[p[0]] || '—') + '/5');
    });
    L.push(''); L.push('## Ownership and baseline'); L.push('');
    g('owner', 'Owner'); g('review', 'Review'); g('minutesPer', 'Minutes per run'); g('perWeek', 'Runs per week'); g('successMetric', 'Number to move');
  }

  /* ----------------------------------------------------------- transport */
  function api(method, body) {
    var opt = { method: method, headers: { authorization: 'Bearer ' + S.token } };
    if (body) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch('/api/apps', opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401) { var a = new Error('unauthorized'); a.expired = true; throw a; }
        if (!r.ok) throw new Error(d.error || ('http-' + r.status));
        return d;
      });
    });
  }

  /* Google Ads offline conversion file. Format per Google's own template:
     a first row declaring the time zone, then the column headers, then one
     row per conversion. Times are rendered in the declared zone as
     yyyy-MM-dd HH:mm:ss. Only leads with a gclid qualify; the value of a
     won recurring customer is their annual value, a one-off their price. */
  /* Two formats. "clicks" is the legacy click-conversion template: only
     leads that carried a gclid qualify. "enhanced" is for Data Manager's
     enhanced conversions for leads: every outcome goes, with the hashed
     email and phone as match keys, so a customer whose click id was lost
     (iOS, cleared storage, phoned first) can still be matched. Google asks
     for all outcomes, attributed or not. Repeat inquiries are skipped so a
     person is not counted twice. */
  function offlineRows(leads, format) {
    var rows = [];
    leads.forEach(function (l) {
      if (l.duplicateOf) return;
      if (format !== 'enhanced' && !l.gclid) return;
      if (format === 'enhanced' && !l.gclid && !l.emailHash && !l.phoneHash) return;
      var base = { gclid: l.gclid || '', email: l.emailHash || '', phone: l.phoneHash || '' };
      if (l.booked === 'Yes') rows.push(Object.assign({}, base, { name: S.exportBookedName, at: l.bookedAt || l.at, value: '', cur: '', order: l.id + '-booked' }));
      if (l.won === 'Yes') {
        var v = parseFloat(l.perVisit);
        if (l.contract && l.contract !== 'One-off') v = v * parseFloat(l.visitsPerYear);
        rows.push(Object.assign({}, base, { name: S.exportWonName, at: l.wonAt || l.at, order: l.id + '-won',
                  value: isFinite(v) && v > 0 ? String(Math.round(v)) : '', cur: isFinite(v) && v > 0 ? 'USD' : '' }));
      }
    });
    return rows;
  }
  function bucketOf(source) {
    var s = String(source || '').toLowerCase();
    if (s === 'google ads' || /\sads$/.test(s)) return 'paid';
    if (s === 'google business profile') return 'gbp';
    if (s === 'google search' || s === 'bing search') return 'organic';
    if (s === 'phone' || s === 'lsa') return 'phone';
    if (!s || s === 'website form' || s === 'direct') return 'direct';
    return 'referral';
  }
  var BUCKET_LABEL = { paid: 'Google Ads', gbp: 'Business Profile', organic: 'Google search', referral: 'Other sites', direct: 'Direct / untagged', phone: 'Phone / LSA' };
  function money(n) {
    if (!isFinite(n)) return '—';
    return '$' + Math.round(n).toLocaleString();
  }
  function ym(iso) { return String(iso || '').slice(0, 7); }
  function monthLabel(k) {
    var d = new Date(k + '-15T00:00:00Z');
    return isNaN(d) ? k : d.toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  /* Ad spend and what it bought. Google Ads spend is matched to leads that
     came through paid clicks; Local Services spend to phone/LSA leads. A
     lead is counted in the month it arrived, so a March lead that becomes a
     customer in May still belongs to March's spend — that is the month the
     money that found them was spent. */
  function spendTotals(c, leads) {
    var sp = c.spend || {};
    var months = {};
    Object.keys(sp).forEach(function (k) { months[k] = months[k] || {}; });
    leads.forEach(function (l) { var b = bucketOf(l.source); if (b === 'paid' || b === 'phone') months[ym(l.at)] = months[ym(l.at)] || {}; });
    var keys = Object.keys(months).sort().reverse();
    var chan = { ads: { bucket: 'paid', label: 'Google Ads', spend: 0, leads: 0, booked: 0, won: 0, recurring: 0 },
                 lsa: { bucket: 'phone', label: 'Local Services Ads', spend: 0, leads: 0, booked: 0, won: 0, recurring: 0 } };
    var rows = keys.map(function (k) {
      var row = { month: k, ads: +((sp[k] || {}).ads || 0), lsa: +((sp[k] || {}).lsa || 0), leads: 0, booked: 0, won: 0, recurring: 0 };
      leads.forEach(function (l) {
        if (ym(l.at) !== k) return;
        var b = bucketOf(l.source);
        var ch = b === 'paid' ? chan.ads : b === 'phone' ? chan.lsa : null;
        if (!ch) return;
        row.leads += 1; ch.leads += 1;
        if (l.booked === 'Yes') { row.booked += 1; ch.booked += 1; }
        if (l.won === 'Yes') { row.won += 1; ch.won += 1; if (l.contract && l.contract !== 'One-off') { row.recurring += 1; ch.recurring += 1; } }
      });
      row.spend = row.ads + row.lsa;
      chan.ads.spend += row.ads; chan.lsa.spend += row.lsa;
      return row;
    });
    var total = rows.reduce(function (t, r) { t.spend += r.spend; t.leads += r.leads; t.booked += r.booked; t.won += r.won; t.recurring += r.recurring; return t; },
      { spend: 0, leads: 0, booked: 0, won: 0, recurring: 0 });
    return { rows: rows, chan: chan, total: total };
  }
  function per(spend, n) { return spend && n ? money(spend / n) : (spend ? 'none yet' : '—'); }

  function median(nums) {
    if (!nums.length) return NaN;
    var a = nums.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function minutesBetween(a, b) {
    var t = (new Date(b).getTime() - new Date(a).getTime()) / 60000;
    return isFinite(t) && t >= 0 ? t : NaN;
  }
  function fmtMins(m) {
    if (!isFinite(m)) return '—';
    if (m < 60) return Math.round(m) + ' min';
    if (m < 48 * 60) return (m / 60).toFixed(1).replace(/\.0$/, '') + ' h';
    return Math.round(m / 1440) + ' days';
  }
  function tzStamp(iso, tz) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    try {
      var p = {};
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
                                          hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
      return p.year + '-' + p.month + '-' + p.day + ' ' + (p.hour === '24' ? '00' : p.hour) + ':' + p.minute + ':' + p.second;
    } catch (e) { return d.toISOString().slice(0, 19).replace('T', ' '); }
  }
  function offlineCsv(rows, format) {
    var q = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
    var out;
    if (format === 'enhanced') {
      // Data Manager maps columns by name on upload. Email and Phone Number are
      // SHA-256 of the normalized values, as Google specifies for hashed data.
      out = ['Parameters:TimeZone=' + (S.exportTz || 'America/New_York') + ',,,,,,,',
             'Google Click ID,Email,Phone Number,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID'];
      rows.forEach(function (r) {
        out.push([r.gclid, r.email, r.phone, r.name, tzStamp(r.at, S.exportTz), r.value, r.cur, r.order].map(q).join(','));
      });
    } else {
      out = ['Parameters:TimeZone=' + (S.exportTz || 'America/New_York') + ',,,,',
             'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency'];
      rows.forEach(function (r) {
        out.push([r.gclid, r.name, tzStamp(r.at, S.exportTz), r.value, r.cur].map(q).join(','));
      });
    }
    return out.join('\r\n') + '\r\n';
  }

  function loadClients() {
    return api('GET').then(function (d) {
      S.leads = d.leads || [];
      S.visits = d.visits || {};
      S.access = d.access || {};
      S.config = d.config || {};
      S.clients = (d.onboarding || []).map(function (o) {
        o.intake = o.intake || {};
        o.phaseState = o.phaseState || {};
        o.audit = o.audit || {};
        o.spend = o.spend || {};
        // Steps are the client-facing projection; rebuild local state from them.
        var ph = E(o).phases;
        (o.steps || []).forEach(function (s, i) {
          var key = ph[i] && ph[i][0];
          if (key) o.phaseState[key] = { done: !!s.done, date: s.date || '' };
        });
        return o;
      });
      render();
    });
  }

  /* Leads arrive while the console is open — that is exactly when the owner
     is watching for them — so the live parts (leads, visits, access, mail
     config) are re-read when the Leads tab opens, when the window comes back
     into view, and once a minute while it is visible. Onboarding records are
     deliberately left alone: the intake form may be mid-edit, and only this
     console writes those anyway. Skipped while any console control has focus
     so a half-typed value is not replaced under the cursor. */
  var refreshing = false;
  function refreshLive(force) {
    if (!S.authed || refreshing) return;
    if (document.hidden && !force) return;
    var a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest && a.closest('#app')) return;
    refreshing = true;
    api('GET').then(function (d) {
      refreshing = false;
      var before = JSON.stringify([S.leads, S.visits, S.access, S.config]);
      S.leads = d.leads || [];
      S.visits = d.visits || {};
      S.access = d.access || {};
      S.config = d.config || {};
      if (JSON.stringify([S.leads, S.visits, S.access, S.config]) !== before) renderMain();
    }).catch(function (e) {
      refreshing = false;
      if (e && e.expired) expire();
    });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshLive(); });
  setInterval(function () { refreshLive(); }, 60000);

  /* Persist a client. `steps` is what the client's portal renders, so it is
     built here from the same phase list rather than stored twice. */
  function persist(c, quiet) {
    var v = decide(c);
    var steps = E(c).phases.map(function (p) {
      var st = (c.phaseState || {})[p[0]] || {};
      return { label: p[1], done: !!st.done, date: st.date || '', owner: p[3] };
    });
    var doneCount = steps.filter(function (s) { return s.done; }).length;
    var rec = {
      email: c.email,
      businessName: c.intake.businessName || c.businessName || '',
      engagement: c.engagement || 'google',
      route: v.title,
      phase: doneCount === steps.length ? 'Complete' : (v.badge || 'In progress'),
      nextAction: (steps.filter(function (s) { return !s.done; })[0] || {}).label || 'Nothing outstanding',
      steps: steps,
      intake: c.intake
    };
    // Local state kept alongside so the console does not lose audit marks that
    // the client-facing record has no place for.
    rec.audit = c.audit;
    // Ad spend by month; the portal shows the client what each customer cost.
    rec.spend = c.spend || {};
    // Resolves true only when the server actually stored it. A failed save must
    // never look like a successful one — the banner stays up until it works.
    return api('POST', { action: 'onboarding', record: rec }).then(function () {
      var had = S.saveError;
      S.saveError = '';
      if (!quiet) toast('Saved — client portal updated');
      if (had) renderMain();
      return true;
    }).catch(function (e) {
      S.expired = !!e.expired;
      S.saveError = e.expired
        ? 'Your sign-in expired, so this change was not saved. Sign in again and re-enter it — the token lasts 24 hours.'
        : e.message === 'storage-not-configured'
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
    // The portal owns sign-in and the top bar; the console only ever renders
    // for an authenticated owner. Nothing to show otherwise.
    if (!S.authed) { app.hidden = true; return; }
    app.hidden = false;

    var shell = el('div', 'shell');
    var rail = el('div', 'rail');
    rail.appendChild(el('h2', null, 'Clients'));
    var list = el('div');
    if (!S.clients.length) list.appendChild(el('div', 'note', 'No clients yet.'));
    S.clients.forEach(function (c) {
      var v = decide(c), ph = E(c).phases;
      var done = ph.filter(function (p) { return ((c.phaseState || {})[p[0]] || {}).done; }).length;
      var b = el('button', 'cbtn' + (c.email === S.sel ? ' sel' : ''));
      b.innerHTML = '<b>' + esc(c.intake.businessName || c.businessName || c.email) + '</b>' +
                    '<span>' + esc(E(c).short) + ' · ' + esc(v.badge) + ' · ' + done + '/' + ph.length + ' steps</span>';
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

  /* Session comes from the portal page that hosts this console. It hands the
     owner's token over on sign-in (or on restoring a stored session) and tells
     the console when the owner signs out. On an expired token the console
     asks the portal to show its gate again. */
  function adoptSession(ses) {
    if (!ses || !ses.token || !ses.email) return;
    S.authed = true; S.email = ses.email; S.token = ses.token;
    render();
    loadClients().catch(function (e) {
      if (e && e.expired) return expire();
      toast('Could not load clients: ' + e.message);
      render();
    });
  }
  function dropSession() {
    S.authed = false; S.token = ''; S.email = ''; S.clients = []; S.leads = []; S.sel = null; S.expired = false;
    render();
  }
  function expire() {
    dropSession();
    try { window.dispatchEvent(new CustomEvent('wolfe-os-expired')); } catch (e) {}
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

    var lt = el('label');
    lt.appendChild(el('span', null, 'Engagement'));
    var st = el('select');
    Object.keys(ENGAGEMENTS).forEach(function (k) {
      var op = el('option'); op.value = k; op.textContent = ENGAGEMENTS[k].label; st.appendChild(op);
    });
    st.value = S.newType || 'google';
    st.onchange = function () { S.newType = st.value; };
    lt.appendChild(st);
    lt.appendChild(el('span', 'hint', 'Decides the intake, the steps the client sees, and the launch checks. One engagement per client record; add a second record for a second engagement.'));

    g.appendChild(le); g.appendChild(ln); g.appendChild(lt);
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
      var c = { email: email, businessName: name, engagement: S.newType || 'google',
                intake: { businessName: name, businessType: 'field_service' },
                phaseState: {}, audit: {}, spend: {}, steps: [] };
      // Only keep it locally once the server has it. Otherwise a storage outage
      // leaves a client sitting in the rail that does not exist anywhere.
      persist(c, true).then(function (ok) {
        if (!ok) { add.disabled = false; add.textContent = 'Add client'; render(); return; }
        S.clients.push(c); S.sel = email; S.tab = 'client';
        S.adding = false; S.newEmail = ''; S.newName = ''; S.newType = 'google';
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

  // The engagement type on an existing record. Changing it swaps the intake,
  // the steps and the checks; ticks already made on the old step list are kept
  // in phaseState under their old keys and simply stop showing.
  function engagementNode(c) {
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'Engagement'));
    var g = el('div', 'grid');
    var w = el('label');
    w.appendChild(el('span', null, 'Type'));
    var sel = el('select');
    Object.keys(ENGAGEMENTS).forEach(function (k) {
      var op = el('option'); op.value = k; op.textContent = ENGAGEMENTS[k].label; sel.appendChild(op);
    });
    sel.value = c.engagement || 'google';
    sel.setAttribute('aria-label', 'Engagement type');
    sel.onchange = function () { c.engagement = sel.value; persist(c, true).then(function () { render(); }); };
    w.appendChild(sel);
    w.appendChild(el('span', 'hint', {
      google: 'Business Profile, the landing page with the estimate form, and every inquiry tracked from click to customer.',
      ai: 'A private assistant on their machine or in their account, built from their own knowledge and tested against their own questions.',
      automation: 'One process at a time: scored for suitability, built, run reviewed, then unattended once earned.'
    }[c.engagement || 'google']));
    g.appendChild(w);
    fs.appendChild(g);
    return fs;
  }

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
      var v = decide(c), ph = E(c).phases;
      var done = ph.filter(function (p) { return ((c.phaseState || {})[p[0]] || {}).done; }).length;
      btns[i].innerHTML = '<b>' + esc(c.intake.businessName || c.email) + '</b>' +
                          '<span>' + esc(v.badge) + ' · ' + done + '/' + ph.length + ' steps</span>';
    }
  }

  function verdictNode(c) {
    var v = decide(c), b = blockers(c);
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

  /* ------------------------------------------------------------- packet */
  // The document the operator actually works from during a live session: the
  // decisions already settled, the blockers, and the verification route.
  function packetMd(c) {
    var a = c.intake, v = decide(c), b = blockers(c), L = [];
    L.push('# ' + E(c).label + ' packet — ' + (a.businessName || c.email));
    L.push('Prepared ' + today());
    L.push('');
    L.push('## Recommended direction');
    L.push('');
    L.push('**' + v.title + '** (' + v.badge + ')');
    L.push('');
    L.push(v.lead.replace(/<\/?strong>/g, '**'));
    if (v.deliver.length) {
      L.push(''); L.push('**Wolfe delivers**'); L.push('');
      v.deliver.forEach(function (x) { L.push('- ' + x.replace(/<\/?strong>/g, '**')); });
    }
    if (v.next.length) {
      L.push(''); L.push('**Watch for**'); L.push('');
      v.next.forEach(function (x) { L.push('- ' + x.replace(/<\/?strong>/g, '**')); });
    }
    if (b.length) {
      L.push(''); L.push('## Resolve first'); L.push('');
      b.forEach(function (x) { L.push('- [ ] ' + x); });
    }
    E(c).packet(c, L);
    L.push(''); L.push('## Progress'); L.push('');
    E(c).phases.forEach(function (p) {
      var st = (c.phaseState || {})[p[0]] || {};
      L.push('- [' + (st.done ? 'x' : ' ') + '] ' + p[1] + (st.date ? '  (' + st.date + ')' : '')
        + (st.done ? '' : '  — ' + (p[3] === 'you' ? 'client' : p[3])));
    });
    L.push(''); L.push('## Launch checks'); L.push('');
    E(c).audit.forEach(function (x) {
      L.push('- ' + x[1] + ': ' + ((c.audit || {})[x[0]] || '—'));
    });
    return L.join('\n') + '\n';
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function slug(c) {
    return String(c.intake.businessName || c.email || 'client')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client';
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
      var v = decide(c), ph = E(c).phases;
      var steps = ph.filter(function (p) { return ((c.phaseState || {})[p[0]] || {}).done; });
      var next = null;
      for (var i = 0; i < ph.length; i++) {
        if (!((c.phaseState || {})[ph[i][0]] || {}).done) { next = ph[i]; break; }
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
        + '<span class="mono" style="font-size:10px;letter-spacing:.1em;color:var(--faint);">' + esc(E(c).short.toUpperCase()) + '</span>'
        + '<span class="chip c-' + (v.kind === 'none' ? 'none' : v.kind) + '">' + esc(v.badge) + '</span>'
        + '<span style="flex:1"></span>'
        + '<span style="font-family:\'Space Mono\',monospace;font-size:11px;color:var(--faint);">'
        + steps.length + '/' + ph.length + '</span>';
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
      warn.appendChild(el('b', null, S.expired ? 'Signed out' : 'Not saving'));
      warn.appendChild(el('div', null, S.saveError));
      if (S.expired) {
        var again = el('button', 'ghost', 'Sign in again');
        again.style.cssText += 'margin-top:10px;border-color:var(--stop);color:var(--stop);';
        again.onclick = function () { S.saveError = ''; expire(); };
        warn.appendChild(again);
      }
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
        '<p>Add one to start an engagement — Google presence, a private AI assistant, or an automation. The console holds the intake, ' +
        'works out which route fits, tracks the steps, and writes progress straight into the ' +
        "client's portal.</p>" +
        '<p>Everything here is deterministic — the same gates the checklists use. Nothing calls a model, ' +
        'so nothing is billed per click and nothing can be confidently wrong.</p>';
      m.appendChild(e);
      return;
    }

    var v = decide(c);
    var hd = el('div', 'hd');
    hd.innerHTML = '<h2>' + esc(c.intake.businessName || c.email) + '</h2>' +
                   '<span class="chip c-' + (v.kind === 'none' ? 'none' : v.kind) + '">' + esc(v.badge) + '</span>' +
                   '<span class="mono" style="font-size:10px;letter-spacing:.12em;color:var(--faint);margin-left:8px;">' + esc(E(c).label.toUpperCase()) + '</span>';
    m.appendChild(hd);
    var subLine = el('p', 'sub');
    subLine.textContent = c.email + (c.updatedAt ? ' · updated ' + c.updatedAt.slice(0, 10) : '') + ' · ';
    // Portal access: the access code the client signs in with. Set here, in
    // the same place the engagement lives, rather than on a separate page.
    var hasAccess = !!(S.access && S.access[c.email]);
    var accLbl = el('span', 'mono', hasAccess ? 'PORTAL ACCESS SET' : 'NO PORTAL ACCESS YET');
    accLbl.style.cssText = 'font-size:10px;letter-spacing:.1em;color:' + (hasAccess ? 'var(--ok)' : 'var(--warn)') + ';';
    subLine.appendChild(accLbl);
    var accBtn = el('button', 'ghost', hasAccess ? 'Reset code' : 'Give portal access');
    accBtn.style.cssText = 'margin-left:10px;padding:3px 8px;font-size:11.5px;';
    accBtn.onclick = function () { S.accessOpen = !S.accessOpen; S.accessCode = ''; S.accessMsg = ''; renderMain(); };
    subLine.appendChild(accBtn);
    m.appendChild(subLine);
    if (S.accessOpen) {
      var af = el('fieldset');
      af.appendChild(el('legend', null, 'Portal access for ' + (c.intake.businessName || c.email)));
      af.appendChild(el('p', 'note', 'They sign in at wolfeintelligence.com/portal with their email (' + c.email + ') and this code. '
        + 'Six characters or more. Setting a new one replaces the old one. Tell them the code yourself — it is not emailed.'));
      var ag = el('div', 'grid');
      var al = el('label'); al.appendChild(el('span', null, 'Access code'));
      var ai = el('input'); ai.type = 'text'; ai.autocomplete = 'off'; ai.value = S.accessCode || '';
      ai.oninput = function () { S.accessCode = ai.value; };
      al.appendChild(ai); ag.appendChild(al);
      af.appendChild(ag);
      var ab = el('div', 'bar');
      var save = el('button', 'newbtn', 'Save access code');
      save.onclick = function () {
        var code = (S.accessCode || '').trim();
        if (code.length < 6) { S.accessMsg = 'Six characters or more.'; return renderMain(); }
        save.disabled = true; save.textContent = 'Saving…';
        api('POST', { action: 'provision', email: c.email, code: code }).then(function () {
          S.access = S.access || {}; S.access[c.email] = true;
          S.accessOpen = false; S.accessCode = '';
          toast('Portal access set for ' + c.email);
          renderMain();
        }).catch(function (e) {
          save.disabled = false; save.textContent = 'Save access code';
          S.accessMsg = 'Could not save: ' + e.message; renderMain();
        });
      };
      ab.appendChild(save);
      var cancel = el('button', 'ghost', 'Cancel');
      cancel.onclick = function () { S.accessOpen = false; S.accessMsg = ''; renderMain(); };
      ab.appendChild(cancel);
      af.appendChild(ab);
      if (S.accessMsg) af.appendChild(el('div', 'err', S.accessMsg));
      m.appendChild(af);
    }

    var tabs = el('div', 'tabs');
    [['client', 'Client'], ['progress', 'Progress'], ['leads', 'Leads']]
      .forEach(function (t) {
        var b = el('button', S.tab === t[0] ? 'on' : null, t[1]);
        b.onclick = function () { S.tab = t[0]; renderMain(); if (t[0] === 'leads') refreshLive(); };
        tabs.appendChild(b);
      });
    m.appendChild(tabs);

    if (S.tab === 'client') {
      m.appendChild(engagementNode(c));
      E(c).fields.forEach(function (grp) {
        var fs = el('fieldset');
        fs.appendChild(el('legend', null, grp[0]));
        var g = el('div', 'grid');
        grp[1].forEach(function (f) { g.appendChild(fieldNode(c, f)); });
        fs.appendChild(g);
        m.appendChild(fs);
      });
      var host = el('div'); host.id = 'verdictHost'; m.appendChild(host); renderVerdict();
      var bar = el('div', 'bar');
      var save = el('button', 'ghost', 'Save now');
      save.onclick = function () { persist(c); };
      bar.appendChild(save);
      var dl = el('button', 'newbtn', 'Download packet (.md)');
      dl.onclick = function () { downloadText(slug(c) + '-packet.md', packetMd(c)); };
      bar.appendChild(dl);
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
    }

    if (S.tab === 'progress') {
      E(c).phases.forEach(function (p) {
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

      // Launch checks: the pre-handoff audit, folded in here so it lives next
      // to the steps it verifies instead of on a tab of its own.
      var lc = el('fieldset');
      lc.appendChild(el('legend', null, 'Launch checks'));
      E(c).audit.forEach(function (a) {
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
        lc.appendChild(r);
      });
      lc.appendChild(el('p', 'note',
        "Mark a row N/A with a reason when it genuinely doesn't apply — a remote business has no service area, and scoring that as a failure invents problems. The failure mode of this audit is false positives, not missed findings."));
      m.appendChild(lc);
    }

    if (S.tab === 'leads') {
      var mine = S.leads.filter(function (l) { return l.to === c.email; })
        .sort(function (a, b) { return (b.at || '').localeCompare(a.at || ''); });

      // The funnel, computed from the leads themselves. Recurring and one-off
      // are kept apart because a weekly customer is worth their annual value
      // every year and a one-off pays once — averaging the two hides which
      // kind the advertising actually bought.
      var real = mine.filter(function (l) { return !l.duplicateOf; });
      var booked = real.filter(function (l) { return l.booked === 'Yes'; }).length;
      var won = real.filter(function (l) { return l.won === 'Yes'; });
      var recurring = won.filter(function (l) { return l.contract && l.contract !== 'One-off'; });
      var annual = recurring.reduce(function (t, l) {
        var v = parseFloat(l.perVisit) * parseFloat(l.visitsPerYear);
        return t + (isFinite(v) ? v : 0);
      }, 0);
      // Speed to lead: minutes from inquiry to the first call back, on the
      // leads that have one; and how many are still waiting right now.
      var untouched = function (l) { return !l.contacted && !l.booked && !l.won; };
      var waiting = real.filter(untouched);
      var respTimes = real.map(function (l) { return l.contactedAt ? minutesBetween(l.at, l.contactedAt) : NaN; }).filter(isFinite);
      var medResp = median(respTimes);

      var sum = el('div', 'verdict');
      sum.style.borderLeftColor = waiting.length ? 'var(--warn)' : 'var(--ok)';
      sum.innerHTML =
        '<h3>' + real.length + ' lead' + (real.length === 1 ? '' : 's') + (mine.length > real.length ? ' <span style="font-weight:400;color:var(--muted);font-size:13px;">(+' + (mine.length - real.length) + ' repeat)</span>' : '') + '</h3>' +
        '<p>' + booked + ' booked an estimate &middot; ' + won.length + ' became customers &middot; ' +
        recurring.length + ' on recurring work</p>' +
        '<div style="display:flex;gap:28px;flex-wrap:wrap;">' +
        '<div><div class="lbl">Annual value of recurring customers won</div>' +
        '<div style="font-size:26px;font-weight:680;">$' + annual.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div>' +
        (function () {
          var st = spendTotals(c, real);
          if (!st.total.spend) return '';
          return '<div><div class="lbl">Cost per customer won (paid channels)</div>' +
            '<div style="font-size:26px;font-weight:680;">' + per(st.total.spend, st.total.won) + '</div>' +
            '<div class="note" style="margin:2px 0 0;">' + money(st.total.spend) + ' spent &middot; ' + per(st.total.spend, st.total.leads) + ' per inquiry</div></div>';
        })() +
        '<div><div class="lbl">Median time to call back</div><div style="font-size:26px;font-weight:680;">' + fmtMins(medResp) + '</div></div>' +
        '<div><div class="lbl">Waiting for a call back now</div><div style="font-size:26px;font-weight:680;color:' + (waiting.length ? 'var(--warn)' : 'inherit') + ';">' + waiting.length + '</div></div>' +
        '</div>' +
        (respTimes.length ? '' : '<p class="note" style="margin:8px 0 0;">Time to call back appears once a lead is marked called back — from the portal, the email link, or here.</p>');
      m.appendChild(sum);

      // Last 30 days by source: where the visits came from and what each
      // source turned into. Visits are counted by the client site's beacon;
      // phone/LSA leads have no visit and show as leads only.
      (function () {
        var since = Date.now() - 30 * 86400000;
        var v30 = (S.visits && S.visits[c.email]) || {};
        var l30 = real.filter(function (l) { return new Date(l.at).getTime() >= since; });
        var buckets = ['paid', 'gbp', 'organic', 'referral', 'direct', 'phone'];
        var any = buckets.some(function (b) { return v30[b] || l30.some(function (l) { return bucketOf(l.source) === b; }); });
        var f = el('fieldset');
        f.appendChild(el('legend', null, 'Last 30 days by source'));
        if (!any) {
          f.appendChild(el('p', 'note', 'Nothing yet. Once the client’s site is live its visits are counted here by source, next to the leads each source produced.'));
          m.appendChild(f);
          return;
        }
        var t = document.createElement('table');
        t.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
        var th = function (s, right) { return '<th style="text-align:' + (right ? 'right' : 'left') + ';padding:6px 8px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--rule);">' + s + '</th>'; };
        var td = function (s, right, dim) { return '<td style="text-align:' + (right ? 'right' : 'left') + ';padding:6px 8px;border-bottom:1px solid var(--rule);' + (dim ? 'color:var(--faint);' : '') + '">' + s + '</td>'; };
        var html = '<tr>' + th('Source') + th('Visits', 1) + th('Inquiries', 1) + th('Inquiry rate', 1) + th('Booked', 1) + th('Won', 1) + '</tr>';
        var tv = 0, tl = 0, tb = 0, tw = 0;
        buckets.forEach(function (b) {
          var ls = l30.filter(function (l) { return bucketOf(l.source) === b; });
          var vis = v30[b] || 0;
          if (!vis && !ls.length) return;
          var bk = ls.filter(function (l) { return l.booked === 'Yes'; }).length;
          var wn = ls.filter(function (l) { return l.won === 'Yes'; }).length;
          tv += vis; tl += ls.length; tb += bk; tw += wn;
          var rate = b === 'phone' ? '—' : (vis ? (100 * ls.length / vis).toFixed(1) + '%' : (ls.length ? 'no visits counted' : '—'));
          html += '<tr>' + td(esc(BUCKET_LABEL[b])) + td(b === 'phone' ? '—' : vis, 1, !vis) + td(ls.length, 1, !ls.length) + td(rate, 1, true) + td(bk, 1, !bk) + td(wn, 1, !wn) + '</tr>';
        });
        html += '<tr>' + td('<b>All</b>') + td('<b>' + tv + '</b>', 1) + td('<b>' + tl + '</b>', 1) + td(tv ? (100 * tl / tv).toFixed(1) + '%' : '—', 1, true) + td('<b>' + tb + '</b>', 1) + td('<b>' + tw + '</b>', 1) + '</tr>';
        t.innerHTML = html;
        f.appendChild(t);
        m.appendChild(f);
      })();

      // Ad spend by month, typed in here, next to what each month's money
      // bought. This replaces the lead tracker spreadsheet: the leads already
      // live here, so the spend is the only number that had nowhere to go.
      (function () {
        var f = el('fieldset');
        f.appendChild(el('legend', null, 'Ad spend and cost per result'));
        c.spend = c.spend || {};
        var st = spendTotals(c, real);
        // Always offer the current month and the two before it, so there is
        // somewhere to type before the first paid lead arrives.
        var now = new Date();
        var offer = [0, 1, 2].map(function (i) { var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); return d.toISOString().slice(0, 7); });
        var keys = st.rows.map(function (r) { return r.month; });
        offer.forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
        keys.sort().reverse();
        if (!S.spendAll) keys = keys.slice(0, 12);
        var byMonth = {};
        st.rows.forEach(function (r) { byMonth[r.month] = r; });

        var t = document.createElement('table');
        t.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
        var th = function (s, right) { return '<th style="text-align:' + (right ? 'right' : 'left') + ';padding:6px 8px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--rule);white-space:nowrap;">' + s + '</th>'; };
        var td = function (s, right, dim) { return '<td style="text-align:' + (right ? 'right' : 'left') + ';padding:4px 8px;border-bottom:1px solid var(--rule);white-space:nowrap;' + (dim ? 'color:var(--faint);' : '') + '">' + s + '</td>'; };
        var html = '<tr>' + th('Month') + th('Google Ads $', 1) + th('Local Services $', 1) + th('Paid inquiries', 1) + th('Booked', 1) + th('Won', 1) + th('Per inquiry', 1) + th('Per booked', 1) + th('Per customer', 1) + '</tr>';
        keys.forEach(function (k) {
          var r = byMonth[k] || { ads: 0, lsa: 0, leads: 0, booked: 0, won: 0, spend: 0 };
          html += '<tr data-month="' + k + '">' + td(esc(monthLabel(k))) +
            td('<input type="number" min="0" step="1" inputmode="decimal" data-spend="ads" value="' + (r.ads || '') + '" placeholder="0" aria-label="Google Ads spend ' + esc(monthLabel(k)) + '" style="width:84px;text-align:right;">', 1) +
            td('<input type="number" min="0" step="1" inputmode="decimal" data-spend="lsa" value="' + (r.lsa || '') + '" placeholder="0" aria-label="Local Services Ads spend ' + esc(monthLabel(k)) + '" style="width:84px;text-align:right;">', 1) +
            td(r.leads, 1, !r.leads) + td(r.booked, 1, !r.booked) + td(r.won, 1, !r.won) +
            td(per(r.spend, r.leads), 1, true) + td(per(r.spend, r.booked), 1, true) + td(per(r.spend, r.won), 1, true) + '</tr>';
        });
        var tt = st.total;
        html += '<tr>' + td('<b>All time</b>') + td('<b>' + money(st.chan.ads.spend) + '</b>', 1) + td('<b>' + money(st.chan.lsa.spend) + '</b>', 1) +
          td('<b>' + tt.leads + '</b>', 1) + td('<b>' + tt.booked + '</b>', 1) + td('<b>' + tt.won + '</b>', 1) +
          td('<b>' + per(tt.spend, tt.leads) + '</b>', 1) + td('<b>' + per(tt.spend, tt.booked) + '</b>', 1) + td('<b>' + per(tt.spend, tt.won) + '</b>', 1) + '</tr>';
        t.innerHTML = html;
        // Type a number, tab away, it is saved — and the client's portal shows
        // the new cost per customer on its next refresh.
        t.querySelectorAll('input[data-spend]').forEach(function (inp) {
          inp.onchange = function () {
            var k = inp.closest('tr').getAttribute('data-month');
            var v = Math.round(parseFloat(inp.value) * 100) / 100;
            c.spend[k] = c.spend[k] || { ads: 0, lsa: 0 };
            c.spend[k][inp.getAttribute('data-spend')] = isFinite(v) && v >= 0 ? v : 0;
            if (!c.spend[k].ads && !c.spend[k].lsa) delete c.spend[k];
            persist(c).then(function (ok) { if (ok) renderMain(); });
          };
        });
        var wrap = el('div');
        wrap.style.overflowX = 'auto';
        wrap.appendChild(t);
        f.appendChild(wrap);
        var lines = [];
        ['ads', 'lsa'].forEach(function (k) {
          var ch = st.chan[k];
          if (!ch.spend && !ch.leads) return;
          lines.push('<strong>' + ch.label + '</strong>: ' + money(ch.spend) + ' spent &rarr; ' + ch.leads + ' inquir' + (ch.leads === 1 ? 'y' : 'ies') +
            (ch.spend ? ' (' + per(ch.spend, ch.leads) + ' each)' : '') + ', ' + ch.booked + ' booked, ' + ch.won + ' won' +
            (ch.spend ? ' (' + per(ch.spend, ch.won) + ' per customer' + (ch.recurring ? ', ' + per(ch.spend, ch.recurring) + ' per recurring customer' : '') + ')' : '') + '.');
        });
        if (lines.length) { var pl = el('p', 'note'); pl.innerHTML = lines.join('<br>'); f.appendChild(pl); }
        var foot = el('p', 'note');
        foot.innerHTML = 'Enter what each channel billed for the month; the rest is computed from the leads above. Google Ads spend is matched to leads that arrived on a paid click; '
          + 'Local Services spend to leads logged as phone / LSA. A lead counts in the month it arrived, whatever month it closed. '
          + (st.rows.length > 12 && !S.spendAll ? '<a href="#" data-spend-all>Show every month</a>' : '');
        foot.querySelectorAll('[data-spend-all]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); S.spendAll = true; renderMain(); }; });
        f.appendChild(foot);
        m.appendChild(f);
      })();

      if (S.config && S.config.notify === false) {
        var nb = el('div', 'verdict');
        nb.style.borderLeftColor = 'var(--warn)';
        nb.innerHTML = '<h3>Lead emails are off</h3><p>New inquiries are stored and shown here, but nobody is emailed. '
          + 'Set <span class="mono">RESEND_API_KEY</span> (and <span class="mono">LEAD_FROM</span>) in Vercel to turn on the '
          + 'new-inquiry email with its one-tap outcome links.</p>';
        m.appendChild(nb);
      }

      var addBar = el('div', 'bar');
      var addBtn = el('button', 'newbtn', S.addingLead ? 'Cancel' : '+ Log a lead');
      addBtn.onclick = function () { S.addingLead = !S.addingLead; S.newLead = {}; renderMain(); };
      addBar.appendChild(addBtn);
      var tracked = mine.filter(function (l) { return l.gclid; });
      var matchable = mine.filter(function (l) { return !l.duplicateOf && (l.gclid || l.emailHash || l.phoneHash); });
      var expBtn = el('button', 'newbtn', S.exportOpen ? 'Close export' : 'Export for Google Ads');
      expBtn.disabled = !matchable.length;
      expBtn.title = matchable.length ? '' : 'Nothing to export until a lead arrives with a click id, an email or a phone number.';
      expBtn.onclick = function () { S.exportOpen = !S.exportOpen; renderMain(); };
      addBar.appendChild(expBtn);
      m.appendChild(addBar);

      if (S.exportOpen) {
        var xf = el('fieldset');
        xf.appendChild(el('legend', null, 'Offline conversions for Google Ads'));
        xf.appendChild(el('p', 'note',
          'One row per outcome — an estimate booked, a customer won — uploaded in the client’s Google Ads account '
          + 'under Goals → Conversions → Uploads (Data Manager). The conversion names must match conversion actions that '
          + 'already exist there, character for character. Repeat inquiries are left out.'));
        var xg = el('div', 'grid');
        var fw = el('label'); fw.appendChild(el('span', null, 'Format'));
        var fsel = el('select');
        [['enhanced', 'Enhanced conversions for leads (click id + hashed email/phone) — every outcome'],
         ['clicks', 'Click conversions (legacy template) — click-id leads only']].forEach(function (o) {
          var op = el('option'); op.value = o[0]; op.textContent = o[1]; fsel.appendChild(op);
        });
        fsel.value = S.exportFormat;
        fsel.onchange = function () { S.exportFormat = fsel.value; renderMain(); };
        fw.appendChild(fsel); xg.appendChild(fw);
        [['exportBookedName', 'Conversion name: estimate booked'], ['exportWonName', 'Conversion name: customer won'],
         ['exportTz', 'Time zone of the Ads account (IANA)']].forEach(function (f) {
          var lw = el('label'); lw.appendChild(el('span', null, f[1]));
          var inp = el('input'); inp.type = 'text'; inp.value = S[f[0]];
          inp.oninput = function () { S[f[0]] = inp.value; };
          lw.appendChild(inp); xg.appendChild(lw);
        });
        xf.appendChild(xg);
        var pool = S.exportFormat === 'enhanced' ? matchable : tracked;
        var xrows = offlineRows(pool, S.exportFormat);
        var xb = el('div', 'bar');
        var dl = el('button', 'newbtn', 'Download ' + xrows.length + ' row' + (xrows.length === 1 ? '' : 's') + ' (.csv)');
        dl.disabled = !xrows.length;
        dl.onclick = function () {
          var csv = offlineCsv(offlineRows(pool, S.exportFormat), S.exportFormat);
          var blob = new Blob([csv], { type: 'text/csv' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (S.exportFormat === 'enhanced' ? 'enhanced-conversions-' : 'click-conversions-')
            + (c.intake.businessName || c.email).replace(/[^a-z0-9]+/gi, '-').toLowerCase()
            + '-' + new Date().toISOString().slice(0, 10) + '.csv';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        };
        xb.appendChild(dl);
        xf.appendChild(xb);
        var braidOnly = mine.filter(function (l) { return !l.gclid && (l.gbraid || l.wbraid); }).length;
        xf.appendChild(el('p', 'note',
          (xrows.length ? '' : 'No booked or won outcomes to export yet, so the file would be empty. ')
          + tracked.length + ' lead' + (tracked.length === 1 ? '' : 's') + ' carried a click id; '
          + matchable.length + ' can be matched by click id, email or phone'
          + (braidOnly && S.exportFormat !== 'enhanced' ? '; ' + braidOnly + ' carried only an iOS click id, which the legacy format cannot carry — use the enhanced format for those.' : '.')
          + ' The conversion action in Google Ads must have enhanced conversions for leads turned on for the hashed columns to be used.'));
        m.appendChild(xf);
      }

      if (S.addingLead) {
        var fs = el('fieldset');
        fs.appendChild(el('legend', null, 'Lead that came in by phone, text or LSA'));
        var g = el('div', 'grid');
        [['name', 'Name'], ['phone', 'Phone'], ['service', 'What they want'],
         ['address', 'Address'], ['source', 'Where it came from']].forEach(function (f) {
          var lw = el('label');
          lw.appendChild(el('span', null, f[1]));
          var inp = el('input');
          inp.type = 'text';
          inp.value = S.newLead[f[0]] || '';
          inp.oninput = function () { S.newLead[f[0]] = inp.value; };
          lw.appendChild(inp);
          g.appendChild(lw);
        });
        fs.appendChild(g);
        var er = el('div');
        er.style.cssText = 'color:var(--stop);font-size:13px;min-height:18px;margin-top:8px;';
        fs.appendChild(er);
        var sb = el('div', 'bar');
        var save = el('button', 'newbtn', 'Save lead');
        save.onclick = function () {
          if (!(S.newLead.name || '').trim()) { er.textContent = 'A name, at least.'; return; }
          if (!(S.newLead.phone || '').trim()) {
            er.textContent = 'A phone number, so they can be called back.';
            return;
          }
          save.disabled = true;
          save.textContent = 'Saving...';
          var rec = Object.assign({ to: c.email, source: 'phone' }, S.newLead);
          api('POST', { action: 'lead-add', lead: rec }).then(function (d) {
            S.leads.push(d.lead);
            S.addingLead = false;
            S.newLead = {};
            toast('Lead logged');
            renderMain();
          }).catch(function (e) {
            save.disabled = false;
            save.textContent = 'Save lead';
            er.textContent = 'Could not save: ' + e.message;
          });
        };
        sb.appendChild(save);
        fs.appendChild(sb);
        m.appendChild(fs);
      }

      if (!mine.length) {
        m.appendChild(el('p', 'note',
          'No leads yet. They arrive here two ways: posted by a form on the client’s site, '
          + 'or logged by hand when someone phones or comes through Local Services Ads.'));
      }

      mine.forEach(function (l) {
        var r = el('div', 'row');
        r.style.flexDirection = 'column';
        r.style.gap = '8px';

        var top = el('div');
        top.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;width:100%;';
        var isWaiting = untouched(l);
        top.innerHTML = '<b style="font-size:15px;">' + esc(l.name || '(no name)') + '</b>'
          + '<span style="color:var(--muted);font-size:13px;">' + esc(l.phone || l.email || '') + '</span>'
          + (l.duplicateOf ? '<span class="mono" style="font-size:10px;color:var(--warn);">REPEAT</span>' : '')
          + (l.smsOk === 'Yes' ? '<span class="mono" style="font-size:10px;color:var(--faint);">OK TO TEXT</span>' : '')
          + '<span style="flex:1"></span>'
          + '<span class="mono" style="font-size:10.5px;color:var(--faint);">'
          + esc((l.source || 'unknown').toUpperCase()) + (l.gclid ? ' &middot; TRACKED' : '') + '</span>'
          + (isWaiting
            ? '<span class="mono" style="font-size:10.5px;color:var(--warn);">WAITING ' + esc(fmtMins(minutesBetween(l.at, new Date().toISOString())).toUpperCase()) + '</span>'
            : '<span class="mono" style="font-size:10.5px;color:var(--faint);">' + esc((l.at || '').slice(0, 10)) + '</span>');
        if (isWaiting) r.style.borderLeft = '3px solid var(--warn)';
        r.appendChild(top);

        var bits = [l.service, l.address, l.preferred ? 'prefers ' + l.preferred : ''].filter(Boolean);
        if (bits.length) {
          var d2 = el('div');
          d2.style.cssText = 'font-size:13px;color:var(--muted);';
          d2.textContent = bits.join(' · ');
          r.appendChild(d2);
        }
        if (l.notes) {
          var d3 = el('div');
          d3.style.cssText = 'font-size:13px;color:var(--muted);white-space:pre-wrap;';
          d3.textContent = '“' + l.notes + '”';
          r.appendChild(d3);
        }
        var prov = [];
        if (l.utm && (l.utm.campaign || l.utm.source)) prov.push([l.utm.source, l.utm.medium, l.utm.campaign].filter(Boolean).join(' / '));
        if (l.gclid) prov.push('gclid ' + l.gclid.slice(0, 10) + '…');
        else if (l.gbraid || l.wbraid) prov.push('iOS click id');
        if (l.landing) { try { prov.push(new URL(l.landing).pathname); } catch (e) {} }
        if (l.bookedAt) prov.push('booked ' + l.bookedAt.slice(0, 10));
        if (l.wonAt) prov.push('won ' + l.wonAt.slice(0, 10));
        if (prov.length) {
          var d4 = el('div', 'mono');
          d4.style.cssText = 'font-size:10.5px;color:var(--faint);';
          d4.textContent = prov.join('  ·  ');
          r.appendChild(d4);
        }

        var saveLead = function () {
          api('POST', { action: 'lead-update', lead: l })
            // The server stamps contactedAt / bookedAt / wonAt; take its copy
            // back so the timings show without a reload.
            .then(function (d) { if (d && d.lead) Object.assign(l, d.lead); renderMain(); })
            .catch(function (e) { toast('Could not save: ' + e.message); });
        };

        var ctrls = el('div');
        ctrls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;width:100%;';
        var mkSelect = function (label, key, opts, width) {
          var w = el('label');
          w.style.cssText = 'flex:0 0 auto;font-size:11px;gap:3px;';
          w.appendChild(el('span', null, label));
          var sel = el('select');
          sel.style.cssText = 'width:' + width + 'px;font-size:12px;';
          opts.forEach(function (o) {
            var op = el('option');
            op.value = o;
            op.textContent = o || '—';
            sel.appendChild(op);
          });
          sel.value = l[key] || '';
          sel.setAttribute('aria-label', label + ' for ' + (l.name || 'lead'));
          sel.onchange = function () { l[key] = sel.value; saveLead(); };
          w.appendChild(sel);
          return w;
        };
        ctrls.appendChild(mkSelect('Called back', 'contacted', ['', 'Yes'], 70));
        ctrls.appendChild(mkSelect('Estimate booked', 'booked', ['', 'Yes', 'No'], 78));
        ctrls.appendChild(mkSelect('Became a customer', 'won', ['', 'Yes', 'No', 'Pending'], 96));
        ctrls.appendChild(mkSelect('Contract', 'contract', ['', 'Weekly', 'Biweekly', 'Monthly', 'One-off'], 104));

        [['perVisit', 'Price per visit'], ['visitsPerYear', 'Visits per year']].forEach(function (f) {
          var w = el('label');
          w.style.cssText = 'flex:0 0 auto;font-size:11px;gap:3px;';
          w.appendChild(el('span', null, f[1]));
          var inp = el('input');
          inp.type = 'text';
          inp.style.cssText = 'width:78px;font-size:12px;';
          inp.value = l[f[0]] || '';
          inp.setAttribute('aria-label', f[1] + ' for ' + (l.name || 'lead'));
          inp.oninput = function () { l[f[0]] = inp.value; };
          inp.onchange = saveLead;
          w.appendChild(inp);
          ctrls.appendChild(w);
        });
        r.appendChild(ctrls);
        m.appendChild(r);
      });

      m.appendChild(el('p', 'note',
        'A lead marked TRACKED carried a Google click id; “Export for Google Ads” turns its booked and won '
        + 'outcomes into the offline-conversion upload file, worth doing once there is volume for Google to learn from. '
        + 'Cost per customer comes from the ad spend table above — no spreadsheet needed.'));
    }


  }

  /* ---------------------------------------------------------------- boot */
  // Hosted by the portal page. It sets window.__wolfeOs when an owner is
  // signed in (possibly before this script ran) and fires events afterwards.
  window.addEventListener('wolfe-os-session', function (e) { adoptSession(e.detail); });
  window.addEventListener('wolfe-os-signout', dropSession);
  if (window.__wolfeOs) adoptSession(window.__wolfeOs); else render();
})();
