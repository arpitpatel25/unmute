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
    description: 'Copy text to the clipboard for the current user interaction',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string', minLength: 1 } },
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
  stageAttachmentCopy(metadata: DeliveryAttachmentMetadata): Promise<AttachmentDeliveryTransaction>
  stageTaskDraftAttachment(
    taskId: string,
    metadata: DeliveryAttachmentMetadata,
  ): Promise<AttachmentDeliveryTransaction>
}

export type DeliveryAttachmentMetadata = Pick<DeliveryAttachment, 'name' | 'mimeType' | 'size'>

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
        const candidate = requireObject(input, ['text'])
        await this.adapters.copyText(requireString(candidate.text, 'text'))
        return result('Text copied')
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
