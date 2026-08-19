/* Lamplight — the ambient background of wolfeintelligence.com.
   One warm light source top-left (the desk lamp), a faint fill to the right and
   a rust hearth low on the page, drifting on slow, non-repeating loops, plus a
   still film grain so the dark never bands. It is drawn on a canvas at one
   eighth resolution and upscaled by the browser, so a frame costs a fraction
   of a millisecond and nothing blurs per frame. It pauses when the tab is
   hidden, freezes to a lit still for people who asked for less motion, and
   stays out of the way of everything else: fixed, behind the page, no pointer. */
(function () {
  if (!document.body || document.getElementById('wolfe-ambient')) return;
  var conn = navigator.connection || {};
  var reduce = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var low = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);

  /* Grain: a 128px tile of grey noise, generated once, shared through a CSS
     variable so the light Approach section can wear the same paper tooth. */
  try {
    var g = document.createElement('canvas'); g.width = g.height = 128;
    var gx = g.getContext('2d');
    var img = gx.createImageData(128, 128), d = img.data;
    for (var i = 0; i < d.length; i += 4) { var v = 90 + Math.random() * 120 | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    gx.putImageData(img, 0, 0);
    document.documentElement.style.setProperty('--wolfe-grain', 'url(' + g.toDataURL('image/png') + ')');
    var grain = document.createElement('div');
    grain.id = 'wolfe-grain'; grain.setAttribute('aria-hidden', 'true');
    document.body.appendChild(grain);
  } catch (e) { /* no grain, no harm */ }

  if (conn.saveData) return;
  var c = document.createElement('canvas');
  var ctx = c.getContext('2d'); if (!ctx) return;
  c.id = 'wolfe-ambient'; c.setAttribute('aria-hidden', 'true');

  var SCALE = low ? 10 : 8, STEP = 1000 / (low ? 15 : 24), W, H, last = 0, raf = 0, t0 = performance.now();
  // Colours are the site's amber (201,161,95), light amber (233,201,141) and
  // rust (168,94,60). Periods are incommensurate so the field never visibly
  // repeats; amplitudes are a few percent of the viewport — felt, not watched.
  var lights = [
    { x: 0.04, y: 0.02, r: 0.72, c: '201,161,95', a: 0.16, ax: 0.08, ay: 0.06, px: 37, py: 47, key: true },
    { x: 0.86, y: 0.58, r: 0.54, c: '233,201,141', a: 0.09, ax: 0.08, ay: 0.06, px: 53, py: 41 },
    { x: 0.10, y: 1.04, r: 0.52, c: '168,94,60', a: 0.12, ax: 0.06, ay: 0.05, px: 44, py: 59 },
  ];
  function size() { W = c.width = Math.ceil(innerWidth / SCALE); H = c.height = Math.ceil(innerHeight / SCALE); }
  function draw(now) {
    var t = (now - t0) / 1000, R = Math.max(W, H), sy = (window.scrollY || 0) * 0.04 / SCALE;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < lights.length; i++) {
      var b = lights[i];
      var x = (b.x + b.ax * Math.sin(t / b.px * 6.2832)) * W;
      var y = (b.y + b.ay * Math.cos(t / b.py * 6.2832)) * H - (b.key ? Math.min(sy, H * 0.25) : 0);
      var r = b.r * R;
      var gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(' + b.c + ',' + b.a + ')');
      gr.addColorStop(0.4, 'rgba(' + b.c + ',' + (b.a * 0.45) + ')');
      gr.addColorStop(1, 'rgba(' + b.c + ',0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    }
  }
  function loop(now) { raf = requestAnimationFrame(loop); if (now - last < STEP) return; last = now - ((now - last) % STEP); draw(now); }
  function start() { if (!raf && !reduce.matches && !document.hidden) raf = requestAnimationFrame(loop); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  size(); draw(performance.now());
  document.body.insertBefore(c, document.body.firstChild);
  requestAnimationFrame(function () { c.classList.add('is-on'); });
  start();
  if (reduce.addEventListener) reduce.addEventListener('change', function () { reduce.matches ? stop() : start(); });
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
  var rt; addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { size(); draw(performance.now()); }, 150); });
})();
