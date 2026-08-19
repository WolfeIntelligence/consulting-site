/* Workspace templates: the seed shapes a new workspace starts from.
 *
 * os.js holds three complete copies of one idea — a field list, a phase list,
 * an audit list and a pile of routing logic, written out once for Google, once
 * for private AI and once for automation. This file is the same content as
 * data, so a fourth engagement type is a record rather than a fourth copy.
 *
 * Three decisions run through everything here and are worth stating once:
 *
 *   1. The intake fields are transcribed exactly — same keys, same labels, same
 *      hints, same select options in the console's inline `select:a=A|b=B`
 *      form that lib/types.js already parses. A migrated client must land on
 *      the field they filled in yesterday, not on a tidied-up version of it.
 *   2. Phases and audit items are types, not properties. A phase carries its
 *      own state (done, when, whose turn, what was noted), the client's portal
 *      renders them as a list, and engagements legitimately differ in how far
 *      they have got through the same list. As properties, Google alone would
 *      add forty-five columns to the engagement and adding a sixteenth phase
 *      would be a schema migration instead of a new record.
 *   3. Where os.js's routing logic cannot be said in the closed rule registry
 *      of lib/schema.js, it is left unsaid and named in a comment. A rule id
 *      invented here would be stored, would validate, and would silently never
 *      run — which is worse than an operator knowing they still have to think.
 *
 * One thing to know before reading the rules: `is-one-of` renders its wording
 * from the stored values, so a compiled warning reads "How rule-based it is
 * must be 5 or 4" rather than naming the choices the way the intake shows them.
 * Every rule using it here is a warning to the operator rather than something a
 * client is shown, which is the only reason that is acceptable. Anything
 * client-facing is worded by the property label instead.
 *
 * `seed` is not part of the schema and validateSchema ignores it. It carries
 * the actual phase and audit rows from os.js so a workspace created from a
 * template starts with the steps in it, rather than with an empty list and a
 * type that describes what a step would have looked like.
 */

/* ------------------------------------------------------- shared fragments */

/* Every engagement tracks its progress the same way, so the step type is built
 * once. Only the "whose turn" options differ: Google is the one engagement that
 * waits on a third party, and telling a client "waiting on Google" is a real
 * answer where "waiting on Wolfe" would be a wrong one. */
