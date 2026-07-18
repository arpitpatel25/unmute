// Manual smoke against the REAL vendored driver: handshake, tool count,
// permission report. Run from repo root:  node desktop/scripts/cua-smoke.mjs
//
// NOTE on dev attribution: run from a terminal, the TCC identity is the
// TERMINAL's — grants may read false. That's expected. This proves protocol +
// binary health only; attribution proof is the signed-build gate (Task 7).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'cua-driver', 'cua-driver')
const child = spawn(bin, ['mcp'], {
  env: { ...process.env, CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_HOST_BUNDLE_ID: 'unmute-smoke', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_TELEMETRY_ENABLED: 'false' },
})
child.stderr.on('data', (d) => process.stderr.write(`[driver] ${d}`))
const rl = createInterface({ input: child.stdout })
let id = 0
const pending = new Map()
function call(method, params) {
  return new Promise((res) => { const i = ++id; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
}
rl.on('line', (l) => { try { const m = JSON.parse(l); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch { /* not a response */ } })

const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
console.log('serverInfo:', JSON.stringify(init.result.serverInfo))
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const tools = await call('tools/list', {})
console.log(`tools: ${tools.result.tools.length} —`, tools.result.tools.map((t) => t.name).slice(0, 8).join(', '), '…')
const perms = await call('tools/call', { name: 'check_permissions', arguments: {} })
console.log('permissions:', JSON.stringify(perms.result.structuredContent ?? perms.result))
child.kill()
