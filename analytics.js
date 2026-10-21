// justunmute.me analytics — what was clicked, viewed and played; nothing else.
//
// No cookies and no localStorage: the visitor id lives in sessionStorage and
// dies with the tab, so there is nothing to consent to and no cross-visit
// profile. Events go to our own relay (unmute-pipeline /v1/events), which
// strips anything that is not a short code, number or true/false before it
// forwards to PostHog. Do Not Track / Global Privacy Control turn it all off.
(() => {
  const ENDPOINT = 'https://unmute-pipeline.zodpatel.workers.dev/v1/events'
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return
  if (!/^(www\.)?justunmute\.me$/.test(location.hostname)) return // no local/preview noise

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  }))
  let id
  try { id = sessionStorage.getItem('um_sid') || uuid(); sessionStorage.setItem('um_sid', id) } catch { id = uuid() }

  const page = (location.pathname.replace(/^\/|\.html$/g, '') || 'index').slice(0, 64)
  const loadedAt = Date.now()
  const slug = (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)

  const base = { $session_id: id, $host: location.host, $pathname: location.pathname, $current_url: location.href, page }
  const utm = {}
  const params = new URLSearchParams(location.search)
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref']) {
    const v = params.get(k)
    if (v) utm[k === 'ref' ? 'utm_source' : k] = slug(v)
  }

  let queue = []
  const flush = () => {
    if (!queue.length) return
    const body = JSON.stringify({ source: 'web', events: queue })
    queue = []
    const blob = new Blob([body], { type: 'text/plain' })
    if (!(navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob))) {
      fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {})
    }
  }
  const track = (event, props = {}, now = false) => {
    queue.push({ event, distinct_id: id, ts: Date.now(), props: { ...base, ...utm, ...props } })
    if (now || queue.length >= 20) flush()
  }
  setInterval(flush, 5000)
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { track('page_left', engagement()); flush() } })
  addEventListener('pagehide', flush)

  // ── Engagement: how far they scrolled, which sections they actually saw ──
  let maxScroll = 0
  const seen = new Set()
  addEventListener('scroll', () => {
    const h = document.documentElement.scrollHeight - innerHeight
    if (h > 0) maxScroll = Math.max(maxScroll, Math.round((scrollY / h) * 100))
  }, { passive: true })
  const sectionName = (el) => slug(el.id || (el.className || '').split(' ')[0] || 'section')
  const engagement = () => ({ ms_on_page: Date.now() - loadedAt, max_scroll_pct: maxScroll, sections_seen: [...seen].slice(0, 20) })
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const name = sectionName(e.target)
        if (seen.has(name)) continue
        seen.add(name)
        io.unobserve(e.target)
        track('section_viewed', { section: name, ms_since_load: Date.now() - loadedAt })
      }
    }, { threshold: 0.4 })
    addEventListener('DOMContentLoaded', () => document.querySelectorAll('main section, body > section, section[id]').forEach((s) => io.observe(s)))
  }

  // ── Where on the page a click happened ──
  const placement = (el) => {
    const tagged = el.closest('[data-track-placement]')
    if (tagged) return slug(tagged.getAttribute('data-track-placement'))
    if (el.closest('nav, header')) return page === 'index' ? 'nav' : `${page}-nav`
    if (el.closest('footer')) return page === 'index' ? 'footer' : `${page}-footer`
    const s = el.closest('section')
    const where = s ? sectionName(s) : 'body'
    return page === 'index' ? where : `${page}-${where}`
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target instanceof Element ? ev.target : null
    if (!el) return
    const a = el.closest('a[href]')
    if (a) {
      const href = a.getAttribute('href') || ''
      if (/\.dmg($|\?)/.test(href) || /releases\/latest/.test(href)) {
        return track('download_clicked', { placement: placement(a), ...engagement() }, true)
      }
      if (/#download$/.test(href)) return track('download_intent', { placement: placement(a) })
      if (/compare[^/]*\.html/.test(href)) return track('compare_clicked', { target: slug(href.replace(/\.html.*$/, '')), placement: placement(a) })
      if (/^https?:/.test(href) && !href.includes(location.host)) {
        let target = 'other'
        try { target = slug(new URL(href).hostname.replace(/^www\./, '')) } catch {}
        return track('outbound_clicked', { target, placement: placement(a) })
      }
      return
    }
    // The playable demo in #try
    if (el.closest('.try-hint, #talk')) return track('demo_started', { input: 'click' })
    const chip = el.closest('.chip[data-task]')
    if (chip) return track('demo_choice', { step: 'task', choice: slug(chip.dataset.task) })
    const seg = el.closest('.seg button[data-agent]')
    if (seg) return track('demo_choice', { step: 'provider', choice: slug(seg.dataset.agent) })
    const ans = el.closest('[data-a]')
    if (ans) return track('demo_answered', { choice: slug(ans.dataset.a) })
    // Where it works: per-app tabs
    const tab = el.closest('#apps .tab')
    if (tab) return track('apps_tab_clicked', { index: [...tab.parentElement.children].indexOf(tab) })
    // The film
    const ch = el.closest('.film-scene .chapters button')
    if (ch) return track('film_interaction', { action: 'chapter', chapter: [...ch.parentElement.querySelectorAll('button')].indexOf(ch) })
    const film = el.closest('.c-pause, .c-replay, .c-sound, .film-snd')
    if (film) return track('film_interaction', { action: slug(film.className.split(' ')[0].replace(/^c-|^film-/, '')) })
  }, true)

  document.addEventListener('change', (ev) => {
    if (ev.target instanceof HTMLSelectElement && ev.target.id === 'model') track('demo_choice', { step: 'model', choice: slug(ev.target.value) })
  }, true)

  addEventListener('keydown', (e) => {
    if (e.code === 'AltRight' && !e.repeat && document.getElementById('try-stage')) track('demo_started', { input: 'keyboard' })
  })

  // <details> toggles: FAQ items and the raw hero recording
  document.addEventListener('toggle', (ev) => {
    const d = ev.target
    if (!(d instanceof HTMLDetailsElement) || !d.open) return
    if (d.classList.contains('real-wrap')) return track('hero_video_opened')
    const faq = d.closest('#faq')
    if (faq) track('faq_opened', { question_index: [...faq.querySelectorAll('details')].indexOf(d) })
  }, true)

  track('$pageview', { $referrer: document.referrer || '$direct', $referring_domain: (() => { try { return document.referrer ? slug(new URL(document.referrer).hostname) : '$direct' } catch { return '$direct' } })() })
})()
