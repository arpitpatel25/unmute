// Manual smoke test: run `node smoke.js <bundleId>` (e.g. `node smoke.js us.zoom.xos`)
// with that app open and producing audio. Prints chunk count + sample stats
// for 5 seconds, then stops. First run will trigger the macOS "System Audio
// Recording Only" permission prompt — approve it and re-run.
//
// NOTE: capture is a GLOBAL tap (the whole system's audio output, excluding
// only this process) — see audiotap.mm's header comment. The bundleId
// argument just confirms the app you care about is actually running; it no
// longer determines what gets captured, so this smoke test will pick up
// audio from ANY app currently playing something, not just the one named.
const native = require('./index.js')

const bundleId = process.argv[2]
if (!bundleId) {
  console.error('usage: node smoke.js <bundleId>')
  process.exit(1)
}

const pid = native.pidForBundleId(bundleId)
if (pid == null) {
  console.error(`no running app with bundle id ${bundleId}`)
  process.exit(1)
}

console.log(`found pid ${pid} for ${bundleId} — starting a GLOBAL capture (not scoped to this app)...`)
let chunks = 0
let totalSamples = 0
const startResult = native.startCapture(pid, (chunk) => {
  chunks++
  totalSamples += chunk.samples.length
  if (chunks % 20 === 0) {
    console.log(`chunk #${chunks}, sampleRate=${chunk.sampleRate}, timestampMs=${chunk.timestampMs}`)
  }
})
console.log(`tap mode: ${startResult?.mode ?? '?'}, excluded own process: ${startResult?.excludedOwnProcess ?? '?'} (ownLookupStatus=${startResult?.ownLookupStatus ?? '?'})`)

setTimeout(() => {
  native.stopCapture()
  console.log(`done. ${chunks} chunks, ${totalSamples} total samples.`)
  process.exit(0)
}, 5000)
