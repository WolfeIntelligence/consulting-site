/* Wolfe workspace browser — the screens over the object graph in api/graph.js.
 *
 * os.js is the operator's console over one client at a time. This is the other
 * half: the records themselves, for whoever is signed in, at whatever the
 * server says their role in that workspace is. It renders what the API returns
 * and nothing else — there is no sample row, no placeholder count and no
 * button that the API would then refuse, because a screen that shows work that
 * has not happened is worse than a screen that says the list is empty.
 *
 * Three rules run through the whole file:
 *
 *   Everything on screen came from the server, so everything on screen is
 *   escaped or set as text. A customer name is allowed to contain a '<'.
 *
 *   A write names the revision it read. If the record moved underneath it the
 *   save is refused and the person is told plainly; it is never retried behind
 *   their back, because a silent retry is how one person's typing overwrites
 *   another's.
 *
 *   An action's state comes from the API (`available`, `needs-approval`,
 *   `unavailable`) and decides how it is drawn. The screen never re-decides
 *   permission for itself.
 *
 * The page CSP forbids inline script and inline handlers, which is why this is
 * a separate file and why every listener is attached in code.
 *
 * Mounting: it renders into #wsapp if the page provides one, and otherwise
 * creates that element and appends it, so the browser can be added to a page
 * with a <script src="/ws.js"> and a <link href="/ws.css"> and nothing else.
 */
