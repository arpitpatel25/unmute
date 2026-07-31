// Unmute Remote — Claude desktop LIVE state, from the accessibility tree.
//
// The disk reader (sessions.ts) covers everything that has already happened.
// This module covers the two things that exist ONLY in the running UI:
//
//   * is a turn running right now
//   * is it stopped on a permission prompt, and what are the options
//
// Neither is ever written to disk — the same gap Codex has with its Computer
// Use consents. A pending request lives in the window and nowhere else, so a
// task blocked on one is otherwise completely invisible.
//
// READS ONLY. Every function here is a tree read, which is free and fully
// backgrounded — no focus change, nothing the user can notice. ACTUATION
// (pressing Deny, typing, sending) requires the app to be frontmost and is
// deliberately not in this file.
//
// ── Constraints this module is built around, all measured ──────────────────
//
// 1. THE TREE DOES NOT EXIST UNLESS THE APP WAS LAUNCHED WITH A FLAG.
//    `--force-renderer-accessibility`. Without it the tree is ~185 nodes of
//    menu bar and window buttons, and it fails SILENTLY — reads succeed and
//    return nothing. Note the addon sets AXManualAccessibility (see ax.mm),
//    which is the documented Electron mechanism and works for Notion/Slack —
//    but it is a verified NO-OP on this app. The launch flag is the only lever.
//
// 2. THE FLAG ALONE IS NOT ENOUGH. Launched backgrounded via `open -g`, the
//    renderer never attaches: measured 185 nodes with zero AXWebArea. After one
//    activation it became 470 with landmarks present. So "flag set" and "tree
//    alive" are different questions, and only the second one matters.
//
// 3. NO SUBROLE. The addon exposes role + label only. The spike read run status
//    from `subrole == AXApplicationStatus`, which is not reachable here, so
//    status comes from the Send/Stop button swap instead — an independent
//    signal that was verified alongside it.
//
// 4. LABELS MERGE SEVERAL ATTRIBUTES. axLabel falls back AXTitle →
//    AXDescription → AXPlaceholderValue → AXValue → AXHelp, so a button whose
//    AXDescription is "Send" arrives as label "Send".
//
// 5. DEPTH. Paths run to 33 levels of anonymous AXGroup, so getTree is called
//    with a depth well past the addon's default of 14. Positional paths are
//    useless anyway — they drift between renders with no user interaction —
//    which is why everything below matches on shape, never on position.

import { getAxBridge, type AxBridge } from '../ax/ax-bridge'
import { createLogger } from '../log'

const log = createLogger('claude-desktop-ax')

/** Claude Desktop's bundle id — what the addon resolves an app by. */
export const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop'

/** One accessibility node, exactly as the native addon returns it. */
export interface AxNode {
  id: number
  depth: number
  role: string
  label: string
  actions: string[]
}

/** A permission prompt as the UI is presenting it right now. */
export interface ClaudeConsent {
  /** The question to show the user, verbatim from the window. */
  question: string
  /** The choices, in the order the app lists them. `id` is what a press needs. */
  options: Array<{ id: number; label: string }>
}

export interface ClaudeAxState {
  /**
   * Is the renderer's tree actually present?
   *
   * FALSE means we know nothing — not that the app is idle. Every other field
   * is meaningless when this is false, and callers must treat it as "no
   * information" rather than as a negative answer. Conflating the two is how a
   * blocked task would silently read as fine.
   */
  treeAlive: boolean
  /** A turn is in flight (the Send button has become Stop). Null when unknown. */
  running: boolean | null
  /** The pending permission prompt, if one is on screen. */
  consent: ClaudeConsent | null
  /** Node count, for diagnostics and the stub check. */
  nodeCount: number
}

/**
 * Below this, the tree is the menu-bar stub rather than a real window.
 *
 * Measured: 185 nodes stubbed, 470 alive on the same app minutes apart. 200 is
 * the midpoint of a gap with nothing in it, not a tuned threshold — and it is
 * only ever a fallback, because the landmark check below is the real test.
 */
export const STUB_NODE_CEILING = 200

/** Roles that only exist once the renderer has attached. */
const RENDERER_ROLES = new Set(['AXWebArea', 'AXLandmarkMain', 'AXLandmarkComplementary'])

/**
 * Is this a live renderer tree, or the stub?
 *
 * Presence of a renderer-only role is the primary test because it states the
 * thing we actually care about. The node count is a backstop for a build that
 * renames landmarks — it would keep working where a pure role check would start
 * reporting every window as dead.
 */
