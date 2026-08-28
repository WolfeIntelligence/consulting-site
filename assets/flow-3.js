/* The net — the second ambient layer of wolfeintelligence.com.

   Seven layers of nodes across the viewport, wired forward, with signals
   propagating left to right: something arrives at the input side, each node it
   reaches pauses while its step runs, then fires on down the wires it owns
   until it comes out the other end. It is the page saying what the business
   does without a caption.

   It replaces a single loop of eight stations. That version read as an orbit
   because it was one closed ring, and a ring is not what the work looks like.
   What survives from it is the part that was worth keeping: a signal does not
   glide through a node, it arrives, waits while the step happens, and only
   then moves on. That beat is the whole point, and there are now fifty-odd
   places it happens instead of eight.

   The awkward part of a net this size is that it wants the whole screen and
   the words are in the middle of it. So the net is not cut away around the
   text — it is dimmed there, hard, and the brighter something is the harder it
   is dimmed. Full strength out in the margins, a whisper behind a paragraph.
   Nothing is ever laid over a line of type at a weight you could read against.

   The rest is the lamplight's manners (assets/ambient.js), because the same
   objection killed an earlier version of this: motion here is meant to be
   felt, not watched. Nodes drift on incommensurate periods so the shape is
   never twice the same, a signal takes a couple of seconds to cross one wire,
   and on a phone — where there is no margin left to be generous in — the whole
   layer steps back.

   It caps at 24fps, pauses when the tab is hidden, freezes to a still for
   anyone who asked their system for less motion, and skips itself entirely on
   save-data and low-memory devices. Fixed, behind the page, no pointer. */
