// The listen bar under each voiced clip drives that clip's own sound button,
// so there is one source of truth (clear.js) and the two always agree.
;(() => {
  for (const bar of document.querySelectorAll('.film .listen')) {
    const fig = bar.closest('.film'), inner = fig.querySelector('.frame .sound'), btn = bar.querySelector('.listen-btn')
    if (!inner) continue
    const sync = () => {
      const on = inner.getAttribute('aria-pressed') === 'true'
      btn.setAttribute('aria-pressed', String(on))
      btn.querySelector('.lbl').textContent = on ? 'Mute' : 'Play with sound'
    }
    btn.addEventListener('click', () => { inner.click(); sync() })
    new MutationObserver(() => { for (const b of document.querySelectorAll('.film .listen')) b.dispatchEvent(new Event('sync')) }).observe(inner, { attributes: true })
    bar.addEventListener('sync', sync)
    sync()
  }
})()
