/* The net — the second ambient layer of wolfeintelligence.com.

   Eight layers of nodes across the viewport, wired forward, with signals
   propagating left to right: something arrives at the input side, each node it
   reaches pauses while its step runs, then fires on down the wires it owns
   until it comes out the other end. Eighty-four nodes, two hundred and
   twenty-five wires. It is the page saying what the business does without a
   caption.

   A signal does not glide through a node. It arrives, the node waits while the
   step happens and draws that progress round its own ring, and only then does
   it move on. That beat is the whole point of the layer.

   Three things make it read as a net rather than a diagram with dots moving on
   it. Wires have weight: every wire is assigned a fixed strength, drawn at that
   weight, and a node choosing where to send something picks in proportion to
   it — so the heavy wires are both the visible spine of the net and the route
   most traffic actually takes. A crossed wire stays warm for a couple of
   seconds afterwards, so you can see the path a signal took after it has gone.
   And work arrives in waves — two to four inputs within a fifth of a second of
   each other — so what crosses the screen is a front, not a lone particle.

   The awkward part of a net this size is that it wants the whole screen and
   the words are in the middle of it. So the net is not cut away around the
   text — it is dimmed there, hard, and the brighter something is the harder it
   is dimmed. Full strength in open space, a whisper behind a paragraph.
   Nothing is ever laid over a line of type at a weight you could read against.

   That dimming used to be a band pinned to the viewport, which protected the
   first screenful and nothing after it: the layer is fixed but the page scrolls
   underneath, and by the second screen a third of the type was sitting in the
   bright zone. So the layer measures where the words actually are — every text
   node on the page, in page coordinates, minus anything with something solid
   in front of the canvas — and keeps a coarse map of the distance from any
   point to the nearest word. The net dims around type wherever type happens to
   be, and opens up in the gutters, between the columns, and in the space
   between sections. The measure costs about a millisecond and runs on load, on
   resize, and when the page changes height.

   How dark the layer goes under a word is set by two numbers together, not
   one. Alphas are drawn in fourteen quantised steps, and what actually reaches
   the screen is the midpoint of whichever step the value lands in — so
   changing the number of steps silently changes how dark the floor is. At
   seven steps a floor of 0.14 was drawing at about 4/255 by accident; at
   fourteen it would have drawn at 6/255. The pair is now chosen deliberately:
   fourteen steps, floor 0.07, about 2/255 under type. Fourteen rather than
   seven also matters while scrolling — the dimming sweeps across the net as
   the page moves, and at seven steps a wire crosses a visible 8/255 jump every
   couple of frames.

   The rest is the lamplight's manners (assets/ambient.js), because the same
   objection killed an earlier version of this: motion here is meant to be
   felt, not watched. Nodes drift on incommensurate periods so the shape is
   never twice the same, a signal crosses a wire at a walking pace whatever the
   wire's length, and on a phone — where there is no margin left to be generous
   in — the whole layer steps back.

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
  var NUMS = /[0-9.]+/g;
  var STEP = 1000 / 24, W, H, DPR = 1, DIM = 1, last = 0, prev = 0, raf = 0;
  var t0 = performance.now(), age = 0, intro = 0, lin = 0, boost = 0, scrolled = 0;
  var spawn = 0, SPAWN_EVERY = 3.6, MAX_SIGNALS = 60;
  var PXPS = 112;                        // how fast a signal walks, in pixels
  var COOL = 0.45;                       // a crossed wire forgets in ~2.2s

  // Deterministic scatter: the net should look hand-placed, but the same way
  // on every load and every machine.
  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n += n << 3; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return n >>> 0; }

  var nodes = [], first = [], i, j, k, l;
  for (l = 0; l < L; l++) {
    first.push(nodes.length);
    // A column is as tall as it has nodes to fill, so the spacing between
    // neighbours is the same everywhere and the net takes a lens shape rather
    // than filling a rectangle. It is what stops the short outer columns
    // reading as a zigzag stretched over the full height.
    var C = COUNT[l], ext = 0.68 + 0.28 * (C - 7) / 6;
    for (k = 0; k < C; k++) {
      var h = hash(l * 131 + k * 17 + 7);
      nodes.push({
        l: l,
        bx: LX[l] + ((h % 11) - 5) * 0.0018,
        by: 0.5 + (C > 1 ? (k - (C - 1) / 2) / (C - 1) * ext : 0) + (((h >>> 4) % 11) - 5) * 0.0042,
        ax: 0.0035 + ((h >>> 8) % 5) * 0.0011,
        ay: 0.0055 + ((h >>> 11) % 5) * 0.0015,
        px: 29 + ((h >>> 14) % 41),
        py: 33 + ((h >>> 17) % 47),
        x: 0, y: 0, act: 0, hold: 0, held: 0, pulse: 0, deg: 0, r: 1.5, out: []
      });
    }
  }
  var N = nodes.length;

  /* Wires. A node reaches the three nodes opposite its own position in the
     next layer, so the net fans locally instead of tangling; every so often
     one reaches further along, and those few long links are what stop it
     reading as a grid. Matching by position rather than by nearest coordinate
     matters: nearest-coordinate wiring across layers of different sizes
     produces long crossing diagonals everywhere, which looks like a mesh.

     Each wire gets a weight it keeps for good. It is drawn at that weight and
     it is chosen at that weight, so the net has habits — the strong routes are
     the ones you can see, and they are the ones that get used. */
  var edges = [];
  for (l = 0; l < L - 1; l++) {
    var a0 = first[l], b0 = first[l + 1], Cn = COUNT[l + 1], Cc = COUNT[l];
    for (i = 0; i < Cc; i++) {
      var tgt = Math.round(i + (Cn - Cc) / 2);
      var picks = [tgt - 1, tgt, tgt + 1], hh = hash(l * 911 + i * 37);
      if (hh % 6 === 0) picks.push(tgt + 2);
      else if (hh % 9 === 0) picks.push(tgt - 2);
      var seen = {};
      for (k = 0; k < picks.length; k++) {
        var idx = Math.max(0, Math.min(Cn - 1, picks[k]));
        if (seen[idx]) continue;
        seen[idx] = 1;
        var wh = (hash(l * 6151 + i * 389 + idx * 47) % 1000) / 1000;
        nodes[a0 + i].out.push(edges.length);
        edges.push({ a: a0 + i, b: b0 + idx, l: l, w: 0.26 + 0.74 * wh, heat: 0 });
      }
    }
  }
  for (i = 0; i < edges.length; i++) { nodes[edges[i].a].deg++; nodes[edges[i].b].deg++; }
  // A node that carries more sits a little larger. Barely, but it is there.
  for (i = 0; i < N; i++) nodes[i].r = 1.25 + 0.11 * Math.min(6, nodes[i].deg);

  var signals = [], queue = [];

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

  /* How much of itself the net is allowed at a point: all of it in open space,
     a fifth of it right behind a word, ramping between over about 120px.
     Brighter things get this applied twice, so a firing node over a paragraph
     stays under the type rather than competing with it. */
  var FLOOR = 0.07, CELL = 20, FADE = 6;      // FADE in cells: 120px to full
  var gw = 0, gh = 0, dist = null, scY = 0;
  var qx = 0, qy0 = 0, qy1 = 0;

  // Fallback for when the page cannot be read: the old viewport band.
  function quiet() {
    qx = Math.min(1240, Math.max(320, W - 80)) / 2;
    qy0 = 0.12 * H; qy1 = 0.82 * H;
  }
  function band(x, y) {
    var dx = Math.abs(x - W / 2) - qx;
    var dy = Math.max(qy0 - y, y - qy1);
    var o = Math.max(dx, dy);
    return FLOOR + (1 - FLOOR) * Math.max(0, Math.min(1, (o + 30) / 110));
  }

  /* Find every word on the page and build a distance map around it. Text with
     something opaque between it and this canvas is skipped: the frosted header
     and the filled buttons hide the layer completely, so dimming under them
     would cost brightness and buy nothing. */
  function measure() {
    var boxes = [], docH = H, i;
    try {
      docH = Math.max(document.body.scrollHeight || 0, H);
      var sy = window.scrollY || window.pageYOffset || 0;
      var wlk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      var node, p, e, cs, m, skip;
      while ((node = wlk.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        p = node.parentElement;
        if (!p || p === c) continue;
        skip = false;
        for (e = p; e && e !== document.body; e = e.parentElement) {
          cs = getComputedStyle(e);
          if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) { skip = true; break; }
          if (cs.backdropFilter && cs.backdropFilter !== 'none') { skip = true; break; }
          m = cs.backgroundColor.match(NUMS);
          if (m && (m.length < 4 || +m[3] > 0.5)) { skip = true; break; }
        }
        if (skip) continue;
        var rg = document.createRange();
        rg.selectNodeContents(node);
        var rl = rg.getClientRects();
        for (i = 0; i < rl.length; i++) {
          var b = rl[i];
          if (b.width < 2 || b.height < 2) continue;
          boxes.push(b.left, b.top + sy, b.right, b.bottom + sy);
        }
      }
    } catch (err) { boxes = []; }

    if (!boxes.length) { dist = null; return; }

    gw = Math.ceil(W / CELL);
    gh = Math.ceil(docH / CELL);
    if (gw * gh > 4000000) { dist = null; return; }   // absurd page, keep the band
    var BIG = 30000, d = new Uint16Array(gw * gh);
    for (i = 0; i < d.length; i++) d[i] = BIG;
    for (i = 0; i < boxes.length; i += 4) {
      var x0 = Math.max(0, Math.floor(boxes[i] / CELL));
      var y0 = Math.max(0, Math.floor(boxes[i + 1] / CELL));
      var x1 = Math.min(gw - 1, Math.floor(boxes[i + 2] / CELL));
      var y1 = Math.min(gh - 1, Math.floor(boxes[i + 3] / CELL));
      for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) d[yy * gw + xx] = 0;
    }
    /* Chamfer distance transform, 3 orthogonal and 4 diagonal, so the answer
       comes out in thirds of a cell. Two passes over the grid, no square
       roots, and it runs once per measure rather than per frame. */
    var x, y, k, v;
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
      k = y * gw + x; v = d[k]; if (!v) continue;
      if (x > 0 && d[k - 1] + 3 < v) v = d[k - 1] + 3;
      if (y > 0) {
        if (d[k - gw] + 3 < v) v = d[k - gw] + 3;
        if (x > 0 && d[k - gw - 1] + 4 < v) v = d[k - gw - 1] + 4;
        if (x < gw - 1 && d[k - gw + 1] + 4 < v) v = d[k - gw + 1] + 4;
      }
      d[k] = v;
    }
    for (y = gh - 1; y >= 0; y--) for (x = gw - 1; x >= 0; x--) {
      k = y * gw + x; v = d[k]; if (!v) continue;
      if (x < gw - 1 && d[k + 1] + 3 < v) v = d[k + 1] + 3;
      if (y < gh - 1) {
        if (d[k + gw] + 3 < v) v = d[k + gw] + 3;
        if (x < gw - 1 && d[k + gw + 1] + 4 < v) v = d[k + gw + 1] + 4;
        if (x > 0 && d[k + gw - 1] + 4 < v) v = d[k + gw - 1] + 4;
      }
      d[k] = v;
    }
    dist = d;
  }

  /* Anything drawn as a line is only ever as bright as the quietest place it
     passes through. Sampling the ends and the middle is not enough: a wire is
     a couple of hundred pixels long and a line of type is twenty tall, so
     three samples can step straight over a paragraph and the wire gets drawn
     across it at full strength. Walk it instead, at roughly one sample per
     cell of the map. */
  function calmSeg(ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var n = Math.ceil(Math.sqrt(dx * dx + dy * dy) / CELL);
    if (n < 2) n = 2; else if (n > 16) n = 16;
    var m = 1;
    for (var i = 0; i <= n; i++) {
      var v = calm(ax + dx * i / n, ay + dy * i / n);
      if (v < m) { m = v; if (m <= FLOOR) return m; }
    }
    return m;
  }
  function calm(x, y) {
    if (!dist) return band(x, y);
    var gx = (x / CELL) | 0, gy = ((y + scY) / CELL) | 0;
    if (gx < 0) gx = 0; else if (gx >= gw) gx = gw - 1;
    if (gy < 0) gy = 0; else if (gy >= gh) gy = gh - 1;
    var v = dist[gy * gw + gx] / 3;
    return v >= FADE ? 1 : FLOOR + (1 - FLOOR) * (v / FADE);
  }

  function place(t) {
    for (var i = 0; i < N; i++) {
      var n = nodes[i];
      n.x = (n.bx + n.ax * Math.sin(t / n.px * 6.2832)) * W;
      n.y = (n.by + n.ay * Math.cos(t / n.py * 6.2832)) * H;
    }
  }

  // A signal walks at a fixed pace in pixels, so a long wire is a long trip
  // rather than a fast one.
  function launch(e, seed) {
    if (signals.length >= MAX_SIGNALS) return;
    var E = edges[e], A = nodes[E.a], B = nodes[E.b];
    var dx = B.x - A.x, dy = B.y - A.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    signals.push({ e: e, t: 0, sp: (PXPS + (hash(seed) % 19)) / Math.max(70, d) });
  }

  // Where a node sends what it just finished: heavier wire, likelier route.
  function pickOut(n, seed) {
    var outs = n.out, tot = 0, m;
    for (m = 0; m < outs.length; m++) tot += edges[outs[m]].w;
    var r = (hash(seed) % 10007) / 10007 * tot, acc = 0;
    for (m = 0; m < outs.length; m++) { acc += edges[outs[m]].w; if (r < acc) return m; }
    return outs.length - 1;
  }

  function fire(i, k) {
    var n = nodes[i], outs = n.out;
    if (!outs.length) return;
    // Mostly one wire; now and then two, which is what makes a single input
    // come out the far side as a spread.
    var many = outs.length > 1 && hash(k * 7919 + i) % 4 === 0 ? 2 : 1;
    var m0 = pickOut(n, k * 104729 + i * 31);
    launch(outs[m0], k + i);
    if (many === 2) {
      var m1 = pickOut(n, k * 104729 + i * 31 + 613);
      if (m1 === m0) m1 = (m0 + 1) % outs.length;
      launch(outs[m1], k + i + 1);
    }
  }

  var fireSeq = 0;
  function arrive(i) {
    var n = nodes[i];
    n.act = 1;
    // The pause while the step runs. Short, because there are a lot of them.
    n.held = n.hold = 0.30 + (hash(i * 37 + fireSeq) % 13) * 0.022;
    if (n.l === L - 1) n.pulse = 1;      // something came out the far side
  }

  // Work arrives in waves, not one at a time: a few inputs within a fifth of a
  // second of each other, so what crosses the screen is a front.
  function wave(seq) {
    var many = 2 + (hash(seq * 7919 + 3) % 3);
    for (var m = 0; m < many; m++) {
      queue.push({
        i: first[0] + (hash(seq * 2654435761 + m * 97) % COUNT[0]),
        d: m * (0.06 + (hash(seq + m * 13) % 9) * 0.017)
      });
    }
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
      if (n.pulse > 0) { n.pulse -= dt * 0.95; if (n.pulse < 0) n.pulse = 0; }
    }

    // A wire stays warm after something crossed it, so the route a signal took
    // is still readable behind it for a moment.
    for (i = 0; i < edges.length; i++) {
      if (edges[i].heat > 0) { edges[i].heat -= dt * COOL; if (edges[i].heat < 0) edges[i].heat = 0; }
    }

    for (i = signals.length - 1; i >= 0; i--) {
      var s = signals[i];
      s.t += s.sp * dt * k;
      if (s.t >= 1) { edges[s.e].heat = 1; signals.splice(i, 1); arrive(edges[s.e].b); }
    }

    for (i = queue.length - 1; i >= 0; i--) {
      queue[i].d -= dt * k;
      if (queue[i].d <= 0) { fireSeq++; arrive(queue[i].i); queue.splice(i, 1); }
    }

    if (lin < 0.55) return;              // the net is wired before it is used
    spawn += dt * k;
    if (spawn >= SPAWN_EVERY) { spawn = 0; fireSeq++; wave(fireSeq); }
  }

  /* Wire alphas are bucketed so the whole net is a handful of stroked paths
     rather than two hundred and twenty-five of them; weight goes into the
     bucket, so the heavy wires sort themselves into the brighter, thicker
     passes. Fourteen steps, not seven — see the note above about how this
     number and FLOOR set the floor brightness together. */
  var BUCKETS = 14;
  function paint(now) {
    var i, b;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = DIM;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.lineWidth = 1;

    // The wires, layer by layer as the net comes up.
    var paths = []; for (b = 0; b < BUCKETS; b++) paths.push(null);
    var hot = null;
    for (i = 0; i < edges.length; i++) {
      var e = edges[i];
      var vis = Math.max(0, Math.min(1, lin * L - e.l));
      if (vis <= 0) continue;
      var na = nodes[e.a], nb = nodes[e.b];
      var cm = calmSeg(na.x, na.y, nb.x, nb.y);
      var f = cm * vis * e.w;
      b = Math.min(BUCKETS - 1, Math.floor(f * BUCKETS));
      if (!paths[b]) paths[b] = [];
      paths[b].push(na.x, na.y, nb.x, nb.y);
      if (e.heat > 0.02) { if (!hot) hot = []; hot.push(i, cm * cm * vis); }
    }
    for (b = 0; b < BUCKETS; b++) {
      var pts = paths[b]; if (!pts) continue;
      var g = (b + 0.5) / BUCKETS;
      ctx.beginPath();
      for (i = 0; i < pts.length; i += 4) { ctx.moveTo(pts[i], pts[i + 1]); ctx.lineTo(pts[i + 2], pts[i + 3]); }
      ctx.lineWidth = 0.75 + 0.5 * g;
      ctx.strokeStyle = 'rgba(' + AMBER + ',' + (0.22 * g).toFixed(4) + ')';
      ctx.stroke();
    }

    // Wires still warm from something that crossed them.
    if (hot) {
      for (i = 0; i < hot.length; i += 2) {
        var he = edges[hot[i]], hv = hot[i + 1];
        var ha = nodes[he.a], hb = nodes[he.b];
        ctx.lineWidth = 0.9 + 0.7 * he.w;
        ctx.strokeStyle = 'rgba(' + LIGHT + ',' + (0.22 * he.heat * hv).toFixed(4) + ')';
        ctx.beginPath(); ctx.moveTo(ha.x, ha.y); ctx.lineTo(hb.x, hb.y); ctx.stroke();
      }
    }
    ctx.lineWidth = 1;

    // The nodes. Quiet ones go out in bulk; the ones with something happening
    // are worth drawing on their own.
    var bulk = []; for (b = 0; b < BUCKETS; b++) bulk.push(null);
    for (i = 0; i < N; i++) {
      var n = nodes[i];
      var nv = Math.max(0, Math.min(1, lin * L - n.l + 0.4)) * intro;
      if (nv <= 0) continue;
      var cm = calm(n.x, n.y);
      if (n.act < 0.03 && n.pulse <= 0) {
        b = Math.min(BUCKETS - 1, Math.floor(cm * nv * BUCKETS));
        if (!bulk[b]) bulk[b] = [];
        bulk[b].push(n.x, n.y, n.r);
        continue;
      }
      var a = n.act * cm * cm * nv;        // bright things get calmed twice
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 0.25 + a * 1.3, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + AMBER + ',' + (0.18 * cm * cm * nv + a * 0.42) + ')';
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
      // Something reached the far side: one ring opening outwards.
      if (n.pulse > 0) {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 + (1 - n.pulse) * 15, 0, 6.2832);
        ctx.strokeStyle = 'rgba(' + LIGHT + ',' + (0.26 * n.pulse * n.pulse * cm * cm * nv).toFixed(4) + ')';
        ctx.stroke();
      }
      if (a > 0.25) {
        var rg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 26);
        rg.addColorStop(0, 'rgba(' + LIGHT + ',' + (a * 0.09) + ')');
        rg.addColorStop(1, 'rgba(' + LIGHT + ',0)');
        ctx.fillStyle = rg;
        ctx.fillRect(n.x - 26, n.y - 26, 52, 52);
      }
    }
    for (b = 0; b < BUCKETS; b++) {
      var q = bulk[b]; if (!q) continue;
      ctx.beginPath();
      for (i = 0; i < q.length; i += 3) { ctx.moveTo(q[i] + q[i + 2], q[i + 1]); ctx.arc(q[i], q[i + 1], q[i + 2], 0, 6.2832); }
      ctx.fillStyle = 'rgba(' + AMBER + ',' + (0.24 * ((b + 0.5) / BUCKETS)).toFixed(4) + ')';
      ctx.fill();
    }

    // The signals: a short bright run along the wire being crossed. This is
    // the part that reads as something actually going somewhere.
    var sa = Math.max(0, Math.min(1, (intro - 0.5) / 0.5));
    if (sa <= 0) { ctx.globalAlpha = 1; return; }
    for (i = 0; i < signals.length; i++) {
      var s = signals[i], E = edges[s.e], A = nodes[E.a], B = nodes[E.b];
      var dx = B.x - A.x, dy = B.y - A.y;
      var hx = A.x + dx * s.t, hy = A.y + dy * s.t;
      var back = Math.max(0, s.t - 0.30);
      var bx2 = A.x + dx * back, by2 = A.y + dy * back;
      // The tail is a line, so it takes the quietest point along itself. Judging
      // it by the head alone lets a signal whose head is in open space drag a
      // bright streak back across a paragraph.
      var ct = calmSeg(bx2, by2, hx, hy), at = sa * ct * ct;
      var ch = calm(hx, hy), ah = sa * ch * ch;
      var lg = ctx.createLinearGradient(bx2, by2, hx, hy);
      lg.addColorStop(0, 'rgba(' + LIGHT + ',0)');
      lg.addColorStop(1, 'rgba(' + LIGHT + ',' + (0.50 * at).toFixed(4) + ')');
      ctx.strokeStyle = lg; ctx.lineWidth = 1.2 + 0.6 * E.w;
      ctx.beginPath(); ctx.moveTo(bx2, by2); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, 1.7, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + LIGHT + ',' + (0.75 * ah).toFixed(4) + ')';
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
    scY = window.scrollY || window.pageYOffset || 0;
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

  size(); quiet(); measure();
  // Asked for less motion: one still frame, but not a dead one — a scatter of
  // nodes mid-step, wires still warm from traffic, signals caught part way
  // along, so the net reads as a net at rest rather than a diagram.
  if (reduce.matches) {
    for (i = 0; i < N; i++) if (hash(i * 7 + 11) % 9 === 0) { nodes[i].act = 0.5 + (hash(i) % 5) * 0.1; }
    for (i = 0; i < edges.length; i += 11) signals.push({ e: i, t: 0.35 + (hash(i) % 5) * 0.1, sp: 0 });
    for (i = 4; i < edges.length; i += 7) edges[i].heat = 0.3 + (hash(i * 3) % 6) * 0.09;
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
    clearTimeout(rt); rt = setTimeout(function () {
      size(); quiet(); measure(); frame(performance.now(), 0);
    }, 150);
  });
  /* The page is not the same height at first paint as it is once the fonts
     have swapped in and the app has rendered, so the map is rebuilt when the
     document changes size rather than trusted from load. */
  var mt, lastH = 0;
  function remeasure() { clearTimeout(mt); mt = setTimeout(measure, 250); }
  if (window.ResizeObserver) {
    try {
      new ResizeObserver(function () {
        var h = document.body.scrollHeight;
        if (h !== lastH) { lastH = h; remeasure(); }
      }).observe(document.body);
    } catch (err) {}
  }
  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(remeasure);
  }
})();
