/* Google Ads measurement for the home page.
   One job: when someone clicks "Book a free consult", tell Google Ads a
   conversion happened, so cost per booked consult can be read in the Ads
   account. The Google tag itself is loaded from the <head>; this file only
   configures it and watches the booking links. Nothing here touches the
   portal or the console. */
(function () {
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  gtag('js', new Date());
  gtag('config', 'AW-788072268');
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href*="calendar.app.google"]') : null;
    if (!a) return;
    gtag('event', 'conversion', { send_to: 'AW-788072268/jj5QCOyAtOQcEMyO5PcC' });
  }, true);
})();
