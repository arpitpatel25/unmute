// Slash-command catalogue for the chat composer.
//
// TWO PROVIDERS, ONE MENU. Claude and Codex each publish their own commands and
// each runs them with its own syntax (`/name` for Claude, `$name` for Codex), so
// the menu ALWAYS shows the list the task's own provider reported and inserts
// that provider's token. Nothing is invented: a name we cannot prove the
// provider knows is never offered, because offering it produces a turn that
// reads the slash as prose and answers something else entirely.
//
// THE UNION HAPPENS UPSTREAM, NOT HERE. A skill only one side owns is made
// visible to the other before the list is asked for — Claude gets the other
// side's skills through `--add-dir` (a bridge directory of symlinks laid out
// the way Claude expects), Codex gets Claude's through `skills/extraRoots/set`
// (CodexHub). By the time we list, both providers answer for themselves.

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('skill-catalog')

export type CommandProvider = 'claude' | 'codex'

/** One row of the composer's slash menu. `token` is what gets typed into the
 *  draft — provider-native and never re-derived downstream. */
export interface CommandItem {
  name: string
  title: string
  description: string
  argumentHint: string
  scope: string
  token: string
}

/** A row of Claude's `initialize` response. */
export interface ClaudeCommandRaw { name: string; description?: string; argumentHint?: string }

/** A row of Codex's `skills/list`. */
export interface CodexSkillRaw { name: string; description?: string; path?: string; scope?: string; enabled?: boolean }

/**
 * Claude built-ins that only mean something in the interactive REPL.
 *
 * Sending these into a headless chat either does nothing or, worse, quietly
 * changes a setting the card's own controls own. `deliverDraft` already refuses
 * a bare /clear, /compact, /model, /permissions, /resume and /quit; this list is
 * the display half of the same judgement, so the menu never offers a command
 * whose only outcome is an error message.
 */
const CLAUDE_REPL_ONLY = new Set([
  'agents', 'autocompact', 'auto-mode-setup', 'clear', 'color', 'compact', 'config', 'context', 'effort',
  'fast', 'heapdump', 'import', 'insights', 'mcp', 'model', 'output-style', 'permissions', 'quit',
  'recap', 'reload-plugins', 'reload-skills', 'rename', 'resume', 'usage', 'usage-credits', 'extra-usage',
  'design-consent', 'design-revoke', 'list-agents', 'advisor', 'goal',
  '__remote-workflow', 'workflow-launch-exec',
])

/** Claude marks provenance by appending "(user)" or "(project)" to the
 *  description. Plugin skills carry a `plugin:skill` name instead. */
function claudeScope(name: string, description: string): { scope: string; description: string } {
  const tagged = /^([\s\S]*)\(([^()]{1,24})\)\s*$/.exec(description)
  const tag = tagged?.[2]?.toLowerCase()
  if (tag === 'user') return { scope: 'Personal', description: tagged![1]!.trim() }
  if (tag === 'project') return { scope: 'Project', description: tagged![1]!.trim() }
  if (name.includes(':')) return { scope: 'Plugin', description }
  return { scope: 'Built-in', description }
}

function codexScope(scope: string | undefined): string {
  return scope === 'user' ? 'Personal' : scope === 'repo' ? 'Project' : scope === 'admin' ? 'Admin' : scope === 'system' ? 'System' : ''
}

/** A one-line, menu-sized description. Skill frontmatter runs to paragraphs. */
function oneLine(text: string, limit = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Title Case a skill name for the menu's leading label ("frontend-design" →
 *  "Frontend Design"), keeping any plugin prefix intact. */
export function titleFor(name: string): string {
  const [prefix, bare] = name.includes(':') ? [`${name.slice(0, name.indexOf(':'))}: `, name.slice(name.indexOf(':') + 1)] : ['', name]
  const words = bare.split(/[-_.]/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1))
  return `${prefix}${words.join(' ')}`.trim()
}