function stepType(turnOptions) {
  return {
    label: 'Step',
    plural: 'Steps',
    titleProp: 'label',
    properties: [
      { key: 'key', label: 'Short name', type: 'text', hint: 'Stays the same even if the wording changes' },
      { key: 'label', label: 'Step', type: 'text' },
      { key: 'detail', label: 'Why it matters', type: 'text' },
      { key: 'whoseTurn', label: "Whose turn it is", type: turnOptions },
      { key: 'done', label: 'Done', type: 'bool' },
      { key: 'doneOn', label: 'Date done', type: 'date' },
      { key: 'order', label: 'Position in the list', type: 'number' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    links: [
      { key: 'engagement', label: 'Engagement', to: 'engagement', cardinality: 'one', inverse: 'steps' },
    ],
    actions: [
      { key: 'markDone', label: 'Mark done', effect: 'mutate', risk: 'low', sets: { done: true }, stamps: ['doneOn'] },
      { key: 'reopen', label: 'Reopen', effect: 'mutate', risk: 'low', sets: { done: false } },
    ],
    rules: [
      { id: 'must-be-filled', property: 'label', blocks: 'save' },
    ],
  };
}

/* The pre-handoff audit. Named `check` because that is what os.js calls these
 * to the operator; they are unrelated to the compiled rule checks in schema.js,
 * which are never records. The result deliberately keeps an unanswered state:
 * "not checked" and "does not apply" are different claims, and an audit that
 * cannot tell them apart is an audit nobody trusts. */
function checkType() {
  return {
    label: 'Launch check',
    plural: 'Launch checks',
    titleProp: 'label',
    properties: [
      { key: 'key', label: 'Short name', type: 'text', hint: 'Stays the same even if the wording changes' },
      { key: 'label', label: 'What is being checked', type: 'text' },
      { key: 'detail', label: 'How to check it', type: 'text' },
      { key: 'result', label: 'Result', type: 'select:=Not checked yet|pass=Passes|fail=Fails|na=Does not apply' },
      { key: 'checkedOn', label: 'Date checked', type: 'date' },
      { key: 'evidence', label: 'What was seen', type: 'textarea', hint: 'What you actually looked at, not that you looked' },
      { key: 'order', label: 'Position in the list', type: 'number' },
    ],
    links: [
      { key: 'engagement', label: 'Engagement', to: 'engagement', cardinality: 'one', inverse: 'checks' },
    ],
    actions: [
      // Signing off a check is the moment the engagement is claimed to be safe
      // to hand over, so it is the operator's press and nobody else's.
      { key: 'pass', label: 'Mark as passing', effect: 'mutate', risk: 'medium', requiresOwner: true, sets: { result: 'pass' }, stamps: ['checkedOn'] },
      { key: 'fail', label: 'Mark as failing', effect: 'mutate', risk: 'low', sets: { result: 'fail' }, stamps: ['checkedOn'] },
    ],
    rules: [
      // Warns rather than refuses: an audit is filled in over days, and a
      // half-finished audit must still be savable. What it buys is that no
      // engagement reaches handoff with an unanswered or failing line on it.
      { id: 'is-one-of', property: 'result', choices: ['pass', 'na'], blocks: 'warn' },
    ],
  };
}

/* ------------------------------------------------------ local service work */

/* The default for a client business — lawn care, HVAC, cleaning, anything that
 * takes inquiries and drives to customers. The `inquiry` type is the one that
 * matters most: it is a superset of the lead record api/lead.js already writes,
 * so every stored lead migrates into it without a field being dropped. */
function localService() {
  return {
    types: {
      customer: {
        label: 'Customer',
        plural: 'Customers',
        titleProp: 'name',
        properties: [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'phone', label: 'Phone', type: 'phone' },
          { key: 'email', label: 'Email', type: 'email' },
          { key: 'address', label: 'Address', type: 'text' },
          { key: 'status', label: 'Status', type: 'select:active=Active|paused=Paused|former=No longer a customer' },
          { key: 'since', label: 'Customer since', type: 'date' },
          // The same three fields the lead log uses to value a won inquiry, so
          // a customer's worth is calculated one way in the whole system.
          { key: 'contract', label: 'How often', type: 'select:=Not set|Weekly=Weekly|Biweekly=Every two weeks|Monthly=Monthly|One-off=One-off' },
          { key: 'perVisit', label: 'Price per visit', type: 'money' },
          { key: 'visitsPerYear', label: 'Visits per year', type: 'number' },
        ],
        rules: [
          { id: 'must-be-filled', property: 'name', blocks: 'save' },
        ],
      },

      inquiry: {
        label: 'Inquiry',
        plural: 'Inquiries',
        titleProp: 'name',
        properties: [
          /* What the person typed. */
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'phone', label: 'Phone', type: 'phone' },
          { key: 'email', label: 'Email', type: 'email' },
          { key: 'service', label: 'What they want', type: 'text' },
          { key: 'address', label: 'Address', type: 'text' },
          { key: 'preferred', label: 'When suits them', type: 'text' },
          { key: 'notes', label: 'Anything they added', type: 'textarea' },
          // Kept as the exact stored value rather than a yes/no, because it is
          // evidence of consent to text them and gets read back as such.
          { key: 'smsOk', label: 'OK to text them', type: 'select:=Not given|Yes=Yes, they ticked the box' },

          /* Capture facts. */
          { key: 'at', label: 'When they inquired', type: 'datetime' },
          // Redundant once each client has their own workspace, but a migrated
          // lead loses nothing this way and can still be traced to the list it
          // came from if the migration ever has to be re-run.
          { key: 'to', label: 'Business this came to', type: 'email' },
          { key: 'source', label: 'Came from', type: 'text', hint: 'Worked out from the click, not typed by anyone' },
          { key: 'sourceBucket', label: 'Channel', type: 'select:paid=Paid ads|gbp=Google Business Profile|organic=Search|phone=Phone or Local Services|direct=Direct|referral=Referral' },
          // Click identifiers cannot be recovered after the fact, which is the
          // whole reason they are stored at capture rather than derived later.
          { key: 'gclid', label: 'Google click ID', type: 'text' },
          { key: 'gbraid', label: 'Google click ID (app)', type: 'text' },
          { key: 'wbraid', label: 'Google click ID (web to app)', type: 'text' },
          { key: 'utmSource', label: 'Campaign source', type: 'text' },
          { key: 'utmMedium', label: 'Campaign medium', type: 'text' },
          { key: 'utmCampaign', label: 'Campaign name', type: 'text' },
          { key: 'landing', label: 'Page they landed on', type: 'text' },
          { key: 'referrer', label: 'Page they came from', type: 'text' },
          { key: 'dwell', label: 'Seconds on the page', type: 'number', hint: 'How the form tells a person from a bot' },

          /* Set afterwards by the operator or the business owner. The three
           * outcomes keep their stored strings, because an inquiry that has
           * not been answered yet is a different thing from one that has been
           * answered No, and a yes/no field cannot hold both. */
          { key: 'contacted', label: 'Called them back', type: 'select:=Not yet|Yes=Yes' },
          { key: 'booked', label: 'Estimate booked', type: 'select:=Not yet|Yes=Yes' },
          { key: 'won', label: 'Became a customer', type: 'select:=Not yet|Yes=Yes|No=Did not go ahead' },
          { key: 'contract', label: 'How often', type: 'select:=Not set|Weekly=Weekly|Biweekly=Every two weeks|Monthly=Monthly|One-off=One-off' },
          { key: 'perVisit', label: 'Price per visit', type: 'money' },
          { key: 'visitsPerYear', label: 'Visits per year', type: 'number' },

          /* Stamped once, on the first time each outcome is reached. Google's
           * offline conversion import needs the moment the estimate was booked,
           * which is not the moment they inquired. */
          { key: 'contactedAt', label: 'When they were called back', type: 'datetime' },
          { key: 'bookedAt', label: 'When the estimate was booked', type: 'datetime' },
          { key: 'wonAt', label: 'When they became a customer', type: 'datetime' },

          /* Housekeeping. */
          { key: 'emailHash', label: 'Email fingerprint', type: 'text', hint: 'Hashed for the conversion export; never shown to anyone' },
          { key: 'phoneHash', label: 'Phone fingerprint', type: 'text', hint: 'Hashed for the conversion export; never shown to anyone' },
          { key: 'duplicateOf', label: 'Same person as', type: 'text', hint: 'Set when they already inquired in the last month' },

        /* The id this inquiry had in the original lead log. Carrying it makes the
           migration re-runnable — a second pass skips anything already here — and
           keeps a record able to say where it came from. Empty for anything
           captured after the move. */
        { key: 'legacyId', label: 'Original record id', type: 'text', hint: 'Set only for inquiries carried over from the old lead log' },        ],
        links: [
          { key: 'customer', label: 'Customer', to: 'customer', cardinality: 'one', inverse: 'inquiries' },
        ],
        actions: [
          // These four mirror the one-tap buttons in the new-inquiry email, so
          // the button, the portal and the console all record the same thing.
          { key: 'markContacted', label: 'I called them back', effect: 'mutate', risk: 'low', sets: { contacted: 'Yes' }, stamps: ['contactedAt'] },
          { key: 'markBooked', label: 'Estimate booked', effect: 'mutate', risk: 'low', sets: { contacted: 'Yes', booked: 'Yes' }, stamps: ['contactedAt', 'bookedAt'] },
          { key: 'markWon', label: 'Became a customer', effect: 'mutate', risk: 'low', sets: { contacted: 'Yes', booked: 'Yes', won: 'Yes' }, stamps: ['contactedAt', 'bookedAt', 'wonAt'] },
          { key: 'markLost', label: 'Did not go ahead', effect: 'mutate', risk: 'low', sets: { contacted: 'Yes', won: 'No' }, stamps: ['contactedAt'] },
        ],
        rules: [
          { id: 'must-be-filled', property: 'name', blocks: 'save' },
          { id: 'date-is-set', property: 'at', blocks: 'save' },
          /* NOT EXPRESSIBLE — "a phone number or an email address, at least one
           * of the two". api/lead.js enforces it at capture. The rule registry
           * has no way to say "or", and writing must-be-filled on both would
           * reject inquiries the form legitimately accepts today. */
        ],
      },

      job: {
        label: 'Job',
        plural: 'Jobs',
        titleProp: 'title',
        properties: [
          { key: 'title', label: 'Job', type: 'text', hint: 'What was done, in a few words' },
          { key: 'status', label: 'Status', type: 'select:scheduled=Scheduled|done=Done|skipped=Skipped|cancelled=Cancelled' },
          { key: 'scheduledFor', label: 'Scheduled for', type: 'date' },
          { key: 'completedOn', label: 'Finished on', type: 'date' },
          { key: 'price', label: 'Price', type: 'money' },
          { key: 'crew', label: 'Who did it', type: 'text' },
          { key: 'notes', label: 'Notes', type: 'textarea' },
        ],
        links: [
          { key: 'customer', label: 'Customer', to: 'customer', cardinality: 'one', inverse: 'jobs' },
        ],
        actions: [
          { key: 'complete', label: 'Mark finished', effect: 'mutate', risk: 'low', sets: { status: 'done' }, stamps: ['completedOn'] },
        ],
        rules: [
          { id: 'must-be-filled', property: 'title', blocks: 'save' },
        ],
      },

      /* Files hang off whatever they are about rather than living in a folder,
       * so a photo of a finished lawn is findable from the job it belongs to.
       * The links are optional and one-way on purpose: the ontology derives the
       * back-references itself, so a document does not need a matching link
       * declared on every type that might own one. */
      document: {
        label: 'File',
        plural: 'Files',
        titleProp: 'name',
        /* These are exactly the fields lib/files.js writes when a file is
         * uploaded, and nothing else creates a document. An earlier version of
         * this type described a file the way a person would (title, what it is,
         * added on) and shared not one key with the uploader, so every upload
         * was refused for naming a field the type did not have. The uploader is
         * the only writer, so the type follows the uploader. */
        properties: [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'kind', label: 'What it is', type: 'select:|photo=Photo|estimate=Estimate|invoice=Invoice|contract=Agreement|other=Something else' },
          { key: 'note', label: 'Note', type: 'text', hint: 'Why this was kept' },
          { key: 'contentType', label: 'File type', type: 'text' },
          { key: 'size', label: 'Size in bytes', type: 'number' },
          { key: 'backend', label: 'Stored in', type: 'text' },
          { key: 'checksum', label: 'Checksum', type: 'text' },
          { key: 'uploadedAt', label: 'Uploaded', type: 'datetime' },
          { key: 'uploadedBy', label: 'Uploaded by', type: 'email' },
        ],
        links: [
          { key: 'customer', label: 'Customer', to: 'customer', cardinality: 'one', inverse: 'documents' },
          { key: 'job', label: 'Job', to: 'job', cardinality: 'one', inverse: 'documents' },
        ],
        /* No must-be-filled rule on the name: the uploader derives a safe name
         * from the file itself, so a rule here could only ever refuse an upload
         * that had already been stored. */
        rules: [],
      },

      note: {
        label: 'Note',
        plural: 'Notes',
        titleProp: 'title',
        properties: [
          { key: 'title', label: 'About', type: 'text' },
          { key: 'body', label: 'Note', type: 'markdown' },
          { key: 'writtenOn', label: 'Written on', type: 'date' },
        ],
        // A note can hang off a customer, a job or an inquiry. Three optional
        // one-way links say that plainly; a single link cannot, because a link
        // points at one named type and a note is not one kind of thing.
        links: [
          { key: 'customer', label: 'Customer', to: 'customer', cardinality: 'one', inverse: 'notes' },
          { key: 'job', label: 'Job', to: 'job', cardinality: 'one', inverse: 'notes' },
          { key: 'inquiry', label: 'Inquiry', to: 'inquiry', cardinality: 'one', inverse: 'notes' },
        ],
        rules: [
          { id: 'must-be-filled', property: 'title', blocks: 'save' },
        ],
      },
    },
  };
}

