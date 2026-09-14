export type WindowRule = { type: 'yesterday-or-last-run' } | { type: 'since-last-run' } | { type: 'today' } | { type: 'last'; ms: number; text: string } | { type: 'none' }
export interface RunWindow { start: number; end: number; label: string }
const DAY = 86_400_000, CAP = 7 * DAY
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function parseWindow(raw: string): WindowRule {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (text === 'yesterday-or-last-run' || text === 'since-last-run' || text === 'today' || text === 'none') return { type: text } as WindowRule
  const m = /^last (\d+) (hour|hours|day|days)$/.exec(text)
  if (!m) throw new Error(`"${raw}" is not a window; use yesterday-or-last-run, since-last-run, today, last N hours, last N days or none`)
  const n = Number(m[1]), days = m[2].startsWith('day')
  if (n < 1 || (days ? n > 30 : n > 720)) throw new Error('A window can reach back at most 30 days')
  return { type: 'last', ms: n * (days ? DAY : 3_600_000), text: `last ${n} ${days ? (n === 1 ? 'day' : 'days') : (n === 1 ? 'hour' : 'hours')}` }
}
export function formatWindow(w: WindowRule): string { return w.type === 'last' ? w.text : w.type }
const midnight = (at: number, offsetDays: number) => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime() }
const fmt = (at: number) => {
  const d = new Date(at)
  const day = DAY_LABEL[d.getDay()]
  const date = d.getDate()
  const month = MONTH_LABEL[d.getMonth()]
  const hour = String(d.getHours()).padStart(2, '0')
  const minute = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${date} ${month} ${hour}:${minute}`
}
export function computeWindow(rule: WindowRule, now: number, lastSuccessAt: number | null): RunWindow | null {
  let start: number
  switch (rule.type) {
    case 'none': return null
    case 'today': start = midnight(now, 0); break
    case 'last': start = now - rule.ms; break
    case 'since-last-run': start = Math.max(now - CAP, lastSuccessAt ?? midnight(now, -1)); break
    case 'yesterday-or-last-run': {
      const floor = midnight(now, -1)
      start = lastSuccessAt !== null && lastSuccessAt < floor ? Math.max(now - CAP, lastSuccessAt) : floor
    }
  }
  return { start, end: now, label: `${fmt(start)} → ${fmt(now)}` }
}
