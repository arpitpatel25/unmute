try {
  module.exports = require('./build/Release/native_audio_tap.node')
} catch (e) {
  const err = new Error(
    `[unmute-native-audio-tap] failed to load build/Release/native_audio_tap.node — ` +
    `${e instanceof Error ? e.message : String(e)}`
  )
  err.cause = e
  throw err
}