/* ------------------------------------------- engagement: get found on Google */

function engagementGoogle() {
  return {
    types: {
      engagement: {
        label: 'Engagement',
        plural: 'Engagements',
        titleProp: 'businessName',
        // Transcribed from FIELDS in os.js. `group` carries the section heading
        // the console renders, so the intake keeps the running order that makes
        // it a conversation rather than a form.
        properties: [
          { key: 'businessName', label: 'Exact business name', type: 'text', hint: 'What is on the truck', group: 'Business' },
          { key: 'phone', label: 'Public phone', type: 'text', hint: '', group: 'Business' },
          { key: 'website', label: 'Website', type: 'text', hint: 'Leave blank if none', group: 'Business' },
          { key: 'whatTheyDo', label: 'What they actually do', type: 'textarea', hint: 'In their words', group: 'Business' },

          { key: 'businessType', label: 'Business shape', type: 'select:field_service=Field service (drives to customers)|storefront=Storefront|remote=Remote', hint: 'Decides which checks apply at all', group: 'Shape and coverage' },
          { key: 'baseAddress', label: 'Base address', type: 'text', hint: 'Needed for verification even when hidden', group: 'Shape and coverage' },
          { key: 'serviceArea', label: 'Service area', type: 'text', hint: 'Where the last ten jobs actually were', group: 'Shape and coverage' },
          { key: 'hours', label: 'Hours they will really answer', type: 'text', hint: '', group: 'Shape and coverage' },

          { key: 'capacity', label: 'Room for more work', type: 'select:=—|room=Real room|seasonal=Seasonal gaps|full=Full or nearly full', hint: 'Ask first', group: 'Gates' },
          { key: 'verified', label: 'Profile verified', type: 'select:=—|yes=Verified|no=Not yet|exists=Unclaimed listing exists', hint: '', group: 'Gates' },
          { key: 'signage', label: 'Name on something permanent', type: 'select:=—|yes=Yes|no=No|unsure=Unknown', hint: 'Gates the verification video', group: 'Gates' },
          { key: 'reviewsCount', label: 'Google reviews today', type: 'select:=—|none=Under 5|some=5 to 19|many=20 or more', hint: '', group: 'Gates' },
          { key: 'insurance', label: 'Liability insurance + background check', type: 'select:=—|yes=Yes|no=No|unsure=Need to check', hint: 'Gates Local Services Ads', group: 'Gates' },
          { key: 'budget', label: 'Monthly ad budget', type: 'select:=—|none=Nothing yet|low=Under $300|mid=$300 to $800|high=Over $800', hint: 'Separate from your fee', group: 'Gates' },
          { key: 'site', label: 'Website status', type: 'select:=—|none=None|social=Facebook only|real=Real site', hint: '', group: 'Gates' },
          { key: 'workType', label: 'Work they want more of', type: 'select:=—|recurring=Recurring contracts|oneoff=One-off jobs|both=Both', hint: '', group: 'Gates' },

          { key: 'category', label: 'Primary category', type: 'text', hint: 'What they mainly do, not what sounds best', group: 'Decisions to settle before the session' },
          { key: 'secondary', label: 'Secondary categories', type: 'text', hint: '', group: 'Decisions to settle before the session' },
          { key: 'description', label: 'Profile description', type: 'textarea', hint: '750 characters. You write it; read it back for a factual check', group: 'Decisions to settle before the session' },

          { key: 'googleAccount', label: 'Google account', type: 'text', hint: '', group: 'Accounts' },
          { key: 'existingListing', label: 'Existing listing found', type: 'text', hint: 'Leave blank if none', group: 'Accounts' },
        ],
        actions: [
          // The handoff is the promise that everything above it was done, which
          // is exactly the kind of claim a client may ask for and only the
          // operator may make.
          { key: 'handoff', label: 'Send the handoff', effect: 'mutate', risk: 'high', requiresOwner: true, sets: {} },
        ],
        rules: [
          /* Gates from decide_google and blockers_google that hold whatever
           * else is true, so they survive translation intact. All warn rather
           * than refuse, because os.js shows them to the operator as things to
           * deal with, never as a reason to reject the intake. */

          // capacity === 'full' — a full route means paid leads get turned away.
          { id: 'is-one-of', property: 'capacity', choices: ['room', 'seasonal'], blocks: 'warn' },
          // verified === 'exists' — claim the listing, never create a second.
          { id: 'is-one-of', property: 'verified', choices: ['yes', 'no'], blocks: 'warn' },
          // reviewsCount === 'none' — under five reviews, paid clicks land on a
          // profile that gives nobody a reason to choose them.
          { id: 'is-one-of', property: 'reviewsCount', choices: ['some', 'many'], blocks: 'warn' },
          // budget none or low — below roughly $300 there is not enough spend
          // to gather signal and the fee eats the budget.
          { id: 'is-one-of', property: 'budget', choices: ['mid', 'high'], blocks: 'warn' },
          { id: 'must-be-filled', property: 'businessName', blocks: 'save' },

          /* NOT EXPRESSIBLE — every one of these is a compound condition, and
           * the rule registry judges one property at a time on purpose. Each
           * still needs the operator to look:
           *
           *   - Not verified AND no permanent signage: verification will fail.
           *     This is the commonest cause of failure in the whole engagement.
           *   - Not verified AND signage unknown: ask before booking the
           *     session. A standing "signage must be Yes" rule would be wrong,
           *     because an already-verified profile does not need it.
           *   - Insurance unknown AND a real budget: Local Services Ads
           *     eligibility is unconfirmed, so no channel can be promised yet.
           *   - A remote business with a service area filled in: remote work
           *     has no geography to claim.
           *   - Insurance yes routes to Local Services Ads and insurance no
           *     routes to search ads plus a site. That is a branch producing a
           *     recommendation, not a pass or a refusal, so there is nothing
           *     for a rule to judge. */
        ],
      },
      step: stepType('select:wolfe=Wolfe|you=You|google=Google'),
      check: checkType(),
    },
  };
}

