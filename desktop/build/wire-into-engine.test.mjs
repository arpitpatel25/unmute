import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the wired engine declares the websocket dependency used by the CDP lane', () => {
  const script = readFileSync(new URL('./wire-into-engine.sh', import.meta.url), 'utf8')
  assert.match(script, /pkg\.dependencies\['ws'\]\s*=\s*['"]\^8\.21\.1['"]/) 
})
