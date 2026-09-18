import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeModelUnavailable, codexModelUnavailable } from './modelAvailability'

test('Codex: structured codes a different model can fix', () => {
  assert.equal(codexModelUnavailable({ codexErrorInfo: 'usageLimitExceeded', message: 'x' }), 'usage limit reached')
  assert.equal(codexModelUnavailable({ codexErrorInfo: 'serverOverloaded' }), 'overloaded')
  assert.equal(codexModelUnavailable({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } } }), 'not responding')
})

test('Codex: an unsupported model, as measured (codexErrorInfo "other", 400 in the text)', () => {
  const message = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-nonexistent-9\' model is not supported when using Codex with a ChatGPT account."}}'
  assert.equal(codexModelUnavailable({ codexErrorInfo: 'other', message }), 'not available on this account')
})

test('Codex: failures another model would not fix stay failures', () => {
  for (const code of ['unauthorized', 'contextWindowExceeded', 'sandboxError']) assert.equal(codexModelUnavailable({ codexErrorInfo: code, message: 'nope' }), undefined, code)
  assert.equal(codexModelUnavailable({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } }, message: 'network down' }), undefined)
})

test('Claude: what it could not route around', () => {
  assert.equal(claudeModelUnavailable('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'), 'overloaded')
  assert.equal(claudeModelUnavailable('model: claude-x not_found_error'), 'not available on this account')
  assert.equal(claudeModelUnavailable("You've hit your usage limit"), 'usage limit reached')
  assert.equal(claudeModelUnavailable('Invalid API key · Please run /login'), undefined)
})