/* --------------------------------------------- engagement: private assistant */

function engagementAi() {
  return {
    types: {
      engagement: {
        label: 'Engagement',
        plural: 'Engagements',
        titleProp: 'businessName',
        // Transcribed from FIELDS_AI in os.js.
        properties: [
          { key: 'businessName', label: 'Business name', type: 'text', hint: '', group: 'Business' },
          { key: 'phone', label: 'Phone', type: 'text', hint: '', group: 'Business' },
          { key: 'website', label: 'Website', type: 'text', hint: 'Leave blank if none', group: 'Business' },
          { key: 'whatTheyDo', label: 'What they actually do', type: 'textarea', hint: 'In their words', group: 'Business' },

          { key: 'topTasks', label: 'The five things they want it to do', type: 'textarea', hint: 'In their words, most valuable first', group: 'The job' },
          { key: 'users', label: 'Who will use it', type: 'text', hint: 'Owner only, or the crew too', group: 'The job' },
          { key: 'champion', label: 'Who owns it and checks its answers', type: 'text', hint: 'One named person', group: 'The job' },
          { key: 'successMetric', label: 'The one number this should move', type: 'text', hint: 'Minutes a day, quotes a week, replies answered', group: 'The job' },
          { key: 'baseline', label: 'That number today', type: 'text', hint: 'Measured, not guessed', group: 'The job' },

          { key: 'knowledgeSources', label: 'Where the answers live today', type: 'textarea', hint: 'Price sheet, FAQ, old emails, a binder, someone’s head', group: 'Knowledge' },
          { key: 'knowledgeShape', label: 'Shape of that knowledge', type: 'select:=—|digital=Digital and organized|scattered=Digital but scattered|heads=Mostly on paper or in heads', hint: 'Decides whether the first weeks are building or capturing', group: 'Knowledge' },
          { key: 'updateOwner', label: 'Who keeps it current', type: 'text', hint: 'Prices change; someone has to tell it', group: 'Knowledge' },
          { key: 'evalSet', label: 'Real questions with known answers', type: 'select:=—|have=Have 20 or more|can=Can assemble them|no=Not really', hint: 'The acceptance test is built from these', group: 'Knowledge' },

          { key: 'runWhere', label: 'Where it should run', type: 'select:=—|local=Their own machine|cloud=Their own cloud account|unsure=Not decided', hint: 'Local keeps data home; an account is simpler to keep running', group: 'Where it runs' },
          { key: 'machine', label: 'The machine', type: 'text', hint: 'OS, RAM, graphics card and its memory', group: 'Where it runs' },
          { key: 'dataSensitivity', label: 'What the data contains', type: 'select:=—|none=Nothing sensitive|pii=Customer names and contact details|regulated=Health, financial or legal records', hint: 'Regulated data stays local unless their own account is cleared for it', group: 'Where it runs' },
          { key: 'mustNever', label: 'What it must never do or say', type: 'textarea', hint: 'Quote a price, promise a date, give legal or medical advice, email anyone', group: 'Where it runs' },
          { key: 'humanReview', label: 'Human review', type: 'select:=—|always=Someone reads every answer|customer=Only customer-facing answers reviewed|none=Runs on its own', hint: 'Start reviewed; loosen once the test set says so', group: 'Where it runs' },

          { key: 'learnTime', label: 'Hours a week the owner will give it', type: 'select:=—|low=Under one|mid=One or two|high=Three or more', hint: 'Below one, coaching stalls', group: 'Time' },
        ],
        actions: [
          { key: 'handoff', label: 'Send the handoff', effect: 'mutate', risk: 'high', requiresOwner: true, sets: {} },
        ],
        rules: [
          // knowledgeShape === 'heads' — the answers live in someone's head or
          // a binder, so the first weeks are capture and that is the
          // deliverable rather than a delay.
          { id: 'is-one-of', property: 'knowledgeShape', choices: ['digital', 'scattered'], blocks: 'warn' },
          // No success number is how an AI setup fails quietly: nobody can say
          // whether it worked, so nobody knows whether to keep it.
          { id: 'must-be-filled', property: 'successMetric', blocks: 'warn' },
          // Without one named person checking answers, nobody notices when it
          // drifts. os.js only raises this once there is an intake worth
          // owning; a standing warning is the closest honest translation.
          { id: 'must-be-filled', property: 'champion', blocks: 'warn' },
          { id: 'must-be-filled', property: 'businessName', blocks: 'save' },

          /* NOT EXPRESSIBLE — compound conditions, still the operator's call:
           *
           *   - Regulated records AND running in a cloud account: confirm the
           *     account's terms cover it, or run it locally.
           *   - Running locally AND no machine specification: a responsive
           *     local assistant wants a real graphics card, and a thin laptop
           *     will disappoint. A standing "machine must be filled in" rule
           *     would be wrong for a cloud engagement.
           *   - Unreviewed AND has things it must never do: keep a review step
           *     until the acceptance test proves the guardrails hold. */
        ],
      },
      step: stepType('select:wolfe=Wolfe|you=You'),
      check: checkType(),
    },
  };
}