(function () {
  'use strict';

  var S = {
    token: '', email: '', role: '',
    view: 'picker', err: '', busy: '',
    workspaces: null,
    wsId: '', workspace: null, wsRole: '', schema: null, counts: {}, caps: null,
    type: '', rows: null, creating: false, newProps: {},
    objId: '', rec: null, draft: {}, stale: false,
    actKeys: {}, actOpen: '', actInputs: {},
    home: null, docs: null, trail: null
  };

  /* ------------------------------------------------------------ helpers */
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  // Everything on screen came from a field somebody typed into, so it goes in
  // as text — el() sets textContent, and the one place that composes markup
  // (the rail buttons) runs its values through this first.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(m) {
    var d = el('div', 'ws-toast', m);
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 2800);
  }
  // Same key twice is the same press. crypto.randomUUID is present on every
  // browser this portal supports; the fallback exists so an old one degrades to
  // a working key rather than to no key at all.
  function uuid() {
    try { return crypto.randomUUID(); } catch (e) {}
    return 'k_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }
  function when(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /* ---------------------------------------------------- property types */
  /* Mirrors lib/types.js. The server owns coercion and validation; this side
   * owns how a value is typed in and how it reads back, and the two have to
   * agree about what a type means or the same record looks different in the
   * two places it is shown. */
  var LONG = { textarea: 1, markdown: 1 };
  var POINTER = { ref: 1, refs: 1, file: 1, files: 1 };
  var DASH = '—';

  function parseInline(spec) {
    var s = String(spec || ''), i = s.indexOf(':');
    if (i < 0) return { type: s, options: null };
    var options = s.slice(i + 1).split('|').filter(function (p) { return p !== ''; }).map(function (p) {
      var j = p.indexOf('=');
      return j < 0 ? { value: p, label: p } : { value: p.slice(0, j), label: p.slice(j + 1) };
    });
    return { type: s.slice(0, i), options: options };
  }
  function property(def) {
    if (Array.isArray(def)) {
      var parsed = parseInline(def[2]);
      return { key: def[0], label: def[1], type: parsed.type || 'text', hint: def[3] || '', options: parsed.options };
    }
    var p = {}, k;
    for (k in def) if (Object.prototype.hasOwnProperty.call(def, k)) p[k] = def[k];
    if (typeof p.type === 'string' && p.type.indexOf(':') >= 0) {
      var q = parseInline(p.type);
      p.type = q.type;
      if (!p.options) p.options = q.options;
    }
    if (!p.type) p.type = 'text';
    if (!p.label) p.label = p.key;
    return p;
  }
  function isBlank(prop, v) {
    if (v == null) return true;
    if (prop.type === 'bool') return false;              // false is an answer, not a blank
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'number') return !isFinite(v);
    return String(v) === '';
  }
  function fmt(prop, v) {
    if (isBlank(prop, v)) return DASH;
    switch (prop.type) {
      case 'money': return isFinite(v) ? '$' + Math.round(v).toLocaleString('en-US') : DASH;
      case 'percent': return Math.round(v * 10) / 10 + '%';
      case 'number': return Number(v).toLocaleString('en-US');
      case 'bool': return v ? 'Yes' : 'No';
      case 'date': return String(v).slice(0, 10);
      case 'datetime': return when(v);
      case 'select': {
        var o = (prop.options || []).filter(function (x) { return x.value === v; })[0];
        return o ? o.label : String(v);
      }
      case 'multiselect': {
        var by = {};
        (prop.options || []).forEach(function (x) { by[x.value] = x.label; });
        return v.map(function (x) { return by[x] || x; }).join(', ');
      }
      case 'refs':
      case 'files': return v.length + (v.length === 1 ? ' item' : ' items');
      default: return String(v);
    }
  }

  // On a record, "2 items" tells nobody which two, so a list of references is
  // shown as what is stored rather than as a count.
  function shownValue(p, v) {
    if ((p.type === 'refs' || p.type === 'files') && !isBlank(p, v)) return v.join(', ');
    return fmt(p, v);
  }

  /* Mirrors the handful of rows in lib/authority.js that decide whether a
   * control is worth drawing at all. The server is still the authority and
   * refuses regardless of what this says; this only keeps a viewer from being
   * offered a New button that would come back refused. */
  var MAY = {
    operator: { create: 1, write: 1, upload: 1, removeFile: 1, trail: 1 },
    admin:    { create: 1, write: 1, upload: 1, removeFile: 1, trail: 1 },
    member:   { create: 1, write: 1, upload: 1, removeFile: 0, trail: 1 },
    viewer:   {}
  };
  function may(what) { return !!((MAY[S.wsRole] || {})[what]); }
  var ROLE_LABEL = { operator: 'Wolfe Intelligence', admin: 'Full access', member: 'Team access', viewer: 'View only' };

  /* --------------------------------------------------------- transport */
  function message(status, d) {
    if (d && d.text) return String(d.text);
    if (status === 401) return 'Your sign-in has expired. Sign in again to carry on.';
    if (status === 403) return 'That is not something this sign-in can do.';
    if (status === 404) return 'That is not available on this sign-in.';
    return 'Something went wrong. Nothing was changed.';
  }
  function call(op, args) {
    var body = { op: op }, k;
    if (args) for (k in args) if (Object.prototype.hasOwnProperty.call(args, k)) body[k] = args[k];
    if (body.ws == null && S.wsId && op !== 'workspaces' && op !== 'describe') body.ws = S.wsId;
    return fetch('/api/graph', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + S.token },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.ok) return d;
        var e = new Error(message(r.status, d));
        e.status = r.status;
        e.stale = (d && d.error) === 'stale';
        e.expired = r.status === 401;
        throw e;
      });
    }, function () {
      throw new Error('Could not reach the server. Check your connection and try again.');
    });
  }
  // One place decides what a failed call does to the screen, so an expired
  // token reads the same everywhere instead of three different sentences.
  function failed(e) {
    S.busy = '';
    S.err = e && e.message ? e.message : 'Something went wrong. Nothing was changed.';
    if (e && e.expired) {
      S.token = '';
      try { window.dispatchEvent(new CustomEvent('wolfe-os-expired')); } catch (x) {}
    }
    render();
  }

  /* ------------------------------------------------------------ loading */
  function loadWorkspaces() {
    S.busy = 'workspaces';
    return call('workspaces', {}).then(function (d) {
      S.busy = '';
      S.workspaces = (d.workspaces || []).filter(function (w) { return !w.archived; });
      // One workspace is not a choice, so it is not presented as one.
      if (S.workspaces.length === 1) return openWorkspace(S.workspaces[0].id);
      S.view = 'picker';
      render();
    }, failed);
  }

  function openWorkspace(id) {
    S.wsId = id; S.busy = 'workspace'; S.err = ''; S.workspace = null;
    S.type = ''; S.rows = null; S.rec = null; S.objId = ''; S.docs = null; S.trail = null; S.home = null;
    render();
    return call('workspace.get', { ws: id }).then(function (d) {
      S.busy = '';
      S.workspace = d.workspace || null;
      S.wsRole = d.role || '';
      S.schema = d.schema || { types: {} };
      S.counts = d.counts || {};
      S.view = 'home';
      render();
      loadHome();
      // What the storage layer can actually take, asked once per workspace, so
      // the documents screen states the real limit instead of a typed-in number.
      if (!S.caps) call('describe', {}).then(function (c) { S.caps = c.files || null; }, function () {});
    }, function (e) {
      // A workspace that will not open leaves the person somewhere they can act
      // from, rather than on a screen that says "Opening…" forever.
      if (S.workspaces && S.workspaces.length > 1) { S.view = 'picker'; S.wsId = ''; }
      failed(e);
    });
  }

  function typeKeys() {
    var t = (S.schema && S.schema.types) || {};
    return Object.keys(t).filter(function (k) { return k !== 'document'; });
  }
  function typeDef(k) { return ((S.schema && S.schema.types) || {})[k] || {}; }
  function plural(k) { var t = typeDef(k); return t.plural || t.label || k; }
  function titleOf(k, obj) {
    var t = typeDef(k), v = t.titleProp ? (obj.props || {})[t.titleProp] : null;
    if (v) return String(v).slice(0, 160);
    return (t.label || k) + ' ' + String(obj.id).slice(-6);
  }

  /* The home screen reads the most recent records in each list that has any.
   * Capped, because a workspace home is a glance and not a report — and the
   * cap is stated on screen rather than left for someone to discover. */
  var HOME_TYPES = 6, HOME_ROWS = 20;
  function loadHome() {
    var keys = typeKeys().filter(function (k) { return (S.counts[k] || 0) > 0; }).slice(0, HOME_TYPES);
    if (!keys.length) { S.home = { groups: [], capped: false }; render(); return; }
    Promise.all(keys.map(function (k) {
      return call('objects.list', { type: k, limit: HOME_ROWS }).then(function (d) {
        return { type: k, objects: d.objects || [] };
      }, function () { return { type: k, objects: [] }; });
    })).then(function (groups) {
      S.home = { groups: groups, capped: typeKeys().filter(function (k) { return (S.counts[k] || 0) > 0; }).length > HOME_TYPES };
      if (S.view === 'home') render();
    });
  }

  function openType(k) {
    S.view = 'list'; S.type = k; S.rows = null; S.creating = false; S.newProps = {}; S.err = '';
    render();
    call('objects.list', { type: k, limit: 200 }).then(function (d) {
      S.rows = d.objects || [];
      if (S.view === 'list' && S.type === k) render();
    }, failed);
  }

  function openRecord(id) {
    S.view = 'record'; S.objId = id; S.rec = null; S.draft = {}; S.stale = false;
    S.actOpen = ''; S.actInputs = {}; S.err = '';
    render();
    return call('object.get', { id: id }).then(function (d) {
      if (!d.object) { S.err = 'That record is no longer here.'; S.rec = null; render(); return; }
      // A record whose type has been retired still opens; it simply has no
      // properties, links or actions to draw, and says so.
      S.rec = { object: d.object, type: d.type || {}, links: d.links || {}, backlinks: d.backlinks || [],
                history: d.history || [], actions: d.actions || [], title: d.title || '' };
      if (S.view === 'record' && S.objId === id) render();
    }, failed);
  }

  function loadDocs() {
    S.view = 'docs'; S.docs = null; S.err = ''; render();
    if (!((S.schema && S.schema.types) || {}).document) { S.docs = []; render(); return; }
    call('objects.list', { type: 'document', limit: 200 }).then(function (d) {
      S.docs = d.objects || [];
      if (S.view === 'docs') render();
    }, failed);
  }

  function loadTrail() {
    S.view = 'trail'; S.trail = null; S.err = ''; render();
    call('audit.list', { limit: 100 }).then(function (d) {
      S.trail = d.entries || [];
      if (S.view === 'trail') render();
    }, failed);
  }

  /* -------------------------------------------------------------- shell */
  function root() {
    var n = document.getElementById('wsapp');
    if (!n) { n = el('div'); n.id = 'wsapp'; document.body.appendChild(n); }
    return n;
  }

  function render() {
    var app = root();
    app.innerHTML = '';
    // The portal owns sign-in. With no session there is nothing here to show,
    // and an empty shell would only look broken.
    if (!S.token) { app.hidden = true; return; }
    app.hidden = false;

    var top = el('div', 'top');
    top.appendChild(el('h1', null, 'RECORDS'));
    top.appendChild(el('span', 'sub', S.workspace ? S.workspace.name : 'Your workspace'));
    top.appendChild(el('span', 'spacer'));
    if (S.wsRole) top.appendChild(el('span', 'chip c-role', ROLE_LABEL[S.wsRole] || S.wsRole));
    top.appendChild(el('span', 'who', S.email));
    app.appendChild(top);

    var shell = el('div', 'shell');
    shell.appendChild(renderRail());
    var main = el('main');
    main.id = 'wsmain';
    shell.appendChild(main);
    app.appendChild(shell);
    renderMain();
  }

  function railButton(title, sub, on, fn) {
    var b = el('button', 'cbtn' + (on ? ' sel' : ''));
    b.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '');
    b.addEventListener('click', fn);
    return b;
  }

  function renderRail() {
    var rail = el('div', 'rail');
    if (!S.workspace) {
      rail.appendChild(el('h2', null, 'Workspaces'));
      return rail;
    }
    rail.appendChild(el('h2', null, 'This workspace'));
    rail.appendChild(railButton('Overview', S.workspace.name, S.view === 'home', function () {
      S.view = 'home'; render(); if (!S.home) loadHome();
    }));

    var keys = typeKeys();
    if (keys.length) {
      rail.appendChild(el('h2', null, 'Lists'));
      keys.forEach(function (k) {
        var n = S.counts[k] || 0;
        rail.appendChild(railButton(plural(k), n === 0 ? 'None yet' : n + (n === 1 ? ' record' : ' records'),
          S.view === 'list' && S.type === k, function () { openType(k); }));
      });
    }

    rail.appendChild(el('h2', null, 'Also here'));
    if (((S.schema && S.schema.types) || {}).document) {
      var dn = S.counts.document || 0;
      rail.appendChild(railButton('Documents', dn === 0 ? 'None yet' : dn + (dn === 1 ? ' file' : ' files'),
        S.view === 'docs', loadDocs));
    }
    if (may('trail')) rail.appendChild(railButton('Activity', 'Everything that happened', S.view === 'trail', loadTrail));

    if (S.workspaces && S.workspaces.length > 1) {
      var sw = el('button', 'ghost', 'Switch workspace');
      sw.style.marginTop = '10px';
      sw.addEventListener('click', function () { S.view = 'picker'; S.workspace = null; S.wsId = ''; render(); });
      rail.appendChild(sw);
    }
    var note = el('div', 'note', 'Everything here is the live record. Changes are saved to the workspace and written to the activity trail.');
    note.style.marginTop = 'auto';
    rail.appendChild(note);
    return rail;
  }

  function errBanner() {
    var b = el('div', 'blk');
    b.appendChild(el('b', null, 'That did not work'));
    b.appendChild(el('div', null, S.err));
    var ok = el('button', 'ghost', 'Dismiss');
    ok.style.marginTop = '10px';
    ok.addEventListener('click', function () { S.err = ''; render(); });
    b.appendChild(ok);
    return b;
  }

  function renderMain() {
    var m = document.getElementById('wsmain');
    if (!m) return;
    m.innerHTML = '';
    if (S.err) m.appendChild(errBanner());

    if (S.view === 'picker') return pickerScreen(m);
    if (S.busy === 'workspace' || !S.workspace) { m.appendChild(el('p', 'note', 'Opening…')); return; }
    if (S.view === 'home') return homeScreen(m);
    if (S.view === 'list') return listScreen(m);
    if (S.view === 'record') return recordScreen(m);
    if (S.view === 'docs') return docsScreen(m);
    if (S.view === 'trail') return trailScreen(m);
  }

  function heading(m, title, sub, chip) {
    var hd = el('div', 'hd');
    hd.appendChild(el('h2', null, title));
    if (chip) hd.appendChild(el('span', 'chip c-role', chip));
    m.appendChild(hd);
    if (sub) m.appendChild(el('p', 'sub', sub));
  }

  /* ------------------------------------------------------------ picker */
  function pickerScreen(m) {
    if (S.workspaces === null) { m.appendChild(el('p', 'note', 'Loading…')); return; }
    heading(m, 'Your workspaces', 'Pick the business you want to look at.');
    if (!S.workspaces.length) {
      var e = el('div', 'empty');
      e.appendChild(el('h2', null, 'No workspace yet'));
      e.appendChild(el('p', null, 'Nothing has been set up for this sign-in. Wolfe Intelligence opens a workspace when your engagement starts.'));
      m.appendChild(e);
      return;
    }
    S.workspaces.forEach(function (w) {
      var r = el('div', 'row pick');
      var t = el('div', 't');
      t.appendChild(el('b', null, w.name || w.id));
      t.appendChild(el('p', null, (ROLE_LABEL[w.role] || w.role || 'No access') + (w.kind ? ' · ' + w.kind : '')));
      r.appendChild(t);
      var b = el('button', 'newbtn', 'Open');
      b.addEventListener('click', function () { openWorkspace(w.id); });
      r.appendChild(b);
      m.appendChild(r);
    });
  }

  /* -------------------------------------------------------------- home */
  function homeScreen(m) {
    heading(m, S.workspace.name, 'Everything on record for this business.', ROLE_LABEL[S.wsRole] || S.wsRole);

    var keys = typeKeys();
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'What is on file'));
    if (!keys.length) {
      fs.appendChild(el('p', 'note', 'This workspace has no lists set up yet. Wolfe Intelligence adds them as your engagement takes shape.'));
    } else {
      var g = el('div', 'stats');
      keys.forEach(function (k) {
        var n = S.counts[k] || 0;
        var c = el('button', 'stat');
        c.appendChild(el('div', 'n', String(n)));
        c.appendChild(el('div', 'l', plural(k)));
        if (n === 0) c.appendChild(el('div', 'z', 'None yet'));
        c.addEventListener('click', function () { openType(k); });
        g.appendChild(c);
      });
      fs.appendChild(g);
    }
    m.appendChild(fs);

    if (S.home === null) { m.appendChild(el('p', 'note', 'Loading the latest…')); return; }

    var all = [];
    S.home.groups.forEach(function (grp) {
      grp.objects.forEach(function (o) { all.push({ type: grp.type, obj: o }); });
    });
    all.sort(function (a, b) { return String(b.obj.updatedAt || b.obj.at).localeCompare(String(a.obj.updatedAt || a.obj.at)); });

    var recent = el('fieldset');
    recent.appendChild(el('legend', null, 'Latest'));
    if (!all.length) {
      recent.appendChild(el('p', 'note', 'Nothing has been added to this workspace yet. When it is, the newest records show here.'));
    } else {
      all.slice(0, 8).forEach(function (row) { recent.appendChild(recordRow(row.type, row.obj)); });
    }
    m.appendChild(recent);

    // "Needs attention" is a plain fact about the records, not a judgment: a
    // required detail is missing, so somebody has to fill it in.
    var waiting = [];
    S.home.groups.forEach(function (grp) {
      var props = (typeDef(grp.type).properties || []).map(property).filter(function (p) { return p.required; });
      if (!props.length) return;
      grp.objects.forEach(function (o) {
        var missing = props.filter(function (p) { return isBlank(p, (o.props || {})[p.key]); });
        if (missing.length) waiting.push({ type: grp.type, obj: o, missing: missing });
      });
    });
    var att = el('fieldset');
    att.appendChild(el('legend', null, 'Needs attention'));
    if (!waiting.length) {
      att.appendChild(el('p', 'note', 'Nothing is waiting on a missing detail.'));
    } else {
      waiting.slice(0, 8).forEach(function (w) {
        var r = recordRow(w.type, w.obj);
        r.querySelector('.t').appendChild(el('p', 'warnline',
          'Still needed: ' + w.missing.map(function (p) { return p.label; }).join(', ')));
        att.appendChild(r);
      });
    }
    att.appendChild(el('p', 'note', 'Checked against the ' + HOME_ROWS + ' most recent records in each list' +
      (S.home.capped ? ', for the first ' + HOME_TYPES + ' lists.' : '.')));
    m.appendChild(att);
  }

  function recordRow(type, obj) {
    var r = el('div', 'row click');
    var t = el('div', 't');
    t.appendChild(el('b', null, titleOf(type, obj)));
    t.appendChild(el('p', null, (typeDef(type).label || type) + ' · updated ' + when(obj.updatedAt || obj.at)));
    r.appendChild(t);
    r.appendChild(el('span', 'go', 'Open'));
    r.addEventListener('click', function () { openRecord(obj.id); });
    return r;
  }

  /* -------------------------------------------------------------- list */
  // Two or three columns beyond the title: the first properties that read as a
  // value at a glance. Long text and pointers are skipped — they do not fit a
  // row and reading them is what the record screen is for.
  function columnsFor(k) {
    var t = typeDef(k);
    return (t.properties || []).map(property).filter(function (p) {
      return p.key !== t.titleProp && !LONG[p.type] && !POINTER[p.type];
    }).slice(0, 3);
  }

  function listScreen(m) {
    var k = S.type, t = typeDef(k);
    heading(m, plural(k), t.hint || '');

    var bar = el('div', 'bar');
    if (may('create')) {
      var nb = el('button', 'newbtn', S.creating ? 'Cancel' : 'New ' + (t.label || k));
      nb.addEventListener('click', function () { S.creating = !S.creating; S.newProps = {}; render(); });
      bar.appendChild(nb);
    }
    m.appendChild(bar);

    if (S.creating) m.appendChild(createForm(k));

    if (S.rows === null) { m.appendChild(el('p', 'note', 'Loading…')); return; }
    if (!S.rows.length) {
      var e = el('div', 'empty');
      e.appendChild(el('h2', null, 'No ' + String(plural(k)).toLowerCase() + ' yet'));
      e.appendChild(el('p', null, may('create')
        ? 'Nothing has been added to this list. Add the first one when you are ready.'
        : 'Nothing has been added to this list yet.'));
      m.appendChild(e);
      return;
    }

    var cols = columnsFor(k);
    var head = el('div', 'row rowhead');
    var ht = el('div', 't'); ht.appendChild(el('b', null, t.label || k)); head.appendChild(ht);
    cols.forEach(function (p) { head.appendChild(el('div', 'col', p.label)); });
    head.appendChild(el('div', 'col', 'Updated'));
    m.appendChild(head);

    S.rows.forEach(function (o) {
      var r = el('div', 'row click');
      var d = el('div', 't');
      d.appendChild(el('b', null, titleOf(k, o)));
      r.appendChild(d);
      cols.forEach(function (p) { r.appendChild(el('div', 'col', fmt(p, (o.props || {})[p.key]))); });
      r.appendChild(el('div', 'col', when(o.updatedAt || o.at)));
      r.addEventListener('click', function () { openRecord(o.id); });
      m.appendChild(r);
    });
    m.appendChild(el('p', 'note', S.rows.length + (S.rows.length === 1 ? ' record' : ' records') + ', newest first.'));
  }

  function createForm(k) {
    var t = typeDef(k);
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'New ' + (t.label || k)));
    var g = el('div', 'grid');
    (t.properties || []).map(property).forEach(function (p) {
      if (POINTER[p.type]) return;                 // pointers are set by linking, not by typing an id
      g.appendChild(inputFor(p, undefined, function (v) { S.newProps[p.key] = v; }));
    });
    fs.appendChild(g);
    var bar = el('div', 'bar');
    var save = el('button', 'newbtn', 'Add ' + (t.label || k));
    save.addEventListener('click', function () {
      save.disabled = true; save.textContent = 'Saving…';
      call('object.create', { type: k, props: S.newProps }).then(function (d) {
        S.creating = false; S.newProps = {};
        S.counts[k] = (S.counts[k] || 0) + 1;
        toast('Added');
        openRecord(d.object.id);
      }, function (e) {
        save.disabled = false; save.textContent = 'Add ' + (t.label || k);
        failed(e);
      });
    });
    bar.appendChild(save);
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.addEventListener('click', function () { S.creating = false; S.newProps = {}; render(); });
    bar.appendChild(cancel);
    fs.appendChild(bar);
    return fs;
  }

  /* One input per property type, and the value it hands back is in the shape
   * the API stores — an array for a multiselect, a boolean for a yes/no. */
  function inputFor(p, value, onChange) {
    var w = el('label');
    w.appendChild(el('span', null, p.label + (p.required ? ' *' : '')));
    var inp;
    if (LONG[p.type]) {
      inp = el('textarea');
      inp.value = value == null ? '' : String(value);
      inp.addEventListener('input', function () { onChange(inp.value); });
    } else if (p.type === 'select') {
      inp = el('select');
      var blank = el('option'); blank.value = ''; blank.textContent = DASH;
      inp.appendChild(blank);
      (p.options || []).forEach(function (o) {
        var op = el('option'); op.value = o.value; op.textContent = o.label; inp.appendChild(op);
      });
      inp.value = value == null ? '' : String(value);
      inp.addEventListener('change', function () { onChange(inp.value); });
    } else if (p.type === 'multiselect') {
      inp = el('select');
      inp.multiple = true;
      inp.size = Math.min(5, Math.max(2, (p.options || []).length));
      (p.options || []).forEach(function (o) {
        var op = el('option'); op.value = o.value; op.textContent = o.label;
        if (Array.isArray(value) && value.indexOf(o.value) >= 0) op.selected = true;
        inp.appendChild(op);
      });
      inp.addEventListener('change', function () {
        onChange(Array.prototype.filter.call(inp.options, function (o) { return o.selected; })
          .map(function (o) { return o.value; }));
      });
    } else if (p.type === 'bool') {
      inp = el('input'); inp.type = 'checkbox'; inp.className = 'check';
      inp.checked = !!value;
      inp.addEventListener('change', function () { onChange(inp.checked); });
    } else {
      inp = el('input');
      inp.type = p.type === 'number' || p.type === 'money' || p.type === 'percent' ? 'number'
        : p.type === 'date' ? 'date'
        : p.type === 'datetime' ? 'datetime-local'
        : p.type === 'email' ? 'email'
        : p.type === 'phone' ? 'tel'
        : p.type === 'url' ? 'url' : 'text';
      if (inp.type === 'number') inp.step = 'any';
      inp.value = p.type === 'datetime' ? localInput(value) : (value == null ? '' : String(value));
      inp.addEventListener('input', function () { onChange(inp.value); });
    }
    inp.setAttribute('aria-label', p.label);
    w.appendChild(inp);
    if (p.hint) w.appendChild(el('span', 'hint', p.hint));
    return w;
  }
  // datetime-local wants local wall-clock; the record stores UTC.
  function localInput(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ------------------------------------------------------------ record */
  function recordScreen(m) {
    if (!S.rec) { m.appendChild(el('p', 'note', 'Loading…')); return; }
    var rec = S.rec, obj = rec.object, t = rec.type || {};
    heading(m, rec.title || titleOf(obj.type, obj),
      (t.label || obj.type) + ' · added ' + when(obj.at) + ' by ' + obj.by + ' · last changed ' + when(obj.updatedAt) + ' by ' + obj.updatedBy,
      obj.archived ? 'Removed' : null);

    var back = el('div', 'bar');
    var b = el('button', 'ghost', '← Back to ' + plural(obj.type));
    b.addEventListener('click', function () { openType(obj.type); });
    back.appendChild(b);
    m.appendChild(back);

    if (S.stale) m.appendChild(staleBanner());

    propsSection(m, rec);
    linksSection(m, rec);
    backlinksSection(m, rec);
    actionsSection(m, rec);
    historySection(m, rec);
  }

  /* The one place a race actually shows up. It is stated plainly and the only
   * offer is to reload — retrying the save would overwrite whoever got there
   * first, which is the thing the revision check exists to prevent. */
  function staleBanner() {
    var b = el('div', 'blk');
    b.appendChild(el('b', null, 'Not saved'));
    b.appendChild(el('div', null, 'Somebody else changed this record while you had it open, so your change was not saved. '
      + 'Reload it to see theirs, then make your change again.'));
    var r = el('button', 'ghost', 'Reload this record');
    r.style.marginTop = '10px';
    r.addEventListener('click', function () { S.stale = false; openRecord(S.objId); });
    b.appendChild(r);
    return b;
  }

  function propsSection(m, rec) {
    var props = (rec.type.properties || []).map(property);
    var editable = may('write') && !rec.object.archived;
    var groups = [
      ['Details', props.filter(function (p) { return !LONG[p.type] && !POINTER[p.type]; })],
      ['Notes', props.filter(function (p) { return LONG[p.type]; })],
      ['Attached', props.filter(function (p) { return POINTER[p.type]; })]
    ];
    var any = false;

    groups.forEach(function (grp) {
      if (!grp[1].length) return;
      any = true;
      var fs = el('fieldset');
      fs.appendChild(el('legend', null, grp[0]));
      var g = el('div', 'grid');
      grp[1].forEach(function (p) {
        var v = (rec.object.props || {})[p.key];
        // Pointer properties are shown, never typed into: they hold record ids,
        // and the relationship they stand for is edited as a link.
        if (editable && !POINTER[p.type]) {
          g.appendChild(inputFor(p, v, function (nv) { S.draft[p.key] = nv; }));
        } else {
          var w = el('label');
          w.appendChild(el('span', null, p.label));
          w.appendChild(el('div', 'val', shownValue(p, v)));
          if (p.hint) w.appendChild(el('span', 'hint', p.hint));
          g.appendChild(w);
        }
      });
      fs.appendChild(g);
      if (grp[0] === 'Attached') {
        fs.appendChild(el('p', 'note', 'These are held on the record as references. The records themselves are under Connected records below.'));
      }
      m.appendChild(fs);
    });

    if (!any) { m.appendChild(el('p', 'note', 'This record has no details on it yet.')); return; }

    if (!editable) {
      m.appendChild(el('p', 'note', rec.object.archived
        ? 'This record has been removed, so it cannot be changed.'
        : 'Your access to this workspace is view-only, so these are shown but not editable.'));
      return;
    }
    var bar = el('div', 'bar');
    var save = el('button', 'newbtn', 'Save changes');
    save.addEventListener('click', function () { saveDraft(save); });
    bar.appendChild(save);
    var undo = el('button', 'ghost', 'Discard changes');
    undo.addEventListener('click', function () { S.draft = {}; render(); });
    bar.appendChild(undo);
    m.appendChild(bar);
  }

  function saveDraft(button) {
    var patch = {}, n = 0, k;
    for (k in S.draft) if (Object.prototype.hasOwnProperty.call(S.draft, k)) { patch[k] = S.draft[k]; n++; }
    if (!n) { toast('Nothing has been changed.'); return; }
    button.disabled = true; button.textContent = 'Saving…';
    // The revision that was on screen goes with the write. The server refuses
    // it if the record moved, and that refusal is the whole point.
    call('object.update', { id: S.objId, props: patch, rev: S.rec.object.rev }).then(function () {
      S.draft = {}; S.stale = false;
      toast('Saved');
      openRecord(S.objId);
    }, function (e) {
      button.disabled = false; button.textContent = 'Save changes';
      if (e.stale) { S.stale = true; S.err = ''; render(); return; }
      failed(e);
    });
  }

  function linksSection(m, rec) {
    var defs = (rec.type.links || []);
    if (!defs.length) return;
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'Connected records'));
    defs.forEach(function (l) {
      fs.appendChild(el('div', 'lbl', l.label || l.key));
      var rows = (rec.links || {})[l.key] || [];
      if (!rows.length) { fs.appendChild(el('p', 'note', 'None linked.')); return; }
      rows.forEach(function (o) { fs.appendChild(recordRow(o.type, o)); });
    });
    m.appendChild(fs);
  }

  /* What points at this record. The name comes from the other type's `inverse`,
   * which is why the schema insists every link has one — "Jobs for this
   * customer" is a sentence; "jobs.customer" is a key. */
  function backlinksSection(m, rec) {
    var rows = rec.backlinks || [];
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'Referred to by'));
    if (!rows.length) {
      fs.appendChild(el('p', 'note', 'Nothing else points at this record.'));
      m.appendChild(fs);
      return;
    }
    var byVia = {};
    rows.forEach(function (r) { (byVia[r.via] = byVia[r.via] || []).push(r.object); });
    Object.keys(byVia).forEach(function (via) {
      var sample = byVia[via][0];
      var srcDef = typeDef(sample.type);
      var def = (srcDef.links || []).filter(function (l) { return l.key === via; })[0] || {};
      // The inverse is the sentence; the link's own label is the fallback; and
      // if the schema has neither, the kind of record is still better than a key.
      fs.appendChild(el('div', 'lbl', def.inverse || def.label || srcDef.plural || srcDef.label || sample.type));
      byVia[via].forEach(function (o) { fs.appendChild(recordRow(o.type, o)); });
    });
    m.appendChild(fs);
  }

  /* Every action the API listed, drawn as the state it came back with. Nothing
   * here decides that a button ought to work; `available` is the only state
   * that gets one, so a press is never sent to be refused. */
  function actionsSection(m, rec) {
    var acts = rec.actions || [];
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'Things you can do'));
    if (!acts.length) {
      fs.appendChild(el('p', 'note', 'There is nothing to do on this record right now.'));
      m.appendChild(fs);
      return;
    }
    acts.forEach(function (a) {
      var row = el('div', 'act s-' + a.state);
      var t = el('div', 't');
      t.appendChild(el('b', null, a.label));
      if (a.hint) t.appendChild(el('p', null, a.hint));
      if (a.state !== 'available' && a.reason) t.appendChild(el('p', 'reason', a.reason));
      row.appendChild(t);

      if (a.state === 'available') {
        var open = S.actOpen === a.key;
        var press = el('button', 'newbtn', open ? 'Close' : (a.confirm || (a.inputs || []).length ? a.label + '…' : a.label));
        press.addEventListener('click', function () {
          // An action with inputs, or one the schema marks as needing
          // confirmation, opens in place rather than firing on the first press.
          if ((a.inputs || []).length || a.confirm) {
            S.actOpen = open ? '' : a.key;
            S.actInputs = {};
            render();
            return;
          }
          runAction(a, {}, press);
        });
        row.appendChild(press);
      } else {
        // Shown, and visibly not pressable. A disabled button still announces
        // itself to a screen reader as the thing it is, with its reason beside it.
        var dead = el('button', 'newbtn dead', a.label);
        dead.disabled = true;
        dead.setAttribute('aria-disabled', 'true');
        row.appendChild(dead);
        row.appendChild(el('span', 'pill p-' + a.state,
          a.state === 'needs-approval' ? 'Needs Wolfe Intelligence' : 'Not right now'));
      }
      fs.appendChild(row);

      if (S.actOpen === a.key && a.state === 'available') fs.appendChild(actionForm(rec, a));
    });
    m.appendChild(fs);
  }

  function actionForm(rec, a) {
    var box = el('div', 'actform');
    var byKey = {};
    (rec.type.properties || []).map(property).forEach(function (p) { byKey[p.key] = p; });
    var g = el('div', 'grid');
    (a.inputs || []).forEach(function (inp) {
      var p = byKey[inp.key];
      if (!p) return;
      var shown = { key: p.key, label: inp.label || p.label, type: p.type, hint: inp.hint || p.hint, options: p.options, required: inp.required };
      g.appendChild(inputFor(shown, (rec.object.props || {})[p.key], function (v) { S.actInputs[p.key] = v; }));
    });
    if ((a.inputs || []).length) box.appendChild(g);
    if (a.confirm) box.appendChild(el('p', 'note', 'This one is worth a second look before you press it.'));
    var bar = el('div', 'bar');
    var go = el('button', 'newbtn', a.confirm ? 'Yes, ' + a.label.toLowerCase() : a.label);
    go.addEventListener('click', function () { runAction(a, S.actInputs, go); });
    bar.appendChild(go);
    var no = el('button', 'ghost', 'Cancel');
    no.addEventListener('click', function () { S.actOpen = ''; S.actInputs = {}; render(); });
    bar.appendChild(no);
    box.appendChild(bar);
    return box;
  }

  /* One key per press, kept until that press succeeds. A retry after a timeout
   * carries the same key, so the server replays the first result instead of
   * stamping a second time. */
  function runAction(a, inputs, button) {
    if (!S.actKeys[a.key]) S.actKeys[a.key] = uuid();
    button.disabled = true; button.textContent = 'Working…';
    call('action.run', { id: S.objId, action: a.key, inputs: inputs || {}, idempotencyKey: S.actKeys[a.key] })
      .then(function (d) {
        delete S.actKeys[a.key];
        S.actOpen = ''; S.actInputs = {}; S.draft = {};
        toast(d && d.replayed ? a.label + ' was already done' : a.label + ' — done');
        openRecord(S.objId);
      }, function (e) {
        button.disabled = false; button.textContent = a.label;
        failed(e);
      });
  }

  function historySection(m, rec) {
    var rows = rec.history || [];
    var byKey = {};
    (rec.type.properties || []).map(property).forEach(function (p) { byKey[p.key] = p; });
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'History'));
    if (!rows.length) {
      fs.appendChild(el('p', 'note', 'No changes recorded yet.'));
      m.appendChild(fs);
      return;
    }
    var EVENT = { created: 'Added', updated: 'Changed', archived: 'Removed' };
    rows.forEach(function (h) {
      var r = el('div', 'hist');
      var head = el('div', 'hhead');
      head.appendChild(el('b', null, EVENT[h.event] || 'Changed'));
      head.appendChild(el('span', 'mono', 'v' + h.rev));
      head.appendChild(el('span', null, when(h.at) + ' · ' + (h.by || 'unknown')));
      r.appendChild(head);
      (h.changes || []).forEach(function (c) {
        var p = byKey[c.field] || { key: c.field, label: c.field, type: 'text' };
        r.appendChild(el('div', 'chg', p.label + ': ' + fmt(p, c.from) + ' → ' + fmt(p, c.to)));
      });
      fs.appendChild(r);
    });
    m.appendChild(fs);
  }

  /* --------------------------------------------------------- documents */
  function docsScreen(m) {
    heading(m, 'Documents', 'Files kept with this business — contracts, photos, spreadsheets.');
    if (!((S.schema && S.schema.types) || {}).document) {
      var e = el('div', 'empty');
      e.appendChild(el('h2', null, 'Documents are not switched on here'));
      e.appendChild(el('p', null, 'This workspace has no place to keep files yet. Ask Wolfe Intelligence to add one.'));
      m.appendChild(e);
      return;
    }

    if (may('upload')) m.appendChild(uploadBox());

    if (S.docs === null) { m.appendChild(el('p', 'note', 'Loading…')); return; }
    if (!S.docs.length) {
      var n = el('div', 'empty');
      n.appendChild(el('h2', null, 'No documents yet'));
      n.appendChild(el('p', null, may('upload') ? 'Nothing has been uploaded here.' : 'Nothing has been uploaded here yet.'));
      m.appendChild(n);
      return;
    }
    S.docs.forEach(function (d) {
      var p = d.props || {};
      var r = el('div', 'row');
      var t = el('div', 't');
      t.appendChild(el('b', null, p.name || 'Untitled file'));
      t.appendChild(el('p', null, kb(p.size) + ' · ' + (p.contentType || 'file') + ' · added ' + when(p.uploadedAt || d.at) + ' by ' + (p.uploadedBy || d.by)));
      if (p.note) t.appendChild(el('p', null, String(p.note)));
      r.appendChild(t);
      var get = el('button', 'ghost', 'Download');
      get.addEventListener('click', function () { download(d, get); });
      r.appendChild(get);
      if (may('removeFile')) {
        var rm = el('button', 'ghost danger', 'Remove');
        rm.addEventListener('click', function () { removeDoc(d, rm); });
        r.appendChild(rm);
      }
      m.appendChild(r);
    });
  }
  function kb(n) { return isFinite(n) && n > 0 ? Math.max(1, Math.round(n / 1024)) + ' KB' : 'unknown size'; }

  function uploadBox() {
    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'Add a document'));
    var w = el('label');
    w.appendChild(el('span', null, 'Choose a file'));
    var f = el('input');
    f.type = 'file';
    if (S.caps && S.caps.accepts) f.accept = S.caps.accepts.join(',');
    f.setAttribute('aria-label', 'Choose a file to upload');
    w.appendChild(f);
    fs.appendChild(w);
    var msg = el('div', 'err');
    fs.appendChild(msg);
    var bar = el('div', 'bar');
    var up = el('button', 'newbtn', 'Upload');
    up.addEventListener('click', function () {
      var file = f.files && f.files[0];
      if (!file) { msg.textContent = 'Pick a file first.'; return; }
      var cap = S.caps && S.caps.inlineMaxBytes;
      // Checked here as well as on the server, so a large file is refused
      // before it is read and sent rather than after.
      if (cap && file.size > cap && S.caps.largeFiles !== 'on') {
        msg.textContent = 'That file is ' + kb(file.size) + '. The limit here is ' + kb(cap) + '.';
        return;
      }
      msg.textContent = '';
      up.disabled = true; up.textContent = 'Uploading…';
      readAsBase64(file).then(function (b64) {
        return call('file.put', { name: file.name, contentType: file.type || 'application/octet-stream', dataBase64: b64 });
      }).then(function () {
        S.counts.document = (S.counts.document || 0) + 1;
        toast('Uploaded');
        loadDocs();
      }, function (e) {
        up.disabled = false; up.textContent = 'Upload';
        msg.textContent = e && e.message ? e.message : 'That upload did not go through.';
      });
    });
    bar.appendChild(up);
    fs.appendChild(bar);
    if (S.caps) {
      fs.appendChild(el('p', 'note', 'Up to ' + kb(S.caps.inlineMaxBytes) + ' per file. Documents, spreadsheets, PDFs and photos.'));
    }
    return fs;
  }

  // btoa takes a binary string, and a long one blows the argument limit, so the
  // bytes go across in chunks.
  function readAsBase64(file) {
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf), out = '', step = 8192;
      for (var i = 0; i < bytes.length; i += step) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return btoa(out);
    });
  }

  function download(doc, button) {
    button.disabled = true; button.textContent = 'Fetching…';
    call('file.get', { id: doc.id }).then(function (d) {
      var bin = atob(String(d.dataBase64 || ''));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([bytes], { type: d.contentType || 'application/octet-stream' }));
      var a = el('a');
      a.href = url;
      a.download = d.name || 'document';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      button.disabled = false; button.textContent = 'Download';
    }, function (e) {
      button.disabled = false; button.textContent = 'Download';
      failed(e);
    });
  }

  function removeDoc(doc, button) {
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = 'Really remove?';
      return;
    }
    button.disabled = true; button.textContent = 'Removing…';
    call('file.archive', { id: doc.id }).then(function () {
      S.counts.document = Math.max(0, (S.counts.document || 1) - 1);
      toast('Removed');
      loadDocs();
    }, function (e) {
      button.disabled = false; button.dataset.armed = ''; button.textContent = 'Remove';
      failed(e);
    });
  }

  /* -------------------------------------------------------------- trail */
  var TRAIL_LABEL = {
    'workspace.created': 'Workspace opened', 'workspace.renamed': 'Workspace renamed',
    'workspace.archived': 'Workspace closed',
    'member.granted': 'Access granted', 'member.revoked': 'Access removed',
    'object.created': 'Record added', 'object.updated': 'Record changed', 'object.archived': 'Record removed',
    'link.added': 'Records connected', 'link.removed': 'Connection removed',
    'action.run': 'Action completed', 'action.refused': 'Action refused',
    'file.uploaded': 'Document uploaded', 'file.archived': 'Document removed', 'file.downloaded': 'Document opened',
    'schema.updated': 'Setup changed'
  };

  function trailScreen(m) {
    heading(m, 'Activity', 'Everything that has happened in this workspace, oldest first. Nothing here can be edited or deleted.');
    if (S.trail === null) { m.appendChild(el('p', 'note', 'Loading…')); return; }
    if (!S.trail.length) {
      var e = el('div', 'empty');
      e.appendChild(el('h2', null, 'Nothing recorded yet'));
      e.appendChild(el('p', null, 'The trail fills in as work happens in this workspace.'));
      m.appendChild(e);
      return;
    }
    S.trail.forEach(function (x) {
      var r = el('div', 'trail o-' + (x.outcome || 'ok'));
      var head = el('div', 'thead');
      head.appendChild(el('b', null, TRAIL_LABEL[x.event] || 'Change'));
      if (x.label) head.appendChild(el('span', 'tlabel', x.label));
      head.appendChild(el('span', 'spacer'));
      head.appendChild(el('span', 'mono', when(x.at)));
      r.appendChild(head);
      r.appendChild(el('div', 'tby', (x.by || 'system') + (x.role ? ' · ' + (ROLE_LABEL[x.role] || x.role) : '')
        + (x.outcome && x.outcome !== 'ok' ? ' · ' + x.outcome : '')));
      if (x.detail) r.appendChild(el('div', 'chg', x.detail));
      (x.changes || []).slice(0, 6).forEach(function (c) {
        r.appendChild(el('div', 'chg', c.field + ': ' + plainValue(c.from) + ' → ' + plainValue(c.to)));
      });
      m.appendChild(r);
    });
    m.appendChild(el('p', 'note', S.trail.length + ' entries, oldest first.'));
  }
  // The trail keeps raw values and does not carry the property's type with them,
  // so they are shown as they are rather than formatted as something they may
  // not be.
  function plainValue(v) {
    if (v == null || v === '') return DASH;
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return String(v).slice(0, 120);
  }

  /* --------------------------------------------------------------- boot */
  function stored() {
    try {
      var raw = sessionStorage.getItem('wolfe-portal-auth');
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && s.token && s.email ? s : null;
    } catch (e) { return null; }
  }
  function adopt(s) {
    S.token = s.token; S.email = s.email; S.role = s.role || 'client';
    S.workspaces = null; S.err = '';
    render();
    loadWorkspaces();
  }
  function drop() {
    S.token = ''; S.email = ''; S.workspaces = null; S.workspace = null; S.wsId = '';
    S.rec = null; S.rows = null; S.docs = null; S.trail = null; S.home = null; S.err = '';
    render();
  }

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  function start() {
    var s = stored();
    if (s) adopt(s); else render();
    // The portal announces an owner session, but a client signing in changes
    // only sessionStorage — which fires no event in the tab that wrote it. So
    // the stored token is re-read on a slow tick, and the screen only changes
    // when the token itself has.
    window.addEventListener('wolfe-os-signout', drop);
    setInterval(function () {
      var now = stored();
      var tok = now ? now.token : '';
      if (tok === S.token) return;
      if (tok) adopt(now); else drop();
    }, 2000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
