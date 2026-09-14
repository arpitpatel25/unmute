export type Schedule =
  | { type: 'clock'; days: number[]; hour: number; minute: number }
  | { type: 'interval'; everyMs: number }
  | { type: 'event'; event: 'meeting-notes-ready' }

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ALL = [0, 1, 2, 3, 4, 5, 6], WEEKDAYS = [1, 2, 3, 4, 5], WEEKENDS = [0, 6]
const MIN_INTERVAL_MS = 15 * 60_000

function parseTime(text: string): { hour: number; minute: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (!m) throw new Error(`"${text}" is not a time; use HH:MM, e.g. 09:00`)
  return { hour: Number(m[1]), minute: Number(m[2]) }
}
function parseDays(text: string): number[] {
  if (text === 'daily') return ALL
  if (text === 'weekdays') return WEEKDAYS
  if (text === 'weekends') return WEEKENDS
  const days = text.split(',').map(part => {
    const key = part.trim().replace(/days?$/, '').slice(0, 3)
    const index = DAY_NAMES.indexOf(key)
    if (index < 0) throw new Error(`"${part}" is not a day in a schedule`)
    return index
  })
  return [...new Set(days)].sort((a, b) => a - b)
}
export function parseSchedule(raw: string): Schedule {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (text === 'on meeting-notes-ready') return { type: 'event', event: 'meeting-notes-ready' }
  const every = /^every (\d+) (minute|minutes|hour|hours)$/.exec(text)
  if (every) {
    const everyMs = Number(every[1]) * (every[2].startsWith('hour') ? 3_600_000 : 60_000)
    if (everyMs < MIN_INTERVAL_MS) throw new Error('A repeating schedule must be at least 15 minutes apart')
    return { type: 'interval', everyMs }
  }
  const clock = /^(\S+) (\S+)$/.exec(text)
  if (!clock) throw new Error(`"${raw}" is not a schedule; try "weekdays 09:00", "every 4 hours" or "on meeting-notes-ready"`)
  return { type: 'clock', days: parseDays(clock[1]), ...parseTime(clock[2]) }
}
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i])
export function formatSchedule(s: Schedule): string {
  if (s.type === 'event') return 'on meeting-notes-ready'
  if (s.type === 'interval') return s.everyMs % 3_600_000 === 0 ? `every ${s.everyMs / 3_600_000} hours` : `every ${s.everyMs / 60_000} minutes`
  const days = same(s.days, ALL) ? 'daily' : same(s.days, WEEKDAYS) ? 'weekdays' : same(s.days, WEEKENDS) ? 'weekends' : s.days.map(d => DAY_NAMES[d]).join(',')
  return `${days} ${hhmm(s.hour, s.minute)}`
}
export function describeSchedule(s: Schedule): string {
  if (s.type === 'event') return 'When meeting notes are ready'
  if (s.type === 'interval') {
    const hours = s.everyMs / 3_600_000
    return Number.isInteger(hours) ? `Every ${hours === 1 ? 'hour' : `${hours} hours`}` : `Every ${s.everyMs / 60_000} minutes`
  }
  const days = same(s.days, ALL) ? 'Daily' : same(s.days, WEEKDAYS) ? 'Weekdays' : same(s.days, WEEKENDS) ? 'Weekends' : s.days.map(d => DAY_LABEL[d]).join(', ')
  return `${days} at ${hhmm(s.hour, s.minute)}`
}
export function nextFireAt(s: Schedule, after: number): number | null {
  if (s.type === 'event') return null
  if (s.type === 'interval') return after + s.everyMs
  const base = new Date(after)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, s.hour, s.minute, 0, 0)
    if (candidate.getTime() > after && s.days.includes(candidate.getDay())) return candidate.getTime()
  }
  return null
}
export function describeNext(at: number | null, now: number): string {
  if (at === null) return 'After your next meeting'
  const d = new Date(at), n = new Date(now)
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 86_400_000)
  const time = hhmm(d.getHours(), d.getMinutes())
  if (dayDiff === 0) return `Today ${time}`
  if (dayDiff === 1) return `Tomorrow ${time}`
  return `${DAY_LABEL[d.getDay()]} ${time}`
}