/* ------------------------------------------------- engagement: automation */

function engagementAutomation() {
  return {
    types: {
      engagement: {
        label: 'Engagement',
        plural: 'Engagements',
        titleProp: 'businessName',
        // Transcribed from FIELDS_AUTO in os.js. The seven suitability answers
        // keep their numeric values as select keys, exactly as the console
        // stores them, because the score is the average of those numbers.
        properties: [
          { key: 'businessName', label: 'Business name', type: 'text', hint: '', group: 'Business' },
          { key: 'phone', label: 'Phone', type: 'text', hint: '', group: 'Business' },
          { key: 'website', label: 'Website', type: 'text', hint: 'Leave blank if none', group: 'Business' },
          { key: 'whatTheyDo', label: 'What they actually do', type: 'textarea', hint: 'In their words', group: 'Business' },

          { key: 'processName', label: 'The process to automate first', type: 'text', hint: 'One. The next one comes after this one works', group: 'The one process' },
          { key: 'trigger', label: 'What starts it', type: 'text', hint: 'A call, a form, a Friday, an invoice going overdue', group: 'The one process' },
          { key: 'stepsToday', label: 'The steps today, in order', type: 'textarea', hint: 'As they actually happen, not as the manual says', group: 'The one process' },
          { key: 'whoDoes', label: 'Who does it now', type: 'text', hint: '', group: 'The one process' },
          { key: 'systems', label: 'Tools it touches', type: 'text', hint: 'Email, calendar, forms, invoicing app, spreadsheets', group: 'The one process' },
          { key: 'customerFacing', label: 'Does the output reach a customer', type: 'select:=—|no=No, internal only|yes=Yes, customers see it', hint: 'Customer-facing runs stay reviewed longer', group: 'The one process' },

          { key: 'frequency', label: 'How often it runs', type: 'select:=—|5=Many times a day|4=Daily|3=A few times a week|2=Weekly|1=Monthly or rarer', hint: 'Rare processes rarely pay back', group: 'Suitability' },
          { key: 'rules', label: 'How rule-based it is', type: 'select:=—|5=Fully rule-based|4=Mostly, a few judgment calls|2=Mostly judgment|1=Pure judgment', hint: 'The heaviest weight. Judgment calls need a human or an AI-assist, not an automation', group: 'Suitability' },
          { key: 'inputs', label: 'What the inputs look like', type: 'select:=—|5=Digital and structured (forms, fields)|3=Digital but messy (free-text emails)|1=Paper, photos, voicemail', hint: 'Messy inputs may mean a form is the real fix', group: 'Suitability' },
          { key: 'stability', label: 'How often the steps change', type: 'select:=—|5=Unchanged for a year or more|3=Changes now and then|1=Changes constantly', hint: '', group: 'Suitability' },
          { key: 'errorCost', label: 'What a mistake costs', type: 'select:=—|5=Costly — money, a customer, a deadline|3=Annoying|1=Harmless', hint: 'High-cost errors are the best reason to automate, and the best reason to keep review', group: 'Suitability' },
          { key: 'access', label: 'How the tools can be reached', type: 'select:=—|5=They have integrations or an API|3=Web app only|1=Locked down or desktop-only', hint: 'Web-only means brittle; ask about exports', group: 'Suitability' },
          { key: 'exceptions', label: 'How often a human has to step in', type: 'select:=—|5=Under one run in ten|3=One to three in ten|1=More than three in ten', hint: 'Over three in ten, narrow the scope to the common path', group: 'Suitability' },

          // Derived, not asked: the average of whichever of the seven answers
          // above have been given. It is stored rather than recomputed on every
          // screen so that the score can be judged by a rule at all — the rule
          // registry reads properties of the record and nothing else.
          { key: 'suitabilityScore', label: 'Suitability score', type: 'number', hint: 'Worked out from the seven answers above, 1 to 5', group: 'Suitability' },

          { key: 'owner', label: 'Who owns it and checks the output', type: 'text', hint: 'One named person', group: 'Ownership and measure' },
          { key: 'review', label: 'Review to start with', type: 'select:=—|each=Owner approves each run|spot=Owner spot-checks|none=Unattended from day one', hint: 'Start with approval; earn unattended', group: 'Ownership and measure' },
          { key: 'minutesPer', label: 'Minutes per run today', type: 'text', hint: 'Timed, not guessed', group: 'Ownership and measure' },
          { key: 'perWeek', label: 'Runs per week today', type: 'text', hint: '', group: 'Ownership and measure' },
          { key: 'successMetric', label: 'The number this should move', type: 'text', hint: 'Hours a week back, invoices paid sooner, no missed follow-ups', group: 'Ownership and measure' },
        ],
        actions: [
          { key: 'handoff', label: 'Send the handoff', effect: 'mutate', risk: 'high', requiresOwner: true, sets: {} },
        ],
        rules: [
          // Under 2 the process is unstable, judgment-heavy or unreachable, and
          // automating it would hard-code the mess. Warns rather than refuses
          // because the score is incomplete for most of the intake's life.
          { id: 'number-at-least', property: 'suitabilityScore', threshold: 2, blocks: 'warn' },
          // Mostly judgment is not an automation. This one holds whatever else
          // is true, so it translates exactly.
          { id: 'is-one-of', property: 'rules', choices: ['5', '4'], blocks: 'warn' },
          // More than three runs in ten needing a human means the exceptions
          // become the job.
          { id: 'is-one-of', property: 'exceptions', choices: ['5', '3'], blocks: 'warn' },
          // Paper, photos or voicemail: put a form in front of it first, which
          // may be the whole win.
          { id: 'is-one-of', property: 'inputs', choices: ['5', '3'], blocks: 'warn' },
          // Locked down or desktop-only tools break screen-driving, so ask
          // about exports or an integration before promising anything.
          { id: 'is-one-of', property: 'access', choices: ['5', '3'], blocks: 'warn' },
          // Name an owner before anything is built. os.js waits until there is
          // a process described; a standing warning is the closest translation.
          { id: 'must-be-filled', property: 'owner', blocks: 'warn' },
          { id: 'must-be-filled', property: 'businessName', blocks: 'save' },

          /* NOT EXPRESSIBLE — still the operator's call:
           *
           *   - Customer-facing AND unattended from day one. Not on a first
           *     process: the owner approves each run until the exceptions are
           *     known. Two properties have to be read together to see it, and
           *     a rule reads one.
           *   - The score bands that pick a route rather than raise an alarm —
           *     2 to 3 means fix the process first, 3 to 4 means pilot it under
           *     review, above 4 means build it now. Those produce a
           *     recommendation, and a rule can only pass or fail. */
        ],
      },
      step: stepType('select:wolfe=Wolfe|you=You'),
      check: checkType(),
    },
  };
}

