// Loader. Resolves the prebuilt .node file produced by node-gyp.
//
// Path: build/Release/native_paste.node — set by binding.gyp's target_name.
// If the .node is missing (build failed, platform unsupported, addon was
// stripped out of the bundle, etc.) we re-throw with a clear message so
// the calling clipboard.ts can log + fall back to osascript without
// crashing the renderer.

try {
  module.exports = require('./build/Release/native_paste.node')
} catch (e) {
  const err = new Error(
    `[unmute-native-paste] failed to load build/Release/native_paste.node — ` +
    `${e instanceof Error ? e.message : String(e)}`
  )
  err.cause = e
  throw err
}
