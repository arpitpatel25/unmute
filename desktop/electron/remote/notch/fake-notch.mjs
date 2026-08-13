#!/usr/bin/env node
// Minimal stand-in for the native `unmute-notch` helper: line-delimited JSON on
// stdio. It records the commands it received and can be prodded to emit events,
// so notch-client.test.ts can PROVE the client's send/receive both work without
// a GUI or the Swift toolchain.
//
// Protocol extension for tests only:
//   * on startup emits {"type":"ready"}
//   * a received {"type":"__emit","event":{...}} makes the fake emit that event
//     back (proves the client surfaces helper→main events)
//   * a received {"type":"__dump"} emits {"type":"__calls","commands":[...]} with
//     every non-test command seen so far (proves main→helper sends landed)
import { createInterface } from 'node:readline'

const received = []
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

emit({ type: 'ready' })

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  if (msg.type === '__emit') { emit(msg.event); return }
  if (msg.type === '__dump') { emit({ type: '__calls', commands: received }); return }
  if (msg.type === '__crash') { process.exit(23) }
  if (msg.type === 'quit') { process.exit(0) }
  received.push(msg)
})