/* ------------------------------------------------------------------ seeds */

/* The phase and audit rows from os.js, as the records a new engagement starts
 * with. Order is explicit rather than implied by array position, because a step
 * gets inserted eventually and array position does not survive that. */
function steps(rows) {
  return rows.map(function (r, i) {
    return { key: r[0], label: r[1], detail: r[2], whoseTurn: r[3], done: false, order: (i + 1) * 10 };
  });
}
function checks(rows) {
  return rows.map(function (r, i) {
    return { key: r[0], label: r[1], detail: r[2], result: '', order: (i + 1) * 10 };
  });
}

const SEED_GOOGLE = {
  step: steps([
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
    ['handoff', 'Handoff sent', '', 'wolfe'],
  ]),
  check: checks([
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
    ['test', 'TEST LEAD passes end to end', 'Everything above can be green while this fails'],
  ]),
};

const SEED_AI = {
  step: steps([
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
    ['handoff', 'Handoff sent', '', 'wolfe'],
  ]),
  check: checks([
    ['where', 'Runs where agreed', 'On their machine or in their account; provider keys are theirs'],
    ['residue', 'Nothing of theirs left on Wolfe machines', 'Documents, exports, test transcripts'],
    ['guard', 'Guardrails hold', 'Tried the forbidden asks; it refused or handed off'],
    ['eval', 'Acceptance test at the agreed pass rate', 'Scored, not eyeballed'],
    ['restart', 'Owner can restart it unaided', 'Watched them do it'],
    ['upkeepOwner', 'Knowledge update has a named owner and a cadence', ''],
    ['metricMoved', 'Success number re-measured against the baseline', 'Two weeks in'],
  ]),
};

