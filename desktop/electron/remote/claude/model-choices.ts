import type { ClaudeTaskModel } from './task-session'

/** The recommended choices from Claude's initialize response, not its full
 * historical/pinned catalog. Keep a previously selected version visible so
 * reopening an older conversation never silently changes its model. */
export function claudeModelChoices(models: readonly ClaudeTaskModel[], selectedId?: string): ClaudeTaskModel[] {
  const chosen: ClaudeTaskModel[] = []
  const seen = new Set<string>()
  const add = (model: ClaudeTaskModel | undefined) => {
    if (model && !seen.has(model.id)) { chosen.push(model); seen.add(model.id) }
  }
  add(models.find(model => model.id === 'default'))
  add(models.find(model => /^opus\[1m\]$/i.test(model.id)) ?? models.find(model => model.id === 'opus'))
  add(models.find(model => /(?:^|-)fable(?:-|\[|$)/i.test(model.id)))
  add(models.find(model => model.id === 'sonnet'))
  add(models.find(model => model.id === 'haiku'))
  for (const model of models) {
    if (!model.id.startsWith('claude-') && !/^(?:default|opus(?:\[.*\])?|sonnet|haiku)$/i.test(model.id)) add(model)
  }
  add(models.find(model => model.id === selectedId))
  return chosen
}
