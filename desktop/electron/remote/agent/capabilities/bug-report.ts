import { isExplicitBugReportRequest } from '../bug-report'
import type { CapabilityCallContext, CapabilityModule, ToolDefinition, ToolResult } from '../types.ts'

const tools = [{
  name: 'unmute_report_bug',
  description: 'Send a bug report to the Unmute team only when the person explicitly asks you to report a bug to Unmute in this turn. Their exact dictated request and screenshots from this turn are included by the app; supply a short summary. Never call this for a question about reporting or mere bug discussion.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['summary'],
    properties: { summary: { type: 'string', minLength: 1, maxLength: 2000 } },
  },
  consequence: 'external-consequence',
  intent: 'report-bug',
}] as const satisfies readonly ToolDefinition[]

export interface BugReportSubmission {
  transcript: string
  summary: string
  attachmentHandles: readonly string[]
  principal: Extract<CapabilityCallContext['principal'], { kind: 'unmute-agent' }>
}

export class BugReportCapability implements CapabilityModule {
  readonly id = 'bug-report'
  readonly roles = ['unmute-agent'] as const
  readonly tools = tools
  private readonly receipts = new Map<string, Promise<{ id: string; screenshotCount: number }>>()

  constructor(private readonly submit: (report: BugReportSubmission) => Promise<{ id: string; screenshotCount: number }>) {}

  async call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult> {
    if (tool !== 'unmute_report_bug' || ctx.principal.kind !== 'unmute-agent'
      || ctx.principal.expiresAt <= ctx.now || ctx.interaction?.active !== true
      || ctx.interaction.id !== ctx.principal.interactionId
      || !ctx.interaction.transcript || !isExplicitBugReportRequest(ctx.interaction.transcript)) {
      return failure('A direct request to report a bug to Unmute is required in this turn.')
    }
    const data = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
    const summary = typeof data?.summary === 'string' ? data.summary.trim() : ''
    if (!data || Object.keys(data).some(key => key !== 'summary') || !summary || summary.length > 2000) {
      return failure('A short bug summary is required.')
    }
    try {
      const key = `${ctx.principal.runId}:${ctx.principal.interactionId}`
      let pending = this.receipts.get(key)
      if (!pending) {
        pending = this.submit({
          transcript: ctx.interaction.transcript,
          summary,
          attachmentHandles: ctx.interaction.attachmentHandles ?? [],
          principal: ctx.principal,
        })
        this.receipts.set(key, pending)
        if (this.receipts.size > 200) this.receipts.delete(this.receipts.keys().next().value!)
      }
      const submitted = await pending
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, reportId: submitted.id, screenshotCount: submitted.screenshotCount }) }] }
    } catch (error) {
      this.receipts.delete(`${ctx.principal.runId}:${ctx.principal.interactionId}`)
      return failure(error instanceof Error ? error.message : 'Bug report could not be submitted.')
    }
  }
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }] }
}
