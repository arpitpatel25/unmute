// dark/light toggle. The initial theme is set by a tiny inline script in
// <head> (to avoid a flash); this just wires the button + persists choice.
(function () {
  var btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  });
})();

// staggered reveal for the lineage ledger; no-ops under reduced motion
(function () {
  var rows = document.querySelectorAll('.reveal');
  if (!rows.length) return;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) {
    rows.forEach(function (r) { r.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var i = [].indexOf.call(rows, e.target);
      setTimeout(function () { e.target.classList.add('in'); }, Math.min(i, 8) * 70);
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  rows.forEach(function (r) { io.observe(r); });
})();
