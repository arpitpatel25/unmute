// cal.js — "book 15 minutes" popup (Cal.com).
//
// Any <a data-cal-link="..." data-cal-namespace="unmute15"> on the page opens
// the booker in an overlay instead of navigating away. The <a href> stays a
// real link, so if this script never loads the click still works.
//
// The booker renders in the visitor's OS light/dark preference. So does this
// site by default (see the inline theme script in <head>), so the two agree
// for anyone who hasn't manually overridden our toggle.
(function () {
  var NS = 'unmute15';

  // Cal.com's standard namespaced embed loader.
  (function (C, A, L) {
    var p = function (a, ar) { a.q.push(ar); };
    var d = C.document;
    C.Cal = C.Cal || function () {
      var cal = C.Cal, ar = arguments;
      if (!cal.loaded) {
        cal.ns = {}; cal.q = cal.q || [];
        d.head.appendChild(d.createElement('script')).src = A;
        cal.loaded = true;
      }
      if (ar[0] === L) {
        var api = function () { p(api, arguments); };
        var namespace = ar[1];
        api.q = api.q || [];
        if (typeof namespace === 'string') {
          cal.ns[namespace] = cal.ns[namespace] || api;
          p(cal.ns[namespace], ar);
          p(cal, ['initNamespace', namespace]);
        } else { p(cal, ar); }
        return;
      }
      p(cal, ar);
    };
  })(window, 'https://app.cal.com/embed/embed.js', 'init');

  Cal('init', NS, { origin: 'https://app.cal.com' });

  // --ink from docs.css, handed to Cal as its brand colour.
  Cal.ns[NS]('ui', {
    hideEventTypeDetails: false,
    cssVarsPerTheme: {
      light: { 'cal-brand': '#14110D' },
      dark:  { 'cal-brand': '#ECECEC' }
    }
  });

  function theme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  // Open the booker ourselves rather than relying on Cal's own click
  // interception, which doesn't bind to links added this way.
  //
  // Cal reuses one modal iframe per namespace, and a reopened modal hangs on
  // its spinner. So each open gets a FRESH namespace — costs nothing and the
  // second click behaves exactly like the first. Theme is passed per open, so
  // the booker matches whatever the site's toggle is set to right now.
  var opens = 0;

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-cal-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (!window.Cal) return;          // no Cal? let the href do its job
    e.preventDefault();

    var ns = NS + ++opens;
    Cal('init', ns, { origin: 'https://app.cal.com' });
    // We ask for the site's current theme, but note: Cal's booker ultimately
    // follows the VISITOR'S OS preference and ignores this. That's fine by
    // default — this site's own theme also defaults to the OS — so the two
    // agree unless someone manually flips our toggle against their OS.
    Cal.ns[ns]('ui', {
      theme: theme(),
      hideEventTypeDetails: false,
      cssVarsPerTheme: {
        light: { 'cal-brand': '#14110D' },
        dark:  { 'cal-brand': '#ECECEC' }
      }
    });
    Cal.ns[ns]('modal', {
      calLink: a.getAttribute('data-cal-link'),
      config: { layout: 'month_view', theme: theme() }
    });
  });
})();