function sortItems(items: CommandItem[]): CommandItem[] {
  // Skills first, built-ins after: the built-ins are the ones a person already
  // knows, and the skills are what they opened the menu to find.
  const rank = (i: CommandItem) => (i.scope === 'Built-in' ? 1 : 0)
  return items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function claudeCommandItems(raw: ClaudeCommandRaw[]): CommandItem[] {
  const seen = new Set<string>()
  const items: CommandItem[] = []
  for (const row of raw) {
    const name = (row.name ?? '').trim()
    if (!name || CLAUDE_REPL_ONLY.has(name) || seen.has(name)) continue
    seen.add(name)
    const { scope, description } = claudeScope(name, String(row.description ?? ''))
    items.push({
      name, title: titleFor(name), description: oneLine(description),
      argumentHint: String(row.argumentHint ?? '').trim(), scope, token: `/${name}`,
    })
  }
  return sortItems(items)
}

export function codexCommandItems(raw: CodexSkillRaw[]): CommandItem[] {
  const seen = new Set<string>()
  const items: CommandItem[] = []
  for (const row of raw) {
    const name = (row.name ?? '').trim()
    // The same skill is reported once per root it is installed in.
    if (!name || row.enabled === false || seen.has(name)) continue
    seen.add(name)
    items.push({
      name, title: titleFor(name), description: oneLine(String(row.description ?? '')),
      argumentHint: '', scope: codexScope(row.scope), token: `$${name}`,
    })
  }
  return sortItems(items)
}

// ── The Codex-to-Claude bridge ─────────────────────────────────────────────

/** Where the symlink trees live. One per cwd: `--add-dir` is per session, so a
 *  project's skills never leak into another project's chat. */
export function bridgeDirFor(cwd: string, baseDir?: string): string {
  const root = baseDir ?? join(homedir(), '.unmute', 'remote', 'skill-bridge')
  return join(root, 'claude', createHash('sha256').update(cwd).digest('hex').slice(0, 16))
}

/** A skill name we are willing to put on disk as a directory entry. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

async function namesIn(dir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(dir)
    return new Set(entries.map(e => e.replace(/\.md$/, '')))
  } catch { return new Set() }
}

/**
 * Publish the Codex skills Claude cannot see into a bridge directory, as
 * symlinks Claude auto-discovers through `--add-dir`.
 *
 * Symlinks, not copies: a skill edited in place stays edited, and nothing here
 * can drift from the file the other provider actually runs. Names Claude
 * already owns are skipped so the menu never shows one skill twice, and
 * plugin-namespaced names are skipped because a colon in a path is not the same
 * thing as a plugin.
 */
export async function syncClaudeBridge(
  cwd: string,
  codexSkills: CodexSkillRaw[],
  opts: { baseDir?: string; homeDir?: string } = {},
): Promise<string> {
  const home = opts.homeDir ?? homedir()
  const dir = bridgeDirFor(cwd, opts.baseDir)
  const skillsDir = join(dir, '.claude', 'skills')
  const native = new Set([
    ...await namesIn(join(home, '.claude', 'skills')),
    ...await namesIn(join(cwd, '.claude', 'skills')),
  ])
  const wanted = new Map<string, string>()
  for (const skill of codexSkills) {
    const name = (skill.name ?? '').trim()
    if (!name || skill.enabled === false || native.has(name) || name.includes(':') || !SAFE_NAME.test(name)) continue
    const file = skill.path
    if (!file) continue
    // `path` points at the SKILL.md; Claude discovers the directory holding it.
    const source = file.endsWith('.md') ? dirname(file) : file
    if (source && source !== '.') wanted.set(name, source)
  }
  await fs.mkdir(skillsDir, { recursive: true, mode: 0o700 })
  // Reconcile rather than rebuild: a removed skill must disappear, and a link
  // that already points at the right place must not be churned under a live
  // session that has the directory open.
  for (const entry of await fs.readdir(skillsDir).catch(() => [] as string[])) {
    const keep = wanted.get(entry)
    const current = await fs.readlink(join(skillsDir, entry)).catch(() => null)
    if (keep && current === keep) { wanted.delete(entry); continue }
    await fs.rm(join(skillsDir, entry), { recursive: true, force: true }).catch(() => {})
  }
  for (const [name, source] of wanted) {
    await fs.symlink(source, join(skillsDir, name)).catch(error => {
      log.warn('bridge link failed', { name, error: (error as Error).message })
    })
  }
  return dir
}

/** The roots Codex is told to read on top of its own, so Claude's personal
 *  skills answer to `$name` in a Codex chat. Global (one shared app-server), so
 *  only user-level roots belong here — a project's skills would leak. */
export function codexExtraRoots(homeDir?: string): string[] {
  return [join(homeDir ?? homedir(), '.claude', 'skills')]
}

// ── The cache ──────────────────────────────────────────────────────────────

export interface SkillCatalogDeps {
  /** Ask Claude for its commands in this cwd, with the bridge already linked. */
  claudeCommands: (cwd: string, addDirs: string[]) => Promise<ClaudeCommandRaw[]>
  /** Ask Codex for the skills it can see in this cwd. */
  codexSkills: (cwd: string) => Promise<CodexSkillRaw[]>
  /** Called when a refresh changed a list, so the UI can be pushed. */
  onUpdated?: () => void
  baseDir?: string
  homeDir?: string
  ttlMs?: number
  now?: () => number
}

interface Entry { items: CommandItem[]; at: number; loading: boolean }

/**
 * Per-(provider, cwd) command lists, refreshed in the background.
 *
 * The read is SYNCHRONOUS and never blocks a notch payload: a cold cwd returns
 * an empty list and schedules the probe, and the composer simply has no menu
 * until the answer lands — which is the honest state, and a second later it is
 * there. Blocking the surface on a CLI handshake would stall every card open
 * instead.
 */
export class SkillCatalog {
  private entries = new Map<string, Entry>()
  private bridges = new Map<string, Promise<string>>()
  /** In-flight probes, so a background refresh and an awaited one are the SAME
   *  read. Returning the stale list to the awaiting caller looked like a cold
   *  cache and hid the answer that was already on its way. */
  private inflight = new Map<string, Promise<CommandItem[]>>()

  constructor(private readonly deps: SkillCatalogDeps) {}

  private key(provider: CommandProvider, cwd: string): string { return `${provider}::${cwd}` }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private ttl(): number { return this.deps.ttlMs ?? 5 * 60_000 }

  /** Cached commands for this task's provider and cwd; refreshes when stale. */
  commands(provider: CommandProvider, cwd: string): CommandItem[] {
    if (!cwd) return []
    const entry = this.entries.get(this.key(provider, cwd))
    if (!entry || (!entry.loading && this.now() - entry.at > this.ttl())) void this.refresh(provider, cwd)
    return entry?.items ?? []
  }

  /** The extra directories a Claude session must be launched with for the
   *  bridged skills to exist for that session. Safe to call on every connect. */
  async claudeAddDirs(cwd: string): Promise<string[]> {
    if (!cwd) return []
    const pending = this.bridges.get(cwd)
    if (pending) return [await pending].filter(Boolean)
    const build = (async () => {
      const skills = await this.deps.codexSkills(cwd).catch(() => [] as CodexSkillRaw[])
      return await syncClaudeBridge(cwd, skills, { baseDir: this.deps.baseDir, homeDir: this.deps.homeDir })
    })()
    this.bridges.set(cwd, build)
    try { return [await build] }
    catch (error) { this.bridges.delete(cwd); log.warn('bridge sync failed', { cwd, error: (error as Error).message }); return [] }
  }

  /** Force the next read to re-probe (a new skill was written, a session ended). */
  invalidate(): void { this.entries.clear(); this.bridges.clear() }

  async refresh(provider: CommandProvider, cwd: string): Promise<CommandItem[]> {
    const key = this.key(provider, cwd)
    const pending = this.inflight.get(key)
    if (pending) return pending
    const run = this.probe(provider, cwd, key)
    this.inflight.set(key, run)
    try { return await run } finally { this.inflight.delete(key) }
  }

  private async probe(provider: CommandProvider, cwd: string, key: string): Promise<CommandItem[]> {
    const existing = this.entries.get(key)
    this.entries.set(key, { items: existing?.items ?? [], at: this.now(), loading: true })
    let items: CommandItem[] = existing?.items ?? []
    try {
      if (provider === 'codex') {
        items = codexCommandItems(await this.deps.codexSkills(cwd))
      } else {
        const addDirs = await this.claudeAddDirs(cwd)
        items = claudeCommandItems(await this.deps.claudeCommands(cwd, addDirs))
      }
    } catch (error) {
      log.warn('command list unavailable', { provider, cwd, error: (error as Error).message })
    } finally {
      const changed = JSON.stringify(items) !== JSON.stringify(existing?.items ?? [])
      this.entries.set(key, { items, at: this.now(), loading: false })
      if (changed) this.deps.onUpdated?.()
    }
    return items
  }
}
