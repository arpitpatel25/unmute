// Test harness setup — loaded via `node --import ./electron/remote/test-setup.ts`.
//
// Silences the logger's console mirror so unit-test output stays pristine. The
// file sink is off during tests (configureRemoteLogging is never called), so
// log lines simply go nowhere — which is exactly what we want under `--test`.
// Production/dev keep the console mirror on (this module is test-only).
//
// This also keeps the deliberately HEAVY memory-system instrumentation (tagged
// `TEMP(memory-debug)`) from polluting test stdout while it exists.
import { setConsoleMirror } from './log.ts'

setConsoleMirror(false)
