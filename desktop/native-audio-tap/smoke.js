// Manual smoke test: run `node smoke.js <bundleId>` (e.g. `node smoke.js us.zoom.xos`)
// with that app open and producing audio. Prints chunk count + sample stats
// for 5 seconds, then stops. First run will trigger the macOS "System Audio
// Recording Only" permission prompt — approve it and re-run.
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

console.log(`found pid ${pid} for ${bundleId}, starting capture...`)
let chunks = 0
let totalSamples = 0
native.startCapture(pid, (chunk) => {
  chunks++
  totalSamples += chunk.samples.length
  if (chunks % 20 === 0) {
    console.log(`chunk #${chunks}, sampleRate=${chunk.sampleRate}, timestampMs=${chunk.timestampMs}`)
  }
})

setTimeout(() => {
  native.stopCapture()
  console.log(`done. ${chunks} chunks, ${totalSamples} total samples.`)
  process.exit(0)
}, 5000)
