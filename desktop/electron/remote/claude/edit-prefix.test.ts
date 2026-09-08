import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeEditPrefix } from './edit-prefix'
const user = (text: string) => ({ type: 'user', message: { content: text } })
test('editing removes the latest prompt and all following work, ignoring notifications', () => {
 const answer = { type: 'assistant', uuid: 'checkpoint', message: { content: [{ type: 'text', text: 'First answer' }] } }
 const frames = [user('first'), answer, user('latest'), user('<task-notification>done</task-notification>'), answer]
 assert.deepEqual(claudeEditPrefix(frames, 'latest'), { frames: frames.slice(0, 2), resumeAt: 'checkpoint' })
 assert.throws(() => claudeEditPrefix(frames, 'first'), /latest message changed/)
})
test('the first prompt can be replaced in a fresh branch', () => {
 assert.deepEqual(claudeEditPrefix([user('first')], 'first'), { frames: [], resumeAt: undefined })
})
