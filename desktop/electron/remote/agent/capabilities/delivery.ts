import type {
  CapabilityCallContext,
  CapabilityModule,
  McpPrincipal,
  ToolDefinition,
  ToolResult,
} from '../types.ts'
import type { DeliveryAttachment } from '../memory/attachments.ts'

export type { DeliveryAttachment } from '../memory/attachments.ts'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const tools = [
  {
    name: 'delivery_copy_text',
    description: 'Put text the user asked for on their clipboard, or prepare it in an explicit'
      + ' existing task draft; this never submits the draft. Say in your reply that you copied it.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: {
        text: {
          type: 'string', minLength: 1,
          description: 'Exactly what the user should end up with. Not a description of it.',
        },
        taskId: {
          type: 'string', pattern: IDENTIFIER_PATTERN.source,
          description: 'Prepare it in this existing task draft instead of the clipboard.',
        },
      },
    },
    consequence: 'reversible-write',
  },
  {
    name: 'delivery_open_attachment_file',
    description: 'Open a stored attachment in whichever application owns it, when the user asked'
      + ' to OPEN something rather than to be given its text. There is no clipboard step —'
      + ' opening a file and copying its contents are different requests.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['handle'],
      properties: {
        handle: {
          type: 'string', minLength: 1,
          description: 'An opaque delivery handle from memory_open_attachment. Never a path you composed.',
        },
      },
    },
    consequence: 'reversible-write',
  },
  {
    name: 'delivery_copy_attachment',
    description: 'Copy an attachment opened for the current user interaction',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['handle'],
      properties: { handle: { type: 'string', minLength: 1 } },
    },
    consequence: 'reversible-write',
  },
  {
    name: 'delivery_attach_to_task_draft',
    description: 'Add an opened attachment to an existing task draft',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['handle', 'taskId'],
      properties: {
        handle: { type: 'string', minLength: 1 },
        taskId: { type: 'string', pattern: IDENTIFIER_PATTERN.source },
      },
    },
    consequence: 'reversible-write',
  },
] as const satisfies readonly ToolDefinition[]

export interface DeliveryCapabilityAdapters {
  resolveAttachment(principal: McpPrincipal, handle: string): Promise<DeliveryAttachment>
  copyText(text: string): Promise<void>
  prepareTaskDraftText?(taskId: string, text: string): Promise<void>
  stageAttachmentCopy(metadata: DeliveryAttachmentMetadata): Promise<AttachmentDeliveryTransaction>
  /** Open a stored attachment in whichever application owns it. */
  openAttachmentFile(metadata: DeliveryAttachmentMetadata): Promise<AttachmentDeliveryTransaction>
  stageTaskDraftAttachment(
    taskId: string,
    metadata: DeliveryAttachmentMetadata,
  ): Promise<AttachmentDeliveryTransaction>
}

export type DeliveryAttachmentMetadata = Pick<DeliveryAttachment, 'name' | 'mimeType' | 'size'>

export type DeliveryCapabilityErrorCode =
  | 'destination-unavailable'
  | 'delivery-failed'

/** Path-free destination failures safe to return through the MCP boundary. */
export class DeliveryCapabilityError extends Error {
  constructor(readonly code: DeliveryCapabilityErrorCode) {
    super(code === 'destination-unavailable'
      ? 'The requested delivery destination is unavailable; nothing was delivered'
      : 'The requested delivery could not be completed; nothing was delivered')
    this.name = 'DeliveryCapabilityError'
  }
}

/**
 * Writes remain private to the adapter's staging area. Commit publishes the
 * complete value atomically; rollback removes staging without external effect.
 */
export interface AttachmentDeliveryTransaction {
  write(chunk: Uint8Array): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

function requireActiveAgentInteraction(ctx: CapabilityCallContext): void {
  if (
    ctx.principal.kind !== 'unmute-agent'
    || ctx.principal.expiresAt <= ctx.now
    || ctx.interaction?.active !== true
    || ctx.interaction.id !== ctx.principal.interactionId
  ) {
    throw new Error('Delivery requires an active explicit interaction')
  }
}

function requireObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Delivery input is invalid')
  }
  const candidate = input as Record<string, unknown>
  if (Object.keys(candidate).some((key) => !keys.includes(key))) {
    throw new Error('Delivery input is invalid')
  }
  return candidate
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Delivery ${field} input is invalid`)
  }
  return value
}

function result(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

async function deliverAttachment(
  attachment: DeliveryAttachment,
  stage: (metadata: DeliveryAttachmentMetadata) => Promise<AttachmentDeliveryTransaction>,
): Promise<void> {
  const transaction = await stage({
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  })
  try {
    for await (const chunk of attachment.open()) await transaction.write(chunk)
    await transaction.commit()
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve the delivery/integrity failure */ }
    throw error
  }
}

export class DeliveryCapability implements CapabilityModule {
  readonly id = 'delivery'
  readonly roles = ['unmute-agent'] as const
  readonly tools = tools

  constructor(private readonly adapters: DeliveryCapabilityAdapters) {}

  async call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult> {
    requireActiveAgentInteraction(ctx)
    switch (tool) {
      case 'delivery_copy_text': {
        const candidate = requireObject(input, ['text', 'taskId'])
        const text = requireString(candidate.text, 'text')
        if (candidate.taskId === undefined) {
          await this.adapters.copyText(text)
          return result('Text copied')
        }
        const taskId = requireString(candidate.taskId, 'task identifier')
        if (!IDENTIFIER_PATTERN.test(taskId)) throw new Error('Delivery task identifier input is invalid')
        if (!this.adapters.prepareTaskDraftText) {
          throw new DeliveryCapabilityError('destination-unavailable')
        }
        await this.adapters.prepareTaskDraftText(taskId, text)
        return result('Text added to task draft')
      }
      case 'delivery_copy_attachment': {
        const candidate = requireObject(input, ['handle'])
        const attachment = await this.adapters.resolveAttachment(
          ctx.principal,
          requireString(candidate.handle, 'handle'),
        )
        await deliverAttachment(attachment, (metadata) => this.adapters.stageAttachmentCopy(metadata))
        return result('Attachment copied')
      }

      // OPENING AND COPYING ARE DIFFERENT REQUESTS. "Give me my resume" wants
      // text on the clipboard; "open my resume" wants the document in front of
      // the user. Routing the second through the clipboard leaves them holding
      // a file path and wondering what to do with it.
      case 'delivery_open_attachment_file': {
        const candidate = requireObject(input, ['handle'])
        const attachment = await this.adapters.resolveAttachment(
          ctx.principal,
          requireString(candidate.handle, 'handle'),
        )
        await deliverAttachment(attachment, (metadata) => this.adapters.openAttachmentFile(metadata))
        return result('Attachment opened')
      }
      case 'delivery_attach_to_task_draft': {
        const candidate = requireObject(input, ['handle', 'taskId'])
        const taskId = requireString(candidate.taskId, 'task identifier')
        if (!IDENTIFIER_PATTERN.test(taskId)) throw new Error('Delivery task identifier input is invalid')
        const attachment = await this.adapters.resolveAttachment(
          ctx.principal,
          requireString(candidate.handle, 'handle'),
        )
        await deliverAttachment(
          attachment,
          (metadata) => this.adapters.stageTaskDraftAttachment(taskId, metadata),
        )
        return result('Attachment added to task draft')
      }
      default:
        throw new Error('Delivery tool is invalid')
    }
  }
}
