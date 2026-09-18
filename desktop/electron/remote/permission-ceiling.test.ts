import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeLimit, claudeUnattendedArgs, codexLimit, readManagedPolicy, type PolicySources } from './permission-ceiling'

function sources(files: Record<string, string>, plists: Record<string, unknown> = {}, defaults: Record<string, string> = {}): PolicySources {
  return {
    readText: async p => files[p] ?? null,
    listDir: async d => Object.keys(files).filter(p => p.startsWith(d + '/')).map(p => p.slice(d.length + 1)),
    readPlist: async p => (plists[p] as Record<string, unknown>) ?? null,
    readDefault: async (domain, key) => defaults[`${domain}:${key}`] ?? null,
    user: 'me',
  }
}
const b64 = (s: string) => Buffer.from(s).toString('base64')

test('nothing managed: nothing forbidden', async () => {
  assert.deepEqual(await readManagedPolicy(sources({})), { codexFullAccessForbidden: false, claudeBypassForbidden: false, claudeAutoForbidden: false })
})

test('Claude managed-settings.json and drop-ins are read', async () => {
  const p = await readManagedPolicy(sources({
    '/Library/Application Support/ClaudeCode/managed-settings.json': JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }),
    '/Library/Application Support/ClaudeCode/managed-settings.d/10-auto.json': JSON.stringify({ disableAutoMode: 'disable' }),
  }))
  assert.equal(p.claudeBypassForbidden, true)
  assert.equal(p.claudeAutoForbidden, true)
})

test('Claude MDM profile is read', async () => {
  const p = await readManagedPolicy(sources({}, { '/Library/Managed Preferences/com.anthropic.claudecode.plist': { permissions: { disableBypassPermissionsMode: 'disable' } } }))
  assert.equal(p.claudeBypassForbidden, true)
})

test('Codex requirements from MDM, file, or preference domain', async () => {
  const toml = 'allowed_sandbox_modes = ["read-only", "workspace-write"]'
  assert.equal((await readManagedPolicy(sources({}, { '/Library/Managed Preferences/com.openai.codex.plist': { requirements_toml_base64: b64(toml) } }))).codexFullAccessForbidden, true)
  assert.equal((await readManagedPolicy(sources({ '/etc/codex/requirements.toml': toml }))).codexFullAccessForbidden, true)
  assert.equal((await readManagedPolicy(sources({}, {}, { 'com.openai.codex:requirements_toml_base64': b64(toml) }))).codexFullAccessForbidden, true)
  assert.equal((await readManagedPolicy(sources({ '/etc/codex/requirements.toml': 'allowed_sandbox_modes = ["workspace-write", "danger-full-access"]' }))).codexFullAccessForbidden, false)
})

test('unattended Claude runs ask for the most the policy leaves', () => {
  assert.deepEqual(claudeUnattendedArgs({ codexFullAccessForbidden: false, claudeBypassForbidden: false, claudeAutoForbidden: false }), ['--dangerously-skip-permissions'])
  assert.deepEqual(claudeUnattendedArgs({ codexFullAccessForbidden: false, claudeBypassForbidden: true, claudeAutoForbidden: false }), ['--permission-mode', 'auto'])
  assert.deepEqual(claudeUnattendedArgs({ codexFullAccessForbidden: false, claudeBypassForbidden: true, claudeAutoForbidden: true }), ['--permission-mode', 'acceptEdits'])
})

test('limits read as the level actually running', () => {
  assert.equal(codexLimit({ approvalPolicy: 'never', sandbox: 'danger-full-access' }, { approvalPolicy: 'never', sandbox: 'workspace-write' }).effective, 'Workspace access')
  assert.equal(claudeLimit('bypassPermissions', 'acceptEdits').effective, 'Accept edits')
})