(function () {
  if (!document.body || document.getElementById('wolfe-flow')) return;
  var conn = navigator.connection || {};
  if (conn.saveData) return;
  var low = (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
            (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
  if (low) return;
  var reduce = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  var c = document.createElement('canvas');
  var ctx = c.getContext('2d'); if (!ctx) return;
  c.id = 'wolfe-flow'; c.setAttribute('aria-hidden', 'true');

  // Wide in the middle, narrow at the ends, the way a net is usually drawn.
  var COUNT = [7, 10, 12, 13, 13, 12, 10, 7];
  var LX = [0.04, 0.175, 0.31, 0.445, 0.575, 0.71, 0.845, 0.96];
  var L = COUNT.length;

  var AMBER = '201,161,95', LIGHT = '233,201,141';
  var STEP = 1000 / 24, W, H, DPR = 1, DIM = 1, last = 0, prev = 0, raf = 0;
  var t0 = performance.now(), age = 0, intro = 0, lin = 0, boost = 0, scrolled = 0;
  var spawn = 0, SPAWN_EVERY = 2.1, MAX_SIGNALS = 44;

  // Deterministic scatter: the net should look hand-placed, but the same way
  // on every load and every machine.
  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n += n << 3; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return n >>> 0; }

  var nodes = [], first = [], i, j, k, l;
  for (l = 0; l < L; l++) {
    first.push(nodes.length);
    for (k = 0; k < COUNT[l]; k++) {
      var h = hash(l * 131 + k * 17 + 7);
      nodes.push({
        l: l,
        bx: LX[l] + ((h % 11) - 5) * 0.0018,
        by: (k + 0.5) / COUNT[l] + (((h >>> 4) % 11) - 5) * 0.0042,
        ax: 0.0035 + ((h >>> 8) % 5) * 0.0011,
        ay: 0.0055 + ((h >>> 11) % 5) * 0.0015,
        px: 29 + ((h >>> 14) % 41),
        py: 33 + ((h >>> 17) % 47),
        x: 0, y: 0, act: 0, hold: 0, held: 0, out: []
      });
    }
  }
  var N = nodes.length;

  /* Wires. A node reaches the two nodes opposite its own position in the next
     layer, so the net fans locally instead of tangling; every so often one
     reaches further along, and those few long links are what stop it reading
     as a grid. Matching by position rather than by nearest coordinate matters:
     nearest-coordinate wiring across layers of different sizes produces long
     crossing diagonals everywhere, which looks like a mesh, not a net. */
  var edges = [];
  for (l = 0; l < L - 1; l++) {
    var a0 = first[l], b0 = first[l + 1], Cn = COUNT[l + 1];
    for (i = 0; i < COUNT[l]; i++) {
      var tgt = ((i + 0.5) / COUNT[l]) * Cn - 0.5;
      var lo = Math.floor(tgt), picks = [lo, lo + 1], hh = hash(l * 911 + i * 37);
      if (hh % 5 === 0) picks.push(lo + 2);
      else if (hh % 7 === 0) picks.push(lo - 2);
      var seen = {};
      for (k = 0; k < picks.length; k++) {
        var idx = Math.max(0, Math.min(Cn - 1, picks[k]));
        if (seen[idx]) continue;
        seen[idx] = 1;
        nodes[a0 + i].out.push(b0 + idx);
        edges.push({ a: a0 + i, b: b0 + idx, l: l });
      }
    }
  }

  var signals = [];

  function size() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = innerWidth; H = innerHeight;
    // The reading column is a fixed 1240px, so the margin the net can be
    // generous in is whatever is left over — plenty on a desktop, none on a
    // phone. Step the layer back as that margin closes.
    DIM = 0.5 + 0.5 * Math.max(0, Math.min(1, (W - 700) / 700));
    c.width = Math.ceil(W * DPR); c.height = Math.ceil(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  /* How much of itself the net is allowed at a point: all of it out in the
     margins, a third of it behind the reading column. Brighter things get this
     applied twice, so a firing node over a paragraph stays under the type
     rather than competing with it. */
  var qx = 0, qy0 = 0, qy1 = 0;
  function quiet() {
    qx = Math.min(1240, Math.max(320, W - 80)) / 2;
    qy0 = 0.12 * H; qy1 = 0.82 * H;
  }
  function calm(x, y) {
    var dx = Math.abs(x - W / 2) - qx;
    var dy = Math.max(qy0 - y, y - qy1);
    var out = Math.max(dx, dy);
    return 0.26 + 0.74 * Math.max(0, Math.min(1, (out + 30) / 110));
  }

  function place(t) {
    for (var i = 0; i < N; i++) {
      var n = nodes[i];
      n.x = (n.bx + n.ax * Math.sin(t / n.px * 6.2832)) * W;
      n.y = (n.by + n.ay * Math.cos(t / n.py * 6.2832)) * H;
    }
  }

  function fire(i, k) {
    var n = nodes[i];
    // A node mostly passes it on down one wire; now and then down two, which
    // is what makes a single input come out as a spread.
    var outs = n.out;
    if (!outs.length) return;
    var many = outs.length > 1 && hash(k * 7919 + i) % 4 === 0 ? 2 : 1;
    for (var m = 0; m < many && signals.length < MAX_SIGNALS; m++) {
      var pick = outs[(hash(k * 104729 + i * 31 + m) % outs.length)];
      signals.push({ a: i, b: pick, t: 0, sp: 0.38 + (hash(k + i + m) % 17) * 0.006 });
    }
  }

  var fireSeq = 0;
  function arrive(i) {
    var n = nodes[i];
    n.act = 1;
    // The pause while the step runs. Short, because there are a lot of them.
    n.held = n.hold = 0.30 + (hash(i * 37 + fireSeq) % 13) * 0.022;
  }

  function advance(dt) {
    // Scrolling gives the net a nudge that fades out again: the further you
    // read, the further the work has got.
    boost += (0 - boost) * Math.min(1, dt * 1.6);
    if (scrolled) { boost = Math.min(0.9, boost + scrolled * 0.0016); scrolled = 0; }
    var k = 1 + boost, i;

    for (i = 0; i < N; i++) {
      var n = nodes[i];
      if (n.hold > 0) {
        n.hold -= dt * k;
        if (n.hold <= 0) { n.hold = 0; fireSeq++; if (n.l < L - 1) fire(i, fireSeq); }
      } else {
        n.act += (0 - n.act) * Math.min(1, dt * 1.5);
      }
    }

    for (i = signals.length - 1; i >= 0; i--) {
      var s = signals[i];
      s.t += s.sp * dt * k;
      if (s.t >= 1) { signals.splice(i, 1); arrive(s.b); }
    }

    if (lin < 0.55) return;              // the net is wired before it is used
    spawn += dt * k;
    if (spawn >= SPAWN_EVERY) {
      spawn = 0; fireSeq++;
      arrive(first[0] + (hash(fireSeq * 2654435761) % COUNT[0]));
    }
  }

  // Edge alphas are bucketed so the whole net is a handful of stroked paths
  // rather than a hundred and thirteen of them.
  var BUCKETS = 5;
  function paint(now) {
    var i, b;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = DIM;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.lineWidth = 1;

    // The wires, layer by layer as the net comes up.
    var paths = []; for (b = 0; b < BUCKETS; b++) paths.push(null);
    for (i = 0; i < edges.length; i++) {
      var e = edges[i];
      var vis = Math.max(0, Math.min(1, lin * L - e.l));
      if (vis <= 0) continue;
      var na = nodes[e.a], nb = nodes[e.b];
      var f = calm((na.x + nb.x) / 2, (na.y + nb.y) / 2) * vis;
      b = Math.min(BUCKETS - 1, Math.floor(f * BUCKETS));
      if (!paths[b]) paths[b] = [];
      paths[b].push(na.x, na.y, nb.x, nb.y);
    }
    for (b = 0; b < BUCKETS; b++) {
      var pts = paths[b]; if (!pts) continue;
      ctx.beginPath();
      for (i = 0; i < pts.length; i += 4) { ctx.moveTo(pts[i], pts[i + 1]); ctx.lineTo(pts[i + 2], pts[i + 3]); }
      ctx.strokeStyle = 'rgba(' + AMBER + ',' + (0.115 * ((b + 0.5) / BUCKETS)).toFixed(4) + ')';
      ctx.stroke();
    }

    // The nodes. Quiet ones go out in bulk; the ones with something happening
    // are worth drawing on their own.
    var bulk = []; for (b = 0; b < BUCKETS; b++) bulk.push(null);
    for (i = 0; i < N; i++) {
      var n = nodes[i];
      var nv = Math.max(0, Math.min(1, lin * L - n.l + 0.4)) * intro;
      if (nv <= 0) continue;
      var cm = calm(n.x, n.y);
      if (n.act < 0.03) {
        b = Math.min(BUCKETS - 1, Math.floor(cm * nv * BUCKETS));
        if (!bulk[b]) bulk[b] = [];
        bulk[b].push(n.x, n.y);
        continue;
      }
      var a = n.act * cm * cm * nv;        // bright things get calmed twice
      ctx.beginPath(); ctx.arc(n.x, n.y, 1.5 + a * 1.3, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + AMBER + ',' + (0.18 * cm * nv + a * 0.42) + ')';
      ctx.fill();
      ctx.beginPath(); ctx.arc(n.x, n.y, 4.2 + a * 1.6, 0, 6.2832);
      ctx.strokeStyle = 'rgba(' + AMBER + ',' + (a * 0.30) + ')';
      ctx.stroke();
      // The step running, drawn as it goes round.
      if (n.hold > 0 && n.held > 0) {
        var pr = 1 - n.hold / n.held;
        ctx.beginPath(); ctx.arc(n.x, n.y, 6.4, -1.5708, -1.5708 + 6.2832 * pr);
        ctx.strokeStyle = 'rgba(' + LIGHT + ',' + (a * 0.34) + ')';
        ctx.stroke();
      }
      if (a > 0.25) {
        var g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 26);
        g.addColorStop(0, 'rgba(' + LIGHT + ',' + (a * 0.09) + ')');
        g.addColorStop(1, 'rgba(' + LIGHT + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(n.x - 26, n.y - 26, 52, 52);
      }
    }
    for (b = 0; b < BUCKETS; b++) {
      var q = bulk[b]; if (!q) continue;
      ctx.beginPath();
      for (i = 0; i < q.length; i += 2) { ctx.moveTo(q[i] + 1.5, q[i + 1]); ctx.arc(q[i], q[i + 1], 1.5, 0, 6.2832); }
      ctx.fillStyle = 'rgba(' + AMBER + ',' + (0.20 * ((b + 0.5) / BUCKETS)).toFixed(4) + ')';
      ctx.fill();
    }

    // The signals: a short bright run along the wire it is crossing. This is
    // the part that reads as something actually going somewhere.
    var sa = Math.max(0, Math.min(1, (intro - 0.5) / 0.5));
    if (sa <= 0) { ctx.globalAlpha = 1; return; }
    for (i = 0; i < signals.length; i++) {
      var s = signals[i], A = nodes[s.a], B = nodes[s.b];
      var dx = B.x - A.x, dy = B.y - A.y;
      var hx = A.x + dx * s.t, hy = A.y + dy * s.t;
      var back = Math.max(0, s.t - 0.30);
      var cm2 = calm(hx, hy), al = sa * cm2 * cm2;
      var lg = ctx.createLinearGradient(A.x + dx * back, A.y + dy * back, hx, hy);
      lg.addColorStop(0, 'rgba(' + LIGHT + ',0)');
      lg.addColorStop(1, 'rgba(' + LIGHT + ',' + (0.50 * al).toFixed(4) + ')');
      ctx.strokeStyle = lg; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(A.x + dx * back, A.y + dy * back); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, 1.7, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + LIGHT + ',' + (0.75 * al).toFixed(4) + ')';
      ctx.fill();
    }
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
  }

  function frame(now, dt) {
    age += dt;
    var t = (now - t0) / 1000;
    var e = reduce.matches ? 1 : Math.max(0, Math.min(1, (age - 0.25) / 2.6));
    intro = 1 - Math.pow(1 - e, 3);
    lin = e;                                  // the wiring comes up at an even pace
    quiet();
    place(t);
    if (dt) advance(dt);
    paint(now);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < STEP) return;
    var dt = prev ? Math.min((now - prev) / 1000, 0.1) : 0;
    prev = now; last = now - ((now - last) % STEP);
    frame(now, dt);
  }
  function start() { if (!raf && !reduce.matches && !document.hidden) { prev = 0; raf = requestAnimationFrame(loop); } }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  size(); quiet();
  // Asked for less motion: one still frame, but not a dead one — a scatter of
  // nodes mid-step, so the net reads as a net rather than a diagram.
  if (reduce.matches) {
    for (i = 0; i < N; i++) if (hash(i * 7 + 11) % 9 === 0) { nodes[i].act = 0.5 + (hash(i) % 5) * 0.1; }
    for (i = 0; i < edges.length; i += 11) signals.push({ a: edges[i].a, b: edges[i].b, t: 0.35 + (hash(i) % 5) * 0.1, sp: 0 });
  }
  frame(performance.now(), 0);
  document.body.insertBefore(c, document.body.firstChild);
  requestAnimationFrame(function () { c.classList.add('is-on'); });
  setTimeout(function () { c.classList.add('is-on'); }, 400);   // if rAF was held back
  start();
  if (reduce.addEventListener) reduce.addEventListener('change', function () { reduce.matches ? stop() : start(); });
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
  var sl = 0;
  addEventListener('scroll', function () {
    var y = window.scrollY || 0; scrolled += Math.abs(y - sl); sl = y;
  }, { passive: true });
  var rt; addEventListener('resize', function () {
    clearTimeout(rt); rt = setTimeout(function () { size(); quiet(); frame(performance.now(), 0); }, 150);
  });
})();
