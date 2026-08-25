// Let engine-tree modules that import their POST-WIRE paths load in THIS repo.
//
// THE PROBLEM, WHICH IS OLDER THAN THIS FILE. Files under
// engine-overrides/electron/ are copied by build/wire-into-engine.sh onto the
// OSS engine's electron/, and desktop/electron/remote/ is copied onto that
// engine's electron/paywall/remote/. So keyboard.ts's
// './paywall/remote/capture/agentGesture' is correct in the shipped tree and
// resolves to nothing here, where engine-overrides/electron/ and
// electron/remote/ are SIBLING trees.
//
// The cost has been silent and real: keyboard.ts could not be imported in this
// repo, so the three capture lanes — the app's entire input layer — never had a
// test. keyboard.notetaker.test.ts was written anyway and excluded from
// `npm test` with a comment explaining that it "CANNOT load standalone", which
// left behind a test file that fails the moment anyone runs it, and a
// `test:notetaker-keyboard` script that has never passed.
//
// TEST RUNS ONLY. This changes nothing about the build and nothing about how
// the shipped app resolves anything: in the wired tree these paths are real and
// resolve the ordinary way. It exists so the lane locks can be tested at all.
//
// It patches CJS resolution rather than registering an ESM loader hook, because
// tsx transpiles these .ts files to CommonJS — the ESM `resolve` hook is never
// consulted for them (verified: the failure arrives with a "Require stack").
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const Module = require('node:module')

const here = dirname(fileURLToPath(import.meta.url))
/** engine-overrides/electron/ → desktop/ */
const desktopRoot = resolvePath(here, '..', '..')

/** Post-wire prefix → its real home in this repo. Longest prefix first, so
 *  './paywall/remote/' is never shadowed by './paywall/'. */
const ALIASES = [
  ['./paywall/remote/', resolvePath(desktopRoot, 'electron', 'remote')],
  ['../paywall/remote/', resolvePath(desktopRoot, 'electron', 'remote')],
  ['./paywall/', resolvePath(desktopRoot, 'electron')],
  ['../paywall/', resolvePath(desktopRoot, 'electron')],
]

const originalResolve = Module._resolveFilename
Module._resolveFilename = function patched(request, ...rest) {
  if (typeof request === 'string') {
    for (const [prefix, realRoot] of ALIASES) {
      if (!request.startsWith(prefix)) continue
      const target = resolvePath(realRoot, request.slice(prefix.length))
      // Try the mapped path, then its .ts sibling (these imports are
      // extensionless). Fall through to the original on any miss, so a genuine
      // typo still fails with the message it always did.
      for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) {
        try { return originalResolve.call(this, candidate, ...rest) } catch { /* next */ }
      }
      break
    }
  }
  return originalResolve.call(this, request, ...rest)
}
