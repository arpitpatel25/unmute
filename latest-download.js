// Always point "Get unmute" / download links at the LATEST release's DMG.
// The links already fall back to .../releases/latest (the release page), which
// is never stale on its own. This just upgrades them to a direct .dmg download
// when the GitHub API responds. If the API is unreachable or rate-limited, the
// /releases/latest fallback stays — so the button always works and is current.
(function () {
  var API = 'https://api.github.com/repos/arpitpatel25/unmute/releases/latest';
  fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rel) {
      if (!rel || !rel.assets) return;
      var dmg = rel.assets.find(function (a) { return /\.dmg$/i.test(a.name); });
      if (!dmg) return;
      var links = document.querySelectorAll('a[href$="/releases/latest"]');
      links.forEach(function (a) { a.href = dmg.browser_download_url; });
    })
    .catch(function () { /* keep the /releases/latest fallback */ });
})();
