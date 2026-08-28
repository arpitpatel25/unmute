// THE DECISION SHAPE, AS A SCHEMA — one definition, both headless lanes.
//
// Until now the shape lived only in English, inside buildRoutingPrompt ("Write
// exactly: {...}"), and was checked after the fact by validateDecision. That is
// how the router came back with "title" instead of "name" and with "task"
// instead of "intent": nothing could reject a wrong shape at the point it was
// produced, so the cost landed on the user as a correction round-trip.
//
// Both new transports enforce it at the boundary instead, from this one source:
//
//   claude   → the inputSchema of an MCP tool the model must call
//   codex    → `codex exec --output-schema`, the model's response_format
//
// CODEX RUNS OPENAI STRICT MODE, which is the constraint that shapes everything
// below and was found by trying it (28 Aug):
//
//   "'required' is required to be supplied and to be an array including every
//    key in properties. Missing 'name'."
//
// So there is no such thing as an omitted key here. Every property is listed in
// `required`, and anything genuinely optional is typed `["string","null"]` and
// answered with null. `parseDecision` already treats null/absent identically,
// so this costs nothing downstream — but it does mean the model must say
// "no group" explicitly rather than staying silent, which is arguably better.

/** Field names are the EXISTING contract — parseDecision is not changing. */
export interface DecisionSchemaOpts {
  /** Offer the curate ops array. Off for a router that cannot curate. */
  ops?: boolean
  /** Offer `skill`, only when skills were listed in the prompt. */
  skills?: boolean
  /** Offer `agent`/`codexProject`, only when more than one backend exists. */
  agents?: readonly string[]
  codexProjects?: readonly string[]
}

type JsonSchema = Record<string, unknown>

/** A string that may be answered with null — the only way to say "omitted"
 *  under strict mode. */
const optStr = (desc: string): JsonSchema => ({ type: ['string', 'null'], description: desc })
const optEnum = (values: readonly string[], desc: string): JsonSchema =>
  ({ type: ['string', 'null'], enum: [...values, null], description: desc })

export function decisionSchema(o: DecisionSchemaOpts = {}): JsonSchema {
  const props: Record<string, JsonSchema> = {
    action: {
      type: 'string',
      enum: ['new', 'continue', 'resume', 'speak', ...(o.ops ? ['curate'] : []), ...(o.skills ? ['skill_feedback'] : [])],
      description: 'What this command does. See the rules above.',
    },
    intent: { type: 'string', description: 'The cleaned one-line command.' },
    targetTaskId: optStr('The task id, for continue/resume/speak. null otherwise.'),
    name: optStr('2-4 word subject-led title, for action "new". null otherwise.'),
    group: optStr('The workspace stream this belongs to. null when genuinely subject-less.'),
    kind: optEnum(['oneoff', 'session'], 'How long the task lives, for action "new".'),
    mode: optEnum(['managed', 'raw'], 'Dispatch mode.'),
    surface: optStr('The canonical app/tool label, or null.'),
    dir: optStr('A known project path, or null.'),
    alternate: optStr('A task id you seriously weighed before choosing new, or null.'),
    contextTaskId: optStr("Another task whose record this new task should read, or null."),
  }

  if (o.agents && o.agents.length > 1) {
    props.agent = optEnum(o.agents, 'Which backend runs it. null = the host default.')
    props.codexProject = o.codexProjects?.length
      ? optEnum(o.codexProjects, 'The Codex project, with agent "codex-desktop". null otherwise.')
      : optStr('null.')
  }
  if (o.skills) props.skill = optStr('A listed skill name, or null.')

  if (o.ops) {
    // ONE object shape rather than a union of set_group/rename_group. Strict
    // mode cannot express "these keys when op=X, those when op=Y", and
    // parseDecision already hard-validates ops against live ids and groups —
    // so the schema's job here is only to carry them, not to police them.
    props.ops = {
      type: ['array', 'null'],
      description: 'Curation ops, for action "curate" only. null otherwise.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'taskIds', 'group', 'from', 'to'],
        properties: {
          op: { type: 'string', enum: ['set_group', 'rename_group'] },
          taskIds: { type: ['array', 'null'], items: { type: 'string' } },
          group: optStr('The group to assign, for set_group.'),
          from: optStr('The existing group name, for rename_group.'),
          to: optStr('The new group name, for rename_group.'),
        },
      },
    }
  }

  return {
    type: 'object',
    additionalProperties: false,
    // EVERY key. Not a style choice — strict mode rejects the schema otherwise.
    required: Object.keys(props),
    properties: props,
  }
}

/** The MCP tool the Claude lane must call. Same schema, tool-shaped. */
export const ROUTE_TOOL_NAME = 'route_decision'

export function routeDecisionTool(o: DecisionSchemaOpts = {}): { name: string; description: string; inputSchema: JsonSchema } {
  return {
    name: ROUTE_TOOL_NAME,
    description: 'Record the routing decision for the spoken command. Call this exactly once, then stop.',
    inputSchema: decisionSchema(o),
  }
}

/** Drop the nulls before handing the object to parseDecision.
 *
 *  Strict mode forces the model to answer every key, so a decision arrives
 *  carrying `"group": null, "dir": null, …`. parseDecision reads absent and
 *  null the same way, but the RAW string is logged and compared in places, and
 *  a wall of nulls makes those logs unreadable. */
export function compactDecision(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === null || v === undefined) continue
    if (Array.isArray(v) && !v.length) continue
    out[k] = v
  }
  return JSON.stringify(out)
}
