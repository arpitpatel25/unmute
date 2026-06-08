// Loader. Resolves the prebuilt .node file produced by node-gyp.
//
// Mirrors unmute-native-paste/index.js exactly. If the .node is missing
// (build failed, platform unsupported, addon was stripped out of the bundle,
// etc.) we re-throw with a clear message so the calling keyListener.ts
// can log and fall back to the spawned globe-listener binary.

try {
  module.exports = require('./build/Release/native_fn_listener.node')
} catch (e) {
  const err = new Error(
    `[unmute-native-fn-listener] failed to load build/Release/native_fn_listener.node — ` +
    `${e instanceof Error ? e.message : String(e)}`
  )
  err.cause = e
  throw err
}
