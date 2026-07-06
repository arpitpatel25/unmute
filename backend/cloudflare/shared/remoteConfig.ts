// Unmute Remote — the hosted runtime-config payload (the control plane).
//
// This is the "change here to roll out to all users" file for the DESKTOP
// Remote layer — the sibling of groq.ts for the backend. The desktop app
// fetches it (GET /v1/remote-config, public/unauthenticated) in the background
// and folds any overrides over its compiled defaults, so we can retune models,
// prompts (incl. the whole operating contract), and behavioral knobs across the
// fleet WITHOUT shipping a new app build.
//
// HOW TO PUSH A CHANGE
// --------------------
//   1. Bump `version` (strictly greater than the last — the client only accepts
//      a NEWER version; equal/older is ignored). Monotonic integer.
//   2. Add ONLY the keys you want to override under models / prompts / knobs.
//      Anything you omit falls through to the app's compiled default — so this
//      file stays a small DELTA, never a full copy of the defaults.
//   3. `wrangler deploy` the pipeline worker. Users pick it up on their next
//      launch or 6h refresh (eventual consistency across the fleet — expected).
//
// SAFETY: the client validates every override (models must be a real tier,
// prompts must be non-empty, knobs must be finite + within bounds) and DROPS
// anything invalid, falling back to the compiled default. A bad value here can
// only make the app DIFFERENT, never BROKEN — but keep it correct anyway.
//
// The shape mirrors desktop/electron/remote/runtime-config.ts (RuntimeConfigData
// as a partial delta). Kept as a plain object — no import from the desktop
// package (different deploy unit).

export interface RemoteConfigPayload {
  /** Monotonic version. The client accepts only a STRICTLY newer version. */
  version: number
  /** Partial model-alias overrides ('haiku' | 'sonnet' | 'opus'). */
  models?: { doerDefault?: string; router?: string; librarian?: string }
  /** Partial prompt overrides (whole strings). */
  prompts?: { intentCleanup?: string; taskName?: string; contract?: string }
  /** Partial behavioral-knob overrides (numbers; see runtime-config.ts bounds). */
  knobs?: Record<string, number>
}

/**
 * The current hosted config. Version 1 ships EMPTY of overrides on purpose:
 * it proves the pipe (the client fetches and ratchets its cache from 0 → 1)
 * while changing NOTHING out of the box — every value still resolves to the
 * app's compiled default. To roll out a real change, bump the version and add
 * the specific keys below.
 *
 * Example (do NOT enable without intent):
 *   version: 2,
 *   models: { doerDefault: 'opus' },
 *   prompts: { taskName: 'Name this task in 2-4 words…' },
 *   knobs: { hotThreadMs: 900000, mcpMaxSpawnsPerTask: 8 },
 */
export const REMOTE_CONFIG: RemoteConfigPayload = {
  version: 1,
}

/** Build the HTTP response for GET /v1/remote-config. Public, cacheable. */
export function remoteConfigResponse(extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(REMOTE_CONFIG), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Edge + client caching: config changes are eventual by design, and the
      // client also throttles its own fetches (launch + 6h). 5 min is plenty.
      'cache-control': 'public, max-age=300',
      ...extraHeaders,
    },
  })
}
