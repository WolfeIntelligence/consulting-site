/* Workflow loop — the second ambient layer of wolfeintelligence.com.

   A closed circuit of stations traced around the edges of the viewport, with
   work running it: caught, sorted, answered, recorded, fed back, and round
   again. It is the page saying what the business does without a caption.

   The thing it has to get right is that it is a workflow and not a racetrack.
   So a packet does not simply orbit: it runs to the next station, slows as it
   arrives, sits there for a beat while the step happens, sets the station
   glowing and — where two stations are wired together — sends word across the
   branch, then leaves. Move, stop, work, move. That rhythm is the whole point.

   The rules it plays by are the lamplight's rules (assets/ambient.js), because
   the same objection killed an earlier version of this: motion here is meant
   to be felt, not watched. The circuit is faint, a lap takes the better part
   of a minute, the route hugs the perimeter so it stays out from under the
   reading column, and the stations drift on incommensurate periods so the
   shape is never twice the same. On a phone, where there is no perimeter to
   hide in, the whole layer steps back to texture.

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

  /* The circuit. Normalised to the viewport and deliberately hollow in the
     middle — that is where the words are. Each station drifts a little on its
     own period. `dw` is how long the step there takes, in seconds: they are
     not all the same, so the loop never falls into a metronome. */
  var NODES = [
    { x: 0.05, y: 0.25, ax: 0.012, ay: 0.016, px: 41, py: 53, dw: 1.15 },
    { x: 0.18, y: 0.085, ax: 0.011, ay: 0.012, px: 59, py: 37, dw: 0.70 },
    { x: 0.53, y: 0.115, ax: 0.014, ay: 0.016, px: 43, py: 61, dw: 1.45 },
    { x: 0.85, y: 0.22, ax: 0.012, ay: 0.014, px: 67, py: 47, dw: 0.80 },
    { x: 0.96, y: 0.55, ax: 0.014, ay: 0.012, px: 39, py: 71, dw: 1.25 },
    { x: 0.79, y: 0.88, ax: 0.016, ay: 0.014, px: 73, py: 43, dw: 0.65 },
    { x: 0.38, y: 0.94, ax: 0.014, ay: 0.016, px: 47, py: 59, dw: 1.05 },
    { x: 0.08, y: 0.71, ax: 0.012, ay: 0.014, px: 61, py: 41, dw: 0.90 }
  ];
  // Two wires that skip a station, so it reads as a workflow with branches
  // rather than a ring. When a step runs at one end, word of it travels the
  // wire and dims the other end awake. One runs down the left margin and one
  // down the right, so neither is ever laid across the words.
  var CHORDS = [[7, 1], [3, 5]];

  var SAMPLES = 34;                        // curve samples per segment
  var N = NODES.length, TOTAL = N * SAMPLES;
  var sx = new Float32Array(TOTAL), sy = new Float32Array(TOTAL);
  var nx = new Float32Array(N), ny = new Float32Array(N);
  var cum = new Float32Array(TOTAL + 1);   // arc length, for even packet speed
  var nodeAt = new Float32Array(N);        // arc distance of each station
  var act = new Float32Array(N);           // how lit each station is, 0..1
  var len = 1;

  /* A packet is held as "which station it left" plus how far along that
     segment it has got, 0..1 — not as an absolute distance. The stations
     drift and the window resizes, so an absolute distance would slide out
     from under them. */
  var PACKETS = [
    { node: 0, u: 0, hold: 0.9, sp: 0.0218 },
    { node: 2, u: 0, hold: 3.1, sp: 0.0199 },
    { node: 4, u: 0, hold: 5.8, sp: 0.0235 },
    { node: 6, u: 0, hold: 8.4, sp: 0.0207 }
  ];
  var rings = [];                          // the pulse a finished step leaves
  var wires = [];                          // word travelling a branch
  var TRAIL = 78;                          // trail length, in px of arc

  var AMBER = '201,161,95', LIGHT = '233,201,141';
  var STEP = 1000 / 24, W, H, DPR = 1, DIM = 1, last = 0, prev = 0, raf = 0;
  var t0 = performance.now(), age = 0, intro = 0, boost = 0, scrolled = 0;

  function size() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = innerWidth; H = innerHeight;
    // The reading column is a fixed 1240px, so the margin the circuit hides in
    // is whatever is left over — plenty on a desktop, none at all on a phone.
    // Step the layer back as that margin closes, rather than at one cutoff.
    DIM = 0.5 + 0.5 * Math.max(0, Math.min(1, (W - 700) / 700));
    c.width = Math.ceil(W * DPR); c.height = Math.ceil(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  /* Catmull-Rom through the (drifting) stations, closed, sampled evenly in
     parameter and then measured in arc length so packets move at a constant
     speed instead of sprinting through the tight corners. */
  function build(t, off) {
    var i, j, k;
    for (i = 0; i < N; i++) {
      var n = NODES[i];
      nx[i] = (n.x + n.ax * Math.sin(t / n.px * 6.2832)) * W;
      ny[i] = (n.y + n.ay * Math.cos(t / n.py * 6.2832)) * H - off;
    }
    k = 0;
    for (i = 0; i < N; i++) {
      var p0x = nx[(i - 1 + N) % N], p0y = ny[(i - 1 + N) % N];
      var p1x = nx[i], p1y = ny[i];
      var p2x = nx[(i + 1) % N], p2y = ny[(i + 1) % N];
      var p3x = nx[(i + 2) % N], p3y = ny[(i + 2) % N];
      for (j = 0; j < SAMPLES; j++) {
        var s = j / SAMPLES, s2 = s * s, s3 = s2 * s;
        sx[k] = 0.5 * ((2 * p1x) + (-p0x + p2x) * s +
                (2 * p0x - 5 * p1x + 4 * p2x - p3x) * s2 +
                (-p0x + 3 * p1x - 3 * p2x + p3x) * s3);
        sy[k] = 0.5 * ((2 * p1y) + (-p0y + p2y) * s +
                (2 * p0y - 5 * p1y + 4 * p2y - p3y) * s2 +
                (-p0y + 3 * p1y - 3 * p2y + p3y) * s3);
        k++;
      }
    }
    cum[0] = 0;
    for (i = 0; i < TOTAL; i++) {
      var a = i, b = (i + 1) % TOTAL;
      var dx = sx[b] - sx[a], dy = sy[b] - sy[a];
      cum[i + 1] = cum[i] + Math.sqrt(dx * dx + dy * dy);
    }
    len = cum[TOTAL] || 1;
    for (i = 0; i < N; i++) nodeAt[i] = cum[i * SAMPLES];
  }

  function segLen(i) { return ((i === N - 1 ? len : nodeAt[i + 1]) - nodeAt[i]) || 1; }

  /* Position at an arc distance, interpolated between samples rather than
     snapped to one. Snapping is what made the old packets hop: at this speed
     a sample lasted about half a second, so the head jumped fifteen pixels
     twice a second instead of sliding. */
  var _p = { x: 0, y: 0 };
  function posAt(d) {
    d = d % len; if (d < 0) d += len;
    var lo = 0, hi = TOTAL;
    while (lo < hi) { var m = (lo + hi) >> 1; if (cum[m] <= d) lo = m + 1; else hi = m; }
    var i = lo - 1; if (i < 0) i = 0; if (i > TOTAL - 1) i = TOTAL - 1;
    var span = cum[i + 1] - cum[i];
    var f = span > 0 ? (d - cum[i]) / span : 0;
    var a = i, b = (i + 1) % TOTAL;
    _p.x = sx[a] + (sx[b] - sx[a]) * f;
    _p.y = sy[a] + (sy[b] - sy[a]) * f;
    return _p;
  }

  function advance(dt) {
    // Scrolling gives the circuit a nudge that fades out again: the further
    // you read, the further the work has got.
    boost += (0 - boost) * Math.min(1, dt * 1.6);
    if (scrolled) { boost = Math.min(0.9, boost + scrolled * 0.0016); scrolled = 0; }
    var k = 1 + boost, i, j;

    for (i = 0; i < N; i++) act[i] += (0 - act[i]) * Math.min(1, dt * 1.2);
    for (i = rings.length - 1; i >= 0; i--) { rings[i].t += dt / 1.6; if (rings[i].t >= 1) rings.splice(i, 1); }
    for (i = wires.length - 1; i >= 0; i--) {
      var w = wires[i]; w.t += dt / 1.1;
      if (w.t >= 1) { act[w.to] = Math.max(act[w.to], 0.42); wires.splice(i, 1); }
    }

    if (intro < 0.5) return;                 // the line arrives before the work does

    for (j = 0; j < PACKETS.length; j++) {
      var p = PACKETS[j];
      if (p.hold > 0) {                      // the step is running
        act[p.node] = 1;
        p.hold -= dt * k;
        continue;
      }
      var L = segLen(p.node);
      // Off the mark, then coast, then slow into the next station.
      var out = Math.min(1, p.u / 0.14);
      var into = Math.min(1, (1 - p.u) / 0.22);
      var v = p.sp * len * k * (0.35 + 0.65 * out) * (0.28 + 0.72 * into * into);
      p.u += (v / L) * dt;
      if (p.u >= 1) {
        var next = (p.node + 1) % N;
        p.node = next; p.u = 0;
        // A little spread so four packets never fall into step with each other.
        p.hold = NODES[next].dw * (0.85 + 0.3 * (((j * 7 + next * 3) % 5) / 4));
        act[next] = 1;
        if (rings.length < 12) rings.push({ n: next, t: 0 });
        for (i = 0; i < CHORDS.length; i++) {
          if (wires.length > 5) break;
          if (CHORDS[i][0] === next) wires.push({ c: i, from: next, to: CHORDS[i][1], t: 0 });
          else if (CHORDS[i][1] === next) wires.push({ c: i, from: next, to: CHORDS[i][0], t: 0 });
        }
      }
    }
  }

  function paint(now) {
    var i, j;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = DIM;
    ctx.lineJoin = ctx.lineCap = 'round';

    // The circuit itself, drawing itself on as the page opens.
    ctx.beginPath();
    ctx.moveTo(sx[0], sy[0]);
    for (i = 1; i < TOTAL; i++) ctx.lineTo(sx[i], sy[i]);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(' + AMBER + ',.06)';
    ctx.lineWidth = 1;
    if (intro < 1) { ctx.setLineDash([len * intro, len]); ctx.stroke(); ctx.setLineDash([]); }
    else ctx.stroke();

    // Branches, and word travelling along one.
    ctx.strokeStyle = 'rgba(' + AMBER + ',' + (0.035 * intro) + ')';
    for (i = 0; i < CHORDS.length; i++) {
      ctx.beginPath();
      ctx.moveTo(nx[CHORDS[i][0]], ny[CHORDS[i][0]]);
      ctx.lineTo(nx[CHORDS[i][1]], ny[CHORDS[i][1]]);
      ctx.stroke();
    }
    for (i = 0; i < wires.length; i++) {
      var w = wires[i], e = w.t * (2 - w.t);   // out fast, in slow
      var ax = nx[w.from], ay = ny[w.from], bx = nx[w.to], by = ny[w.to];
      ctx.beginPath();
      ctx.arc(ax + (bx - ax) * e, ay + (by - ay) * e, 1.4, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + LIGHT + ',' + (0.30 * (1 - w.t * w.t)) + ')';
      ctx.fill();
    }

    // The stations: lit while their step runs, fading once it is done.
    for (i = 0; i < N; i++) {
      var a = act[i] * intro;
      ctx.beginPath();
      ctx.arc(nx[i], ny[i], 2 + a * 1.8, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + AMBER + ',' + (0.13 * intro + a * 0.30) + ')';
      ctx.fill();
      if (a > 0.15) {
        var g = ctx.createRadialGradient(nx[i], ny[i], 0, nx[i], ny[i], 30);
        g.addColorStop(0, 'rgba(' + LIGHT + ',' + (a * 0.11) + ')');
        g.addColorStop(1, 'rgba(' + LIGHT + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(nx[i] - 30, ny[i] - 30, 60, 60);
      }
    }

    // The ring a finished step leaves behind — the only thing on this canvas
    // that is an event rather than a state.
    ctx.lineWidth = 1;
    for (i = 0; i < rings.length; i++) {
      var r = rings[i], rt = r.t * (2 - r.t);
      ctx.beginPath();
      ctx.arc(nx[r.n], ny[r.n], 3 + rt * 30, 0, 6.2832);
      ctx.strokeStyle = 'rgba(' + AMBER + ',' + (0.16 * (1 - r.t) * (1 - r.t) * intro) + ')';
      ctx.stroke();
    }

    // The packets: a tapered trail into a bright head. This is the part that
    // reads as work actually going somewhere.
    var pa = Math.max(0, Math.min(1, (intro - 0.5) / 0.5));
    if (pa <= 0) { ctx.globalAlpha = 1; return; }
    for (j = 0; j < PACKETS.length; j++) {
      var p = PACKETS[j];
      var d = nodeAt[p.node] + p.u * segLen(p.node);
      var h = posAt(d), hx = h.x, hy = h.y;
      var t = posAt(d - TRAIL), tx = t.x, ty = t.y;

      var lg = ctx.createLinearGradient(tx, ty, hx, hy);
      lg.addColorStop(0, 'rgba(' + LIGHT + ',0)');
      lg.addColorStop(1, 'rgba(' + LIGHT + ',' + (0.46 * pa) + ')');
      ctx.strokeStyle = lg; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(tx, ty);
      for (i = 8; i >= 0; i--) { var q = posAt(d - TRAIL * i / 9); ctx.lineTo(q.x, q.y); }
      ctx.stroke();

      // Sitting at a station, the head breathes rather than sits dead still.
      var br = p.hold > 0 ? 0.45 * Math.sin(now / 300) : 0;
      ctx.beginPath();
      ctx.arc(hx, hy, 2 + br, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + LIGHT + ',' + (0.72 * pa) + ')';
      ctx.fill();
      var hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 15);
      hg.addColorStop(0, 'rgba(' + LIGHT + ',' + (0.14 * pa) + ')');
      hg.addColorStop(1, 'rgba(' + LIGHT + ',0)');
      ctx.fillStyle = hg;
      ctx.fillRect(hx - 15, hy - 15, 30, 30);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now, dt) {
    age += dt;
    var t = (now - t0) / 1000;
    var e = reduce.matches ? 1 : Math.max(0, Math.min(1, (age - 0.25) / 2.3));
    intro = 1 - Math.pow(1 - e, 3);
    // A little parallax, like the lamp — but clamped, so the top of the
    // circuit cannot walk off the screen on a long page.
    var off = Math.min(46, (window.scrollY || 0) * 0.05);
    build(t, off);
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

  size(); frame(performance.now(), 0);
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
    clearTimeout(rt); rt = setTimeout(function () { size(); frame(performance.now(), 0); }, 150);
  });
})();
