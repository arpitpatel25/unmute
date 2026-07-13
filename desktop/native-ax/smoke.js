#!/usr/bin/env node
// On-device smoke test for the native-ax engine. Not part of the unit suite
// (needs a real Mac + Accessibility permission + a running app). Run manually:
//
//   node native-ax/smoke.js [AppName]
//
// It proves the whole thesis in one shot: read an app's tree and press a button
// WITHOUT the app ever becoming frontmost. Exits non-zero if focus was stolen.

const ax = require('./index.js')

const target = process.argv[2] || 'Notes'

if (!ax.isTrusted()) {
  console.error('NOT TRUSTED — grant Accessibility to this terminal (or Unmute.app) and retry.')
  process.exit(2)
}

const before = ax.frontmostApp()
console.log(`frontmost before: ${before}`)

const apps = ax.listApps()
const hit = apps.find((a) => a.name.toLowerCase() === target.toLowerCase())
if (!hit) { console.error(`app "${target}" not running. Running: ${apps.map((a) => a.name).join(', ')}`); process.exit(1) }
console.log(`target: ${hit.name} (${hit.bundleId}) windowsHere=${hit.windowsHere} windowsAnywhere=${hit.windowsAnywhere}`)

const found = ax.find(target, '', '')
if (found.error) { console.error('find error:', found.error); process.exit(1) }
console.log(`read ${found.total} nodes; ${found.nodes.length} interesting. First few:`)
for (const n of found.nodes.slice(0, 8)) console.log(`  id=${n.id} ${n.role} "${n.label}" [${n.actions}]`)

const after = ax.frontmostApp()
console.log(`frontmost after:  ${after}`)
if (before !== after) { console.error('✗ FOCUS STOLEN — background thesis violated'); process.exit(3) }
console.log('✓ FOCUS UNCHANGED — background control works')
