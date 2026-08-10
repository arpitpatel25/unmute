/**
 * WHAT A TASK IS DOING RIGHT NOW — one vocabulary, every backend.
 *
 * The four task STATES answer "does this need me" (processing / needs-user /
 * done / failed). They deliberately say nothing about what the agent is
 * currently up to, and for months the surface filled that gap with the word
 * "Working" — true of every busy task and useful about none of them.
 *
 * This is the missing layer. "Running npm test" and "Reading auth.ts" and
 * "Searching the web" are the difference between a progress bar and knowing
 * whether to look. Every backend already emits this; nothing was reading it.
 *
 * WHY A SHARED VOCABULARY RATHER THAN EACH BACKEND'S OWN WORDS. Codex reports
 * `commandExecution`, Claude reports a PreToolUse hook naming `Bash`. Passing
 * either through raw would put a vendor's internal noun on the card, and the
 * card would then have to know which vendor it was looking at — the exact
 * inference that has broken this surface repeatedly (a backend id deciding a
 * layout, a backend id deciding a model list). The card renders an Activity;
 * the backends translate into one.
 *
 * DELIBERATELY SMALL. Eight kinds, chosen so every one of them changes what a
 * person would do: `running` a command and `editing` files are worth glancing
 * at, `thinking` is worth waiting through, `browsing` is worth watching. A
 * taxonomy that mirrored all eighteen of Codex's item types would be a data
 * dump, and the ninth kind nobody can act on differently is decoration.
 *
 * NEVER A STATE. An activity is what is happening inside `processing`; it does
 * not decide whether a task wants you. Conflating the two is how "Working"
 * ended up outranking a finished task's actual result on the card.
 */

/** The eight things an agent can be visibly doing. */
export type ActivityKind =
  /** Reasoning, planning — no external effect yet. */
  | 'thinking'
  /** A shell command. `label` is the command. */
  | 'running'
  /** Reading or writing files. `label` is the file or a count. */
  | 'editing'
  /** Web search. `label` is the query. */
  | 'searching'
  /** Driving a browser. */
  | 'browsing'
  /** Any other tool, typically MCP. `label` is the tool, `detail` its server. */
  | 'tool'
  /** Handing work to a sub-agent. */
  | 'delegating'
  /** Housekeeping the model does to itself (context compaction). */
  | 'compacting'

export interface Activity {
  kind: ActivityKind
  /** The specific thing: the command, the file, the query, the tool name.
   *  Short enough for one line on a card — the producer truncates, not the view. */
  label?: string
  /** Secondary attribution: which MCP server, which sub-agent. */
  detail?: string
}

/** Longest sensible label for a card line. Beyond this a command's tail is
 *  noise, and the card has to stay one line however long the command was. */
const LABEL_MAX = 60

export function clampLabel(s: string | undefined | null): string | undefined {
  if (!s) return undefined
  const one = s.replace(/\s+/g, ' ').trim()
  if (!one) return undefined
  return one.length <= LABEL_MAX ? one : one.slice(0, LABEL_MAX - 1).trimEnd() + '…'
}

/**
 * The sentence a card shows. Present tense, lowercase noun phrase, because it
 * follows a status dot rather than starting a sentence.
 *
 * FALLS BACK TO THE KIND ALONE when there is no label — "running a command" is
 * still better than "Working", and inventing a label we do not have is how a
 * surface starts lying about specifics.
 */
export function describeActivity(a: Activity | undefined | null): string | undefined {
  if (!a) return undefined
  const l = a.label
  switch (a.kind) {
    case 'thinking':   return 'thinking'
    case 'running':    return l ? `running ${l}` : 'running a command'
    case 'editing':    return l ? `editing ${l}` : 'editing files'
    case 'searching':  return l ? `searching for ${l}` : 'searching the web'
    case 'browsing':   return l ? `browsing ${l}` : 'using the browser'
    case 'delegating': return l ? `delegating to ${l}` : 'delegating'
    case 'compacting': return 'tidying its context'
    case 'tool':       return l ? `using ${l}` : 'using a tool'
  }
}

