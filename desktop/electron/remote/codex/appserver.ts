// Codex app-server — the OFFICIAL control channel.
//
// Codex ships a versioned, schema-generating JSON-RPC protocol
// (`codex app-server generate-json-schema`). `model/list` returns the real
// model catalogue in ~1ms, headless: no window, no `--remote-debugging-port`,
// no focus steal, no DOM selectors.
//
// WHY THIS REPLACES THE MENU SCRAPE. readAxisOptions() opened Codex's reasoning
// menu over CDP, hovered each axis row, waited 800ms and diffed the DOM. It
// took seconds, required the app to be armed, and returned "Advanced" as the
// only value for every axis whenever the submenu had not opened in time — which
// is what shipped. The protocol cannot fail that way: it either answers or it
// does not.
//
// It also carries things the DOM never exposed: per-model SUPPORTED EFFORTS and
// each model's DEFAULT effort. Efforts are a property OF a model — Luna offers
// five, Sol offers six — so the effort list has to follow the model, which a
// flat scrape could not express.
//
// CDP is still the write path (setReasoningAxis) so the change lands in the app
// the user is actually looking at. Read here, write there.
import { spawn } from 'node:child_process'
import { createLogger } from '../log'

const log = createLogger('codex-appserver')

/** The Codex CLI bundled inside the desktop app — a desktop-only user has it. */
export const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex'

export interface CodexModel {
  /** Wire id, e.g. "gpt-5.6-sol". */
  id: string
  /** What Codex calls it in the protocol, e.g. "GPT-5.6-Sol". */
  label: string
  /**
   * What Codex calls it IN ITS OWN MENUS, e.g. "5.6 Sol".
   *
   * The protocol and the UI use different spellings for the same model, and the
   * WRITE path is CDP — it finds a menu item by text. Sending the protocol name
   * matched nothing and failed silently: the pick fired, the log recorded the
   * choice, and the menu never moved. The button label ("5.6 Sol High") is the
   * proof of which spelling the UI uses.
   */
  uiLabel: string
  description?: string
  /** Reasoning efforts THIS model supports, as WIRE values, in Codex's order. */
  efforts: string[]
  /**
   * The same efforts spelled the way Codex's menu prints them, index-aligned
   * with `efforts`. Both are kept rather than one derived on the fly: the wire
   * value is the protocol's identity and the label is what a click has to find,
   * and collapsing them is how "xhigh" came to be sent to a menu that says
   * "Extra High".
   */
  effortLabels: string[]
  /** The effort Codex starts this model on. */
  defaultEffort?: string
}

/** Shape of one `model/list` row we care about. */
interface RawModel {
  model?: string
  id?: string
  displayName?: string
  description?: string
  hidden?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>
}

export interface ListModelsDeps {
  /** Overridable for tests — must speak line-delimited JSON-RPC on stdio. */
  bin?: string
  timeoutMs?: number
}

/**
 * Ask Codex for its model catalogue.
 *
 * Resolves `[]` on any failure — a missing Codex, a protocol change, a timeout.
 * The caller renders an honest empty state ("Connect Codex to choose a model")
 * rather than falling back to the other platform's list, which is precisely the
 * bug that made picking a Codex model write Claude's setting.
 */
export async function listCodexModels(deps: ListModelsDeps = {}): Promise<CodexModel[]> {
  const bin = deps.bin ?? BUNDLED_CODEX
  const timeoutMs = deps.timeoutMs ?? 8000

  return await new Promise<CodexModel[]>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      log.warn('app-server spawn failed', { error: (e as Error).message })
      return resolve([])
    }

    let settled = false
    const done = (models: CodexModel[]) => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* already gone */ }
      resolve(models)
    }

    const timer = setTimeout(() => {
      log.warn('model/list timed out', { timeoutMs })
      done([])
    }, timeoutMs)

    const send = (o: unknown) => {
      try { child.stdin?.write(JSON.stringify(o) + '\n') } catch { done([]) }
    }

    let buf = ''
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let i: number
      // Line-delimited JSON-RPC. A partial line stays in the buffer.
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let msg: { id?: number; result?: { data?: RawModel[] } }
        try { msg = JSON.parse(line) } catch { continue }

        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })
        } else if (msg.id === 2) {
          clearTimeout(timer)
          done(parseModels(msg.result?.data ?? []))
        }
      }
    })
    child.stderr?.on('data', () => { /* Codex is chatty; not our business */ })
    child.on('error', (e) => { log.warn('app-server errored', { error: e.message }); clearTimeout(timer); done([]) })
    child.on('exit', () => { clearTimeout(timer); done([]) })

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'unmute', version: '1' } },
    })
  })
}

