import { resolveHelpGuide, searchHelpGuide, type ActivationMode, type DictationKey, type HelpGuideEntry } from '../../help-guide'
import type { CapabilityCallContext, CapabilityModule, ToolDefinition, ToolResult } from '../types.ts'

const tools = [{
  name: 'unmute_help',
  description: 'Explain how to use Unmute from the current product guide. Use this for any question about Dictation, voice keys, direct sessions, the Unmute Agent, the pocket, screenshots, Scratchpad, Notetaker, or notch controls. With no query it returns the guide index. Shortcut answers use the person’s current Settings.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: [],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 300, description: 'The person’s how-to question in plain words.' },
    },
  },
  consequence: 'read',
}] as const satisfies readonly ToolDefinition[]

export type HelpSettings = { dictationKey: DictationKey; activationMode: ActivationMode }

function present(entry: HelpGuideEntry): Omit<HelpGuideEntry, 'keywords' | 'source'> {
  const { keywords: _keywords, source: _source, ...visible } = entry
  return visible
}

function result(value: unknown, isError = false): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }
}

export class HelpCapability implements CapabilityModule {
  readonly id = 'help'
  readonly roles = ['unmute-agent'] as const
  readonly tools = tools

  /** Sync in the app; a promise in the Agent daemon, where the settings are
   *  one host call away in Electron main. */
  constructor(private readonly currentSettings: () => HelpSettings | Promise<HelpSettings>) {}

  async call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult> {
    if (ctx.principal.kind !== 'unmute-agent' || ctx.principal.expiresAt <= ctx.now) {
      return result({ ok: false, error: { code: 'access-denied', message: 'Product help is unavailable' } }, true)
    }
    if (tool !== 'unmute_help') {
      return result({ ok: false, error: { code: 'invalid-input', message: 'Unknown help tool' } }, true)
    }
    const guide = resolveHelpGuide(await this.currentSettings())
    const query = typeof (input as { query?: unknown } | null)?.query === 'string'
      ? String((input as { query: string }).query).trim()
      : ''
    if (!query) {
      return result({ ok: true, result: {
        title: guide.title,
        intro: guide.intro,
        settings: guide.settings,
        sections: guide.sections.map((section) => ({ id: section.id, title: section.title, intro: section.intro })),
      } })
    }
    if (query.length > 300) {
      return result({ ok: false, error: { code: 'invalid-input', message: 'Help question is too long' } }, true)
    }

    // Common spoken verb; keeping this normalization here avoids weakening the
    // catalog search with product-specific stemming rules.
    const searchQuery = /\bdictat(e|ing)\b/i.test(query) ? 'dictation' : query
    const matches = searchHelpGuide(guide, searchQuery).slice(0, 4)
    return result({ ok: true, result: {
      query,
      matches: matches.map(present),
      ...(matches.length === 0 ? { message: 'I could not match that to the guide. Open How to use Unmute in the app for the full overview.' } : {}),
    } })
  }
}
