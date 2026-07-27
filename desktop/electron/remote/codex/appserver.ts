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
  /** What Codex calls it, e.g. "GPT-5.6-Sol". */
  label: string
  description?: string
  /** Reasoning efforts THIS model supports, in Codex's own order. */
  efforts: string[]
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

/** Hidden models are Codex's own business — never offer them. */
export function parseModels(rows: RawModel[]): CodexModel[] {
  return rows
    .filter((m) => m && m.hidden !== true)
    .map((m) => ({
      id: String(m.model ?? m.id ?? ''),
      label: String(m.displayName ?? m.model ?? m.id ?? ''),
      description: m.description,
      efforts: (m.supportedReasoningEfforts ?? [])
        .map((e) => String(e?.reasoningEffort ?? ''))
        .filter(Boolean),
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
  const efforts = model?.efforts ?? []
  const effort = [...efforts].sort((a, b) => b.length - a.length).find((e) => flat.endsWith(e.toLowerCase()))
  // Build conditionally: `{ model: undefined }` is not the same as `{}`. The
  // key would survive JSON as an explicit absence and read downstream as "we
  // looked and there is none" rather than "we could not tell".
  const out: { model?: string; effort?: string } = {}
  if (model) out.model = model.label
  if (effort) out.effort = effort
  return out
}