/**
 * Protocol spelling → menu spelling. "GPT-5.6-Sol" → "5.6 Sol".
 *
 * Codex drops the vendor prefix and uses spaces in its own UI; the reasoning
 * button's label is the evidence. Exported so the mapping is testable rather
 * than an inline regex nobody can see.
 */
export function toUiLabel(displayName: string): string {
  return displayName.replace(/^gpt[-\s]*/i, '').replace(/-/g, ' ').trim()
}

/**
 * Effort wire value → the words Codex prints in its own menu.
 *
 * NOT GUESSED. Lifted from Codex's own i18n table inside app.asar, keyed
 * `composer.mode.local.reasoning.<effort>.label` — the exact strings that
 * render in the composer's reasoning menu, which is the control we click.
 *
 * Two of them are not the wire value with a capital letter, which is why
 * assuming would have failed: `low` prints as "Light" and `xhigh` as
 * "Extra High". Picking either wrote nothing and reported success.
 *
 * Unknown efforts (a future tier) fall through to Title Case — the honest
 * default — and the writer now logs what the menu actually offered when the
 * value is not found, so the next surprise announces itself.
 */
const EFFORT_UI_LABEL: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
}

export function toEffortUiLabel(effort: string): string {
  const key = effort.trim().toLowerCase()
  return EFFORT_UI_LABEL[key] ?? (key ? key[0].toUpperCase() + key.slice(1) : '')
}

const efforts = (m: RawModel): string[] =>
  (m.supportedReasoningEfforts ?? []).map((e) => String(e?.reasoningEffort ?? '')).filter(Boolean)

/** Hidden models are Codex's own business — never offer them. */
export function parseModels(rows: RawModel[]): CodexModel[] {
  return rows
    .filter((m) => m && m.hidden !== true)
    .map((m) => ({
      id: String(m.model ?? m.id ?? ''),
      label: String(m.displayName ?? m.model ?? m.id ?? ''),
      uiLabel: toUiLabel(String(m.displayName ?? m.model ?? m.id ?? '')),
      description: m.description,
      efforts: efforts(m),
      effortLabels: efforts(m).map(toEffortUiLabel),
      defaultEffort: m.defaultReasoningEffort,
    }))
    .filter((m) => m.id !== '')
}

/**
 * Which model/effort is live, read from the reasoning button's own label
 * ("5.6 Sol High").
 *
 * The label was the ONE part of the CDP read that never failed — every logged
 * read returned it correctly, while `current` came back empty about a third of
 * the time. Matching it against the real catalogue is both more reliable than
 * the axis walk and cheaper.
 *
 * Reports the UI spelling, because ONE VOCABULARY travels downstream: the value
 * shown in the panel is the value handed back on a pick, and the pick is a menu
 * search. Reporting "GPT-5.6-Luna" here while the panel listed "5.6 Luna" also
 * meant `current` matched no row, so nothing ever read as selected.
 */
export function matchCurrent(label: string | null, models: CodexModel[]): {
  model?: string; effort?: string
} {
  if (!label) return {}
  const flat = label.toLowerCase().replace(/[\s-]+/g, '')
  // Longest label first, so "GPT-5.6-Sol" cannot be shadowed by "GPT-5.6".
  const model = [...models]
    .sort((a, b) => b.label.length - a.label.length)
    .find((m) => flat.includes(m.label.toLowerCase().replace(/[\s-]+/g, '').replace(/^gpt/, '')))
  // Match the button against the LABELS — the button prints "5.6 Sol Extra
  // High", never "5.6 Sol xhigh".
  const labels = model?.effortLabels ?? []
  const effort = [...labels]
    .sort((a, b) => b.length - a.length)
    .find((e) => flat.endsWith(e.toLowerCase().replace(/[\s-]+/g, '')))
  // Build conditionally: `{ model: undefined }` is not the same as `{}`. The
  // key would survive JSON as an explicit absence and read downstream as "we
  // looked and there is none" rather than "we could not tell".
  const out: { model?: string; effort?: string } = {}
  if (model) out.model = model.uiLabel
  if (effort) out.effort = effort
  return out
}
