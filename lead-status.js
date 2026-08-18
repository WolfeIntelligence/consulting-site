/* One-tap outcome page. Reads the signed token from the URL, shows which
   inquiry it is about, and only changes anything when the button is pressed.
   Served from the root, not /assets, because /assets is cached immutable. */
(function () {
  var app = document.getElementById('app');
  var q = new URLSearchParams(location.search);
  var t = q.get('t') || '', set = q.get('set') || '';
  var LABEL = { contacted: 'I called them back', booked: 'Estimate booked', won: 'Became a customer', lost: 'Did not go ahead' };
  var VERB = { contacted: 'have been called back', booked: 'booked an estimate', won: 'became a customer', lost: 'did not go ahead' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function stateOf(l) {
    return l.won === 'Yes' ? 'CUSTOMER' : l.booked === 'Yes' ? 'ESTIMATE BOOKED' : l.won === 'No' ? 'DID NOT PROCEED' : l.contacted === 'Yes' ? 'CALLED BACK' : 'NEW';
  }
  function fail(msg) { app.innerHTML = '<h1>That link will not work</h1><p class="err">' + esc(msg) + '</p><p>Open <a href="/portal">your portal</a> to update the inquiry there.</p>'; }

  if (!t || !LABEL[set]) return fail('It is missing the details it needs.');

  fetch('/api/lead-status?t=' + encodeURIComponent(t))
    .then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
    .then(function (x) {
      if (!x.r.ok) return fail(x.r.status === 401 ? 'It has expired or was altered.' : 'The inquiry could not be found.');
      var l = x.d.lead;
      app.innerHTML =
        '<h1>Record: ' + esc(LABEL[set]) + '</h1>' +
        '<p>Confirm this for the inquiry below' + (l.business ? ' at ' + esc(l.business) : '') + '.</p>' +
        '<div class="card"><b>' + esc(l.name || 'Inquiry') + '</b>' +
        '<div class="sub">' + esc([l.service, l.phone].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="sub">Inquired ' + esc(String(l.at || '').slice(0, 10)) + '</div>' +
        '<div class="state">' + esc(stateOf(l)) + '</div></div>' +
        '<button id="go">Yes — ' + esc(l.name || 'they') + ' ' + esc(VERB[set]) + '</button>' +
        '<p id="msg" style="margin-top:14px;min-height:22px;"></p>';
      var btn = document.getElementById('go'), msg = document.getElementById('msg');
      btn.onclick = function () {
        btn.disabled = true; btn.textContent = 'Saving…';
        fetch('/api/lead-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: t, set: set }) })
          .then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
          .then(function (y) {
            if (!y.r.ok) throw new Error(y.d.error || ('http-' + y.r.status));
            btn.style.display = 'none';
            msg.className = 'done';
            msg.textContent = 'Saved. ' + (y.d.lead.name || 'The inquiry') + ' is now marked ' + stateOf(y.d.lead).toLowerCase() + '.';
          })
          .catch(function (e) {
            btn.disabled = false; btn.textContent = 'Try again';
            msg.className = 'err'; msg.textContent = 'Could not save (' + e.message + ').';
          });
      };
    })
    .catch(function () { fail('The server could not be reached.'); });
})();
