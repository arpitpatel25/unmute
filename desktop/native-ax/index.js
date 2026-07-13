// Loader. Resolves the prebuilt .node file produced by node-gyp.
//
// Path: build/Release/native_ax.node — set by binding.gyp's target_name.
// If the .node is missing we re-throw with a clear message so the ax server
// can log + disable the feature without crashing the main process.

try {
  module.exports = require('./build/Release/native_ax.node')
} catch (e) {
  const err = new Error(
    `[unmute-native-ax] failed to load build/Release/native_ax.node — ` +
    `${e instanceof Error ? e.message : String(e)}`
  )
  err.cause = e
  throw err
}