export function isTreeAlive(nodes: AxNode[]): boolean {
  if (nodes.some((n) => RENDERER_ROLES.has(n.role))) return true
  return nodes.length > STUB_NODE_CEILING
}

/**
 * Is a turn running?
 *
 * The composer's primary button IS the signal: it reads Send while you may
 * type, and becomes Stop while the agent is working — one control, two labels.
 * So Stop present ⇒ running; Send present ⇒ not running; neither ⇒ unknown,
 * which is reported as null rather than guessed, because "no button found"
 * usually means the locator broke, not that the app is idle.
 */
export function readRunning(nodes: AxNode[]): boolean | null {
  let sawSend = false
  let sawStop = false
  for (const n of nodes) {
    if (n.role !== 'AXButton') continue
    const l = n.label.trim().toLowerCase()
    if (l === 'stop' || l.startsWith('stop ')) sawStop = true
    else if (l === 'send' || l.startsWith('send ')) sawSend = true
  }
  if (sawStop) return true
  if (sawSend) return false
  return null
}

/** A leaf that reads like a question being asked of the user. */
function isQuestion(n: AxNode): boolean {
  const l = n.label.trim()
  return l.endsWith('?') && l.length > 8
}

/**
 * Find the pending permission prompt, structurally.
 *
 * DELIBERATELY NOT MATCHED ON UI COPY. It would be easy to look for
 * "Allow Claude to…" and be done, but every label here is English product copy:
 * it is localized (this machine is en_GB; a French UI breaks every literal) and
 * it changes between releases. A prompt that stops being recognised is the
 * worst failure this feature has — the task silently looks fine while it is
 * actually stuck waiting for the user.
 *
 * So the shape is the matcher: a question leaf, followed closely by a small
 * group of buttons. That is what a permission prompt IS, in any language.
 *
 * Option labels are returned verbatim and carry their own shortcut digits
 * ("Deny 1", "Allow once 3 ⌘ ⏎"), so callers must never compare them by
 * equality — which is exactly why the option id, not its text, is what a press
 * will use later.
 */
export function readConsent(nodes: AxNode[], opts: { maxOptions?: number; window?: number } = {}): ClaudeConsent | null {
  const maxOptions = opts.maxOptions ?? 6
  // How far past the question we will look for its buttons. Generous because
  // the tree interleaves anonymous groups, tight enough that a button belonging
  // to some other part of the UI cannot be swept in.
  const window = opts.window ?? 24

  // Last question wins: if the transcript contains older questions as static
  // text, the LIVE prompt is the one nearest the end of the document order.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const q = nodes[i]
    if (!isQuestion(q)) continue

    const options: Array<{ id: number; label: string }> = []
    for (let j = i + 1; j < Math.min(nodes.length, i + 1 + window); j++) {
      const n = nodes[j]
      if (n.role !== 'AXButton') continue
      if (!n.label.trim()) continue
      // A pressable button is the only thing that can answer a prompt.
      if (n.actions.length && !n.actions.includes('AXPress')) continue
      options.push({ id: n.id, label: n.label.trim() })
      if (options.length > maxOptions) break
    }

    // Two is the minimum that is a CHOICE. One button is a dismissable notice,
    // and more than a handful is a toolbar we have wandered into.
    if (options.length >= 2 && options.length <= maxOptions) {
      return { question: q.label.trim(), options }
    }
  }
  return null
}

/** One sidebar row: a task, and whatever status the app is showing beside it. */
export interface ClaudeSidebarRow {
  /** The task title, as matched against the store. */
  title: string
  /** The text the row carries BEYOND its title — the app's own status word.
   *  Empty string when the row is just a title. */
  status: string
  /** The row's node id, for a later open/press. */
  id: number
}

