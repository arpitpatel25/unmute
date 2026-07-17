#!/usr/bin/env node
// Minimal stand-in for `cua-driver mcp`: line-delimited JSON-RPC 2.0 on stdio,
// mirroring the real driver's shapes (initialize / tools/list / tools/call).
// Special tools let tests PROVE client behavior:
//   __env  → echoes the embedded/telemetry env vars the client must set
//   __pid  → echoes this process's pid (session-routing proof)
//   __slow → never replies (timeout path)
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // notification — real driver drops these too
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cua-driver', version: '0.0.0-fake' },
        instructions: 'fake driver instructions',
      })
      break
    case 'tools/list':
      reply({ tools: [{ name: 'list_apps', description: 'fake list_apps', inputSchema: { type: 'object', properties: {} } }] })
      break
    case 'tools/call': {
      const name = msg.params?.name
      if (name === '__env') {
        reply({ content: [{ type: 'text', text: JSON.stringify({
          embedded: process.env.CUA_DRIVER_EMBEDDED,
          telemetry: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,
          telemetryCompat: process.env.CUA_TELEMETRY_ENABLED,
        }) }], isError: false })
      } else if (name === '__pid') {
        reply({ content: [{ type: 'text', text: String(process.pid) }], isError: false })
      } else if (name === '__slow') {
        // never replies — exercises the client timeout
      } else {
        reply({ content: [{ type: 'text', text: `called ${name}` }], structuredContent: { ok: true }, isError: false })
      }
      break
    }
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no such method: ${msg.method}` } }) + '\n')
  }
})
