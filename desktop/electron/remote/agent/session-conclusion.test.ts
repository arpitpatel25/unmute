import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSessionConclusion } from './session-conclusion'

test('reads only the last completed Claude answer, bounded in size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-conclusion-'))
  try {
    const path = join(dir, 'claude.jsonl')
    await writeFile(path, [
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Old result' }] } },
      { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will inspect more' }] } },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Final status ' + 'x'.repeat(3000) }] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n')
    const result = await readSessionConclusion(path)
    assert.match(result ?? '', /Final status/)
    assert.doesNotMatch(result ?? '', /Old result|inspect more/)
    assert.ok((result?.length ?? 0) <= 900)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('reads the completed Codex turn answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-conclusion-'))
  try {
    const path = join(dir, 'codex.jsonl')
    await writeFile(path, [
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Previous status' } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Merged into main' } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n')
    assert.equal(await readSessionConclusion(path), 'Merged into main')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