const SEED_AUTOMATION = {
  step: steps([
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
    ['handoff', 'Handoff sent — how to pause it, how to change it', '', 'wolfe'],
  ]),
  check: checks([
    ['ownerCan', 'Owner can pause it and see what it did', 'Watched them do it'],
    ['humanPath', 'Exceptions reach a human', 'Tried one; it did not vanish'],
    ['consent', 'Only touches accounts the owner authorized', 'Their accounts, their consent, revocable'],
    ['baselineKept', 'Baseline and re-measure recorded', 'Same numbers, same method'],
    ['customerSafe', 'Customer-facing output was reviewed before it went unattended', ''],
    ['noResidue', 'No client data left on Wolfe systems', ''],
  ]),
};

/* --------------------------------------------------------------- registry */

const TEMPLATES = [
  {
    key: 'local-service',
    label: 'Local service business',
    description: 'Customers, inquiries, jobs, files and notes. The starting shape for a lawn care, HVAC or cleaning business. Inquiries hold everything the estimate form captures, so nothing is lost when the existing lead log moves across.',
    schema: localService(),
  },
  {
    key: 'engagement-google',
    label: 'Get found and measured',
    description: 'A Google engagement: the intake, the fifteen steps from first conversation to handoff, and the eleven launch checks that have to pass before it is handed over.',
    schema: engagementGoogle(),
    seed: SEED_GOOGLE,
  },
  {
    key: 'engagement-ai',
    label: 'Private AI assistant',
    description: 'An assistant built from a business owner’s own knowledge, running on their machine or in their account. The intake, thirteen steps, and seven launch checks.',
    schema: engagementAi(),
    seed: SEED_AI,
  },
  {
    key: 'engagement-automation',
    label: 'Automation',
    description: 'One process, automated. The intake includes the seven suitability questions that decide whether it should be built at all, plus eleven steps and six launch checks.',
    schema: engagementAutomation(),
    seed: SEED_AUTOMATION,
  },
];

const BY_KEY = {};
for (const t of TEMPLATES) BY_KEY[t.key] = t;

const TEMPLATE_KEYS = TEMPLATES.map(function (t) { return t.key; });

/* A fresh copy every time. Callers edit a template into their own shape the
 * moment they have it, and two workspaces handed the same object would edit
 * each other's schema — a cross-tenant bug that would look like corruption
 * rather than like sharing. Everything here is plain JSON, so the round trip
 * is both the deepest and the cheapest copy available without a dependency. */
function get(key) {
  const t = BY_KEY[key];
  return t ? JSON.parse(JSON.stringify(t)) : null;
}

function list() {
  return TEMPLATES.map(function (t) {
    return {
      key: t.key,
      label: t.label,
      description: t.description,
      typeCount: Object.keys(t.schema.types).length,
    };
  });
}

module.exports = { TEMPLATE_KEYS, get, list };
