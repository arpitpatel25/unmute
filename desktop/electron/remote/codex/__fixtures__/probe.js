(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const px = v => Math.round(parseFloat(v) * 100) / 100
  const cs = el => getComputedStyle(el)
  const box = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const typ = el => { const s = cs(el); return { size: px(s.fontSize), weight: s.fontWeight, lineHeight: s.lineHeight === 'normal' ? 'normal' : px(s.lineHeight), color: s.color } }

  const scroller = [...document.querySelectorAll('div')].find(d => Math.round(d.getBoundingClientRect().x) === 275 && d.scrollHeight > d.clientHeight)
  if (scroller) { scroller.scrollTop = 0; await sleep(700) }

  const out = { lists: [], rows: [], icons: [] }

  for (const ul of [...document.querySelectorAll('ul')]) {
    const r = ul.getBoundingClientRect()
    if (r.width < 200) continue          // sidebar navs are narrow
    const li = ul.querySelector(':scope > li')
    const s = cs(ul)
    out.lists.push({
      x: Math.round(r.x), w: Math.round(r.width),
      listStyleType: s.listStyleType, paddingLeft: px(s.paddingLeft), paddingInlineStart: px(s.paddingInlineStart),
      marginTop: px(s.marginTop), marginBottom: px(s.marginBottom), gap: s.gap,
      item: li ? { ...typ(li), marginBottom: px(cs(li).marginBottom), paddingLeft: px(cs(li).paddingLeft) } : null,
      marker: li ? { content: getComputedStyle(li, '::marker').content, color: getComputedStyle(li, '::marker').color } : null,
      nested: (() => { const n = ul.querySelector('ul'); return n ? { type: cs(n).listStyleType, padLeft: px(cs(n).paddingInlineStart), marginTop: px(cs(n).marginTop) } : null })(),
    })
    if (out.lists.length >= 3) break
  }

  const leaf = e => e.children.length === 0 && (e.innerText || '').trim()
  const all = [...document.querySelectorAll('*')]

  for (const re of [/^Work(ed|ing) for /, /^Used /, /^Ran commands/, /^Loaded a tool/]) {
    const el = all.find(e => leaf(e) && re.test(e.innerText.trim()) && e.getBoundingClientRect().width > 40)
    if (!el) continue
    const entry = { text: el.innerText.trim().slice(0, 70), ...typ(el), box: box(el) }
    let row = el.parentElement
    for (let i = 0; i < 4 && row; i++, row = row.parentElement) if (row.querySelector('svg')) break
    if (row?.querySelector('svg')) {
      const s = cs(row), svg = row.querySelector('svg')
      entry.row = { box: box(row), gap: s.gap, padding: s.padding, alignItems: s.alignItems }
      entry.icon = { box: box(svg), viewBox: svg.getAttribute('viewBox'), stroke: cs(svg).stroke, strokeWidth: cs(svg).strokeWidth, fill: cs(svg).fill, opacity: cs(svg).opacity,
                     d: [...svg.querySelectorAll('path')].map(p => (p.getAttribute('d') || '').slice(0, 140)) }
    }
    out.rows.push(entry)
  }

  const withBorder = all.filter(e => { const s = cs(e); const r = e.getBoundingClientRect(); return parseFloat(s.borderBottomWidth) > 0 && r.width > 300 && r.x > 400 })
  if (withBorder.length) out.rule = { border: cs(withBorder[0]).borderBottom, width: Math.round(withBorder[0].getBoundingClientRect().width) }

  const spans = all.filter(e => leaf(e) && /^[a-z0-9_./-]+\.(md|ts|json|sh)$|^[a-z-]+\/[a-z-]+$/i.test(e.innerText.trim()) && e.getBoundingClientRect().x > 400)
  if (spans.length) { const c = spans[0], s = cs(c); out.codeChip = { text: c.innerText.trim(), ...typ(c), font: s.fontFamily.split(',')[0], background: s.backgroundColor, padding: s.padding, borderRadius: px(s.borderRadius) } }

  return out
})()
