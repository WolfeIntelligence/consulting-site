/* Workflow loop — the second ambient layer of wolfeintelligence.com.

   A closed circuit of waypoints traced around the edges of the viewport, with
   packets of data running it: caught, sorted, answered, recorded, fed back,
   and round again. It is the page saying what the business does without a
   caption.

   It sits on top of the lamplight (assets/ambient.js) and behind everything
   else. The rules it plays by are the lamplight's rules, because the same
   objection killed an earlier version of this: motion here is meant to be
   felt, not watched. So the circuit is faint (a line at 6% alpha), the lap is
   slow (a packet takes the better part of a minute to get round), the route
   hugs the perimeter so it stays out from under the reading column, and the
   whole field breathes on incommensurate periods so it never visibly repeats.

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
     middle — that is where the words are. Each waypoint drifts a little on its
     own period, so the shape is never twice the same. */
  var NODES = [
    { x: 0.07, y: 0.20, ax: 0.012, ay: 0.016, px: 41, py: 53 },
    { x: 0.28, y: 0.10, ax: 0.016, ay: 0.012, px: 59, py: 37 },
    { x: 0.55, y: 0.16, ax: 0.014, ay: 0.018, px: 43, py: 61 },
    { x: 0.81, y: 0.31, ax: 0.012, ay: 0.014, px: 67, py: 47 },
    { x: 0.92, y: 0.58, ax: 0.014, ay: 0.012, px: 39, py: 71 },
    { x: 0.71, y: 0.79, ax: 0.016, ay: 0.014, px: 73, py: 43 },
    { x: 0.41, y: 0.87, ax: 0.014, ay: 0.016, px: 47, py: 59 },
    { x: 0.14, y: 0.66, ax: 0.012, ay: 0.014, px: 61, py: 41 }
  ];
  // Two short chords across the corners, so it reads as a workflow with
  // branches rather than a racetrack. Both hug the edge; neither crosses the
  // middle of the page.
  var CHORDS = [[0, 2], [4, 6]];

  var SAMPLES = 22;                        // curve samples per segment
  var N = NODES.length, TOTAL = N * SAMPLES;
  var px = new Float32Array(TOTAL), py = new Float32Array(TOTAL);
  var cum = new Float32Array(TOTAL + 1);   // arc length, for even packet speed
  var len = 0;

  var PACKETS = [
    { at: 0.00, sp: 0.0130 }, { at: 0.17, sp: 0.0116 }, { at: 0.31, sp: 0.0142 },
    { at: 0.48, sp: 0.0121 }, { at: 0.63, sp: 0.0134 }, { at: 0.82, sp: 0.0112 }
  ];
  var TAIL = 15;                           // trail length, in samples

  var AMBER = '201,161,95', LIGHT = '233,201,141';
  var STEP = 1000 / 24, W, H, DPR = 1, last = 0, raf = 0, t0 = performance.now();

  function size() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = innerWidth; H = innerHeight;
    c.width = Math.ceil(W * DPR); c.height = Math.ceil(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  /* Catmull-Rom through the (drifting) waypoints, closed, sampled evenly in
     parameter and then measured in arc length so packets move at a constant
     speed instead of sprinting through the tight corners. */
  function build(t, sy) {
    var i, j, k, nx = [], ny = [];
    for (i = 0; i < N; i++) {
      var n = NODES[i];
      nx.push((n.x + n.ax * Math.sin(t / n.px * 6.2832)) * W);
      ny.push((n.y + n.ay * Math.cos(t / n.py * 6.2832)) * H - sy);
    }
    k = 0;
    for (i = 0; i < N; i++) {
      var p0x = nx[(i - 1 + N) % N], p0y = ny[(i - 1 + N) % N];
      var p1x = nx[i], p1y = ny[i];
      var p2x = nx[(i + 1) % N], p2y = ny[(i + 1) % N];
      var p3x = nx[(i + 2) % N], p3y = ny[(i + 2) % N];
      for (j = 0; j < SAMPLES; j++) {
        var s = j / SAMPLES, s2 = s * s, s3 = s2 * s;
        px[k] = 0.5 * ((2 * p1x) + (-p0x + p2x) * s +
                (2 * p0x - 5 * p1x + 4 * p2x - p3x) * s2 +
                (-p0x + 3 * p1x - 3 * p2x + p3x) * s3);
        py[k] = 0.5 * ((2 * p1y) + (-p0y + p2y) * s +
                (2 * p0y - 5 * p1y + 4 * p2y - p3y) * s2 +
                (-p0y + 3 * p1y - 3 * p2y + p3y) * s3);
        k++;
      }
    }
    cum[0] = 0;
    for (i = 0; i < TOTAL; i++) {
      var a = i, b = (i + 1) % TOTAL;
      var dx = px[b] - px[a], dy = py[b] - py[a];
      cum[i + 1] = cum[i] + Math.sqrt(dx * dx + dy * dy);
    }
    len = cum[TOTAL];
    return { nx: nx, ny: ny };
  }

  // Sample index at a fractional distance around the loop.
  function idxAt(f) {
    var d = (f - Math.floor(f)) * len, lo = 0, hi = TOTAL;
    while (lo < hi) { var m = (lo + hi) >> 1; if (cum[m] < d) lo = m + 1; else hi = m; }
    return (lo - 1 + TOTAL) % TOTAL;
  }

  function draw(now) {
    var t = (now - t0) / 1000;
    var sy = (window.scrollY || 0) * 0.05;     // a little parallax, like the lamp
    var pts = build(t, sy);
    var i, j;

    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = ctx.lineCap = 'round';

    // The circuit itself.
    ctx.beginPath();
    ctx.moveTo(px[0], py[0]);
    for (i = 1; i < TOTAL; i++) ctx.lineTo(px[i], py[i]);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(' + AMBER + ',.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Branch chords.
    ctx.strokeStyle = 'rgba(' + AMBER + ',.035)';
    for (i = 0; i < CHORDS.length; i++) {
      ctx.beginPath();
      ctx.moveTo(pts.nx[CHORDS[i][0]], pts.ny[CHORDS[i][0]]);
      ctx.lineTo(pts.nx[CHORDS[i][1]], pts.ny[CHORDS[i][1]]);
      ctx.stroke();
    }

    // Waypoints, brightening as a packet arrives and fading after it leaves.
    for (i = 0; i < N; i++) {
      var near = 0;
      for (j = 0; j < PACKETS.length; j++) {
        var pf = PACKETS[j].at - Math.floor(PACKETS[j].at);
        var d = Math.abs(pf * TOTAL - i * SAMPLES);
        d = Math.min(d, TOTAL - d);
        if (d < SAMPLES) near = Math.max(near, 1 - d / SAMPLES);
      }
      ctx.beginPath();
      ctx.arc(pts.nx[i], pts.ny[i], 2 + near * 1.6, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + AMBER + ',' + (0.13 + near * 0.30) + ')';
      ctx.fill();
      if (near > 0.02) {                       // the arrival, as a soft bloom
        var g = ctx.createRadialGradient(pts.nx[i], pts.ny[i], 0, pts.nx[i], pts.ny[i], 26);
        g.addColorStop(0, 'rgba(' + LIGHT + ',' + (near * 0.10) + ')');
        g.addColorStop(1, 'rgba(' + LIGHT + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(pts.nx[i] - 26, pts.ny[i] - 26, 52, 52);
      }
    }

    // The packets: a bright head with a short trail behind it. This is the
    // part that reads as data actually going somewhere.
    for (j = 0; j < PACKETS.length; j++) {
      var p = PACKETS[j];
      var head = idxAt(p.at);
      for (i = TAIL; i >= 0; i--) {
        var k = (head - i + TOTAL) % TOTAL;
        var f = 1 - i / TAIL;
        ctx.beginPath();
        ctx.arc(px[k], py[k], 0.7 + f * 1.5, 0, 6.2832);
        ctx.fillStyle = 'rgba(' + LIGHT + ',' + (f * f * 0.42) + ')';
        ctx.fill();
      }
    }
  }

  function advance(dt) {
    for (var j = 0; j < PACKETS.length; j++) {
      PACKETS[j].at = (PACKETS[j].at + PACKETS[j].sp * dt) % 1;
    }
  }

  var prev = 0;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < STEP) return;
    var dt = prev ? Math.min((now - prev) / 1000, 0.1) : 0;
    prev = now; last = now - ((now - last) % STEP);
    advance(dt); draw(now);
  }
  function start() { if (!raf && !reduce.matches && !document.hidden) { prev = 0; raf = requestAnimationFrame(loop); } }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  size(); draw(performance.now());
  document.body.insertBefore(c, document.body.firstChild);
  requestAnimationFrame(function () { c.classList.add('is-on'); });
  start();
  if (reduce.addEventListener) reduce.addEventListener('change', function () { reduce.matches ? stop() : start(); });
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
  var rt; addEventListener('resize', function () {
    clearTimeout(rt); rt = setTimeout(function () { size(); draw(performance.now()); }, 150);
  });
})();