/**
 * Read per-task status for EVERY task, from one tree read.
 *
 * This is the important one, and it was found by dumping the real window
 * rather than by reasoning: sidebar rows are buttons whose label is
 * `"<status> <title>"` — e.g. `"Idle Season preference questions"`.
 *
 * Why it matters so much: Send/Stop describes only the ONE conversation
 * currently open, and only one is ever addressable (AXWindows is always empty
 * on this app). Without the sidebar, answering "which of my tasks is blocked"
 * would mean opening each one in turn — visibly, in the user's face. This
 * answers it for all of them, in the background, in a single read.
 *
 * NO STATUS VOCABULARY IS HARDCODED. The caller supplies the titles it already
 * knows from disk, and the status is defined as whatever the row says beyond
 * its title. Only "Idle" has been observed so far, and inventing a table from
 * one sample would break on the first unseen value — which would be the
 * interesting one, since a blocked task is never idle.
 *
 * AMBIGUITY IS REPORTED, NOT GUESSED. Titles are not unique — a real sidebar
 * carried "Review Electron dictation and chat app codebase" three times — and
 * they are user-editable. So a title matching several rows yields a status only
 * when those rows AGREE; otherwise the answer is null. Attributing one task's
 * status to another is worse than admitting we cannot tell.
 *
 * THE SIDEBAR IS WINDOWED, and this bounds what the function can ever answer.
 * Measured against a real store: 32 titles on disk, 19 rows readable, and a
 * "Show 20 more in Recents" button holding the rest. A task the sidebar is not
 * currently showing simply has no row, and reports null — correctly, but it
 * means status is available for RECENT tasks only. Anything relying on this
 * must degrade to the disk signals rather than treat a missing row as a state.
 */
export function readSidebarRows(nodes: AxNode[], titles: readonly string[]): ClaudeSidebarRow[] {
  // Longest first: a title that is a prefix of another must not win the match.
  const sorted = [...new Set(titles.filter(Boolean))].sort((a, b) => b.length - a.length)
  const rows: ClaudeSidebarRow[] = []
  for (const n of nodes) {
    if (n.role !== 'AXButton' || !n.label) continue
    const label = n.label.trim()
    for (const t of sorted) {
      if (!label.endsWith(t)) continue
      rows.push({ title: t, status: label.slice(0, label.length - t.length).trim(), id: n.id })
      break
    }
  }
  return rows
}

/**
 * The status the app shows for one title, or null when it cannot be known.
 *
 * Null covers both "no row found" and "several rows disagree". Callers must
 * treat it as no-information — the same discipline as treeAlive:false.
 */
export function statusForTitle(rows: readonly ClaudeSidebarRow[], title: string): string | null {
  const hits = rows.filter((r) => r.title === title)
  if (!hits.length) return null
  const first = hits[0].status
  return hits.every((h) => h.status === first) ? first : null
}

/** Derive everything readable in one pass over one tree read. */
export function readState(nodes: AxNode[]): ClaudeAxState {
  const treeAlive = isTreeAlive(nodes)
  if (!treeAlive) {
    return { treeAlive: false, running: null, consent: null, nodeCount: nodes.length }
  }
  return {
    treeAlive: true,
    running: readRunning(nodes),
    consent: readConsent(nodes),
    nodeCount: nodes.length,
  }
}

export interface ClaudeAxDeps {
  bridge?: AxBridge
  bundleId?: string
  /** Tree depth. Well past the addon's default of 14 — see note 5 above. */
  maxDepth?: number
}

/**
 * Reads Claude Desktop's live UI state through the shared native AX bridge.
 *
 * Uses the same addon and the same single Accessibility grant as the rest of
 * Unmute rather than shipping a second mechanism.
 */
export class ClaudeDesktopAx {
  private readonly bundleId: string
  private readonly maxDepth: number

  constructor(private readonly deps: ClaudeAxDeps = {}) {
    this.bundleId = deps.bundleId ?? CLAUDE_BUNDLE_ID
    this.maxDepth = deps.maxDepth ?? 40
  }

  private bridge(): AxBridge {
    return this.deps.bridge ?? getAxBridge()
  }

  /** One tree read. Empty on any failure — never throws into a poll. */
  async nodes(): Promise<AxNode[]> {
    try {
      const out = await this.bridge().call('getTree', [this.bundleId, 0, '', this.maxDepth, true])
      if (!out || out.error) {
        log.debug('ax-tree-unavailable', { error: out?.error ?? 'no result' })
        return []
      }
      const raw = (out.nodes ?? out.tree ?? []) as unknown[]
      return raw.filter((n): n is AxNode => !!n && typeof n === 'object' && 'role' in (n as object))
    } catch (e) {
      log.debug('ax-tree-threw', { error: (e as Error).message })
      return []
    }
  }

  /** Live state, or a treeAlive:false snapshot meaning "we know nothing". */
  async state(): Promise<ClaudeAxState> {
    return readState(await this.nodes())
  }

  /** Per-task status for every supplied title, from ONE read. Empty when the
   *  tree is not alive, so callers cannot mistake a stub for "all idle". */
  async sidebar(titles: readonly string[]): Promise<ClaudeSidebarRow[]> {
    const nodes = await this.nodes()
    if (!isTreeAlive(nodes)) return []
    return readSidebarRows(nodes, titles)
  }
}
