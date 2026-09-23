import type { ChatConfigChangeP } from './notch-client'

interface Choice { id: string; label: string }

export interface ExistingTaskModelConfig {
  mutable: boolean
  busy: boolean
  models: Choice[]
  efforts: Choice[]
}

export type ExistingTaskModelPick = {
  axis: 'Model' | 'Effort' | 'Speed'
  value: string
}

export type ExistingTaskModelResolution =
  | { change: ChatConfigChangeP; error?: never }
  | { change?: never; error: string }

/** Prefer the provider catalogue's display name once it is available. Task
 * receipts may contain the provider id, which is correct for reconnecting but
 * is not the label either picker should flash after a successful change. */
export function existingTaskModelLabel(
  models: Choice[],
  currentId: string | undefined,
  fallback: string | undefined,
): string {
  const exact = models.find(choice => choice.id === currentId)
  const baseId = currentId?.replace(/\[[^\]]+\]$/, '')
  const qualifiedAlias = exact ?? (baseId ? models.find(choice => choice.id.replace(/\[[^\]]+\]$/, '') === baseId) : undefined)
  return qualifiedAlias?.label ?? fallback ?? currentId ?? 'Provider default'
}

/** Translate the pill's display labels back into the conversation's provider
 * ids. The composer already sends ids; this keeps both surfaces on the same
 * configureChat path without letting a global/default choice leak into an
 * existing thread. */
export function resolveExistingTaskModelChange(
  config: ExistingTaskModelConfig,
  pick: ExistingTaskModelPick,
): ExistingTaskModelResolution {
  if (!config.mutable) return { error: 'Settings for this conversation are managed in the original application.' }
  if (config.busy) return { error: 'Change the model after the current turn finishes.' }
  if (pick.axis === 'Speed') return { error: 'Speed is not configurable for this conversation.' }

  const choices = pick.axis === 'Model' ? config.models : config.efforts
  const selected = choices.find(choice => choice.id === pick.value || choice.label === pick.value)
  if (!selected) return { error: `That ${pick.axis.toLowerCase()} is not offered for this conversation.` }
  return { change: pick.axis === 'Model' ? { model: selected.id } : { effort: selected.id } }
}

/** Apply a pill selection through the caller's authoritative conversation
 * configuration operation. Keeping the callback explicit makes it impossible
 * for this path to degrade into a receipt-only label update unnoticed. */
export async function applyExistingTaskModelPick(
  config: ExistingTaskModelConfig,
  pick: ExistingTaskModelPick,
  configure: (change: ChatConfigChangeP) => Promise<void>,
): Promise<ExistingTaskModelResolution> {
  const resolution = resolveExistingTaskModelChange(config, pick)
  if (!resolution.change) return resolution
  await configure(resolution.change)
  return resolution
}