/**
 * Codex App Server `ThreadItem.type` → an Activity.
 *
 * The mapping is lossy ON PURPOSE — eighteen item types collapse into eight
 * kinds. What is dropped is the distinction between things a person would react
 * to identically: `mcpToolCall` and `dynamicToolCall` are both "using a tool",
 * and `collabAgentToolCall` and `subAgentActivity` are both "delegating".
 *
 * Returns null for items that are not activity at all: a user message is not
 * the agent doing something, and an agent message is the RESULT rather than the
 * work. Treating those as activity is how a finished task kept saying it was
 * busy.
 */
export function activityFromCodexItem(type: string, fields: Record<string, unknown> = {}): Activity | null {
  const str = (k: string): string | undefined =>
    typeof fields[k] === 'string' ? clampLabel(fields[k] as string) : undefined
  switch (type) {
    case 'reasoning':
    case 'plan':
      return { kind: 'thinking' }
    case 'commandExecution':
      return { kind: 'running', label: str('command') ?? str('cmd') }
    case 'fileChange':
      return { kind: 'editing', label: str('path') ?? str('file') }
    case 'webSearch':
      return { kind: 'searching', label: str('query') }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const server = str('server') ?? str('serverName')
      const tool = str('tool') ?? str('toolName') ?? str('name')
      // The browser MCP is worth its own kind: "browsing" is a different thing
      // to watch than "using a tool", and it is the one people ask about.
      if (isBrowserish(server) || isBrowserish(tool)) return { kind: 'browsing', label: tool, detail: server }
      return { kind: 'tool', label: tool, detail: server }
    }
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return { kind: 'delegating', label: str('name') ?? str('agent') }
    case 'contextCompaction':
      return { kind: 'compacting' }
    case 'imageView':
    case 'imageGeneration':
      return { kind: 'tool', label: type === 'imageView' ? 'image' : 'image generation' }
    // NOT ACTIVITY: userMessage (yours), agentMessage (the result), hookPrompt,
    // sleep, enteredReviewMode, exitedReviewMode.
    default:
      return null
  }
}

/**
 * Claude tool name → an Activity.
 *
 * Claude names tools rather than describing behaviour, so the mapping is by
 * name — and unknown names fall through to `tool` with the name attached,
 * which stays right for a tool that ships tomorrow instead of vanishing.
 */
export function activityFromClaudeTool(tool: string, input: Record<string, unknown> = {}): Activity | null {
  const str = (k: string): string | undefined =>
    typeof input[k] === 'string' ? clampLabel(input[k] as string) : undefined
  const t = tool.trim()
  if (t === 'Bash' || t === 'BashOutput') return { kind: 'running', label: str('command') }
  if (t === 'Edit' || t === 'Write' || t === 'NotebookEdit') return { kind: 'editing', label: baseName(str('file_path')) }
  if (t === 'Read') return { kind: 'editing', label: baseName(str('file_path')) }
  if (t === 'WebSearch') return { kind: 'searching', label: str('query') }
  if (t === 'WebFetch') return { kind: 'browsing', label: str('url') }
  if (t === 'Glob' || t === 'Grep') return { kind: 'searching', label: str('pattern') }
  if (t === 'Task' || t === 'Agent') return { kind: 'delegating', label: str('description') }
  if (t.startsWith('mcp__')) {
    // mcp__<server>__<tool>
    const parts = t.split('__')
    const server = parts[1]
    const name = parts.slice(2).join('__') || undefined
    if (isBrowserish(server) || isBrowserish(name)) return { kind: 'browsing', label: name, detail: server }
    return { kind: 'tool', label: name, detail: server }
  }
  if (!t) return null
  return { kind: 'tool', label: clampLabel(t) }
}

function baseName(p: string | undefined): string | undefined {
  if (!p) return undefined
  return p.split('/').filter(Boolean).pop() ?? p
}

/** Is this server or tool a browser? Matched by substring rather than an
 *  allowlist of product names, because the list of browser integrations grows
 *  and an unlisted one reading as a generic "tool" is a small, silent loss. */
function isBrowserish(s: string | undefined): boolean {
  if (!s) return false
  return /chrome|browser|playwright|puppeteer|devtools|web-?nav/i.test(s)
}
