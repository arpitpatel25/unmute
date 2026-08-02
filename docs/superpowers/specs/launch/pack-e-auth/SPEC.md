# Pack E — Auth persistence

**Branch:** `arpit/launch-auth`
**Owns:** `desktop/electron/paywall-glue.ts`, `desktop/src/paywall/AuthContext.tsx`, `desktop/src/paywall/supabase-client.ts`
**Depends on:** nothing. Fully parallel — start immediately.
**Read first:** `../00-OVERVIEW.md`

---

## 1. The symptom

Users are signed out repeatedly. Clicking sign-in takes them to the browser where they are *already* signed in, and one round trip brings them back. It is not continuous — it happens after roughly ten to twenty minutes of not using the app. The reporter's own description:

> Dictation says "using the local model because you're signed out". Press escape, dictate again, and it works. Or switch tabs inside the app, and it signs in again by itself.

## 2. The diagnosis

**The credential was never lost. Nothing was refreshing it.**

`supabase-client.ts:56` sets `autoRefreshToken: true` in the **renderer**. `paywall-glue.ts:266` makes main's proactive refresh a **deliberate no-op**, with a comment explaining why: main and renderer both refreshed, Supabase rotates refresh tokens, the loser was rejected, supabase-js read that as "session compromised" and fired `SIGNED_OUT`.

That fix was right about the race and wrong about which side to keep. **In unmute the renderer is the part of the app that is not running.** Users live in the notch; the main window is hidden most of the time. Electron throttles hidden windows' timers, and supabase-js additionally stops its own auto-refresh when the document is hidden. Neither is being managed — there is no `startAutoRefresh`/`stopAutoRefresh` or visibility handling anywhere in the codebase.

So: window hidden → nothing refreshes → the access token expires → the next dictation hits an expired token, falls back to local, and reports "signed out". Anything that then calls `getSession()` — mounting a component, retrying — refreshes on demand, and the user is "signed in again".

## 3. The fix — two independent changes

### 3.1 Move refresh ownership to main

Invert today's arrangement. This removes the original race **by construction**, because only one process ever calls the token endpoint.

- **Main becomes the sole refresher.** Restore a proactive refresh in `paywall-glue.ts` — a timer that fires before expiry. Main is always awake and is not subject to renderer throttling.
- **Renderer sets `autoRefreshToken: false`.** It no longer competes.
- Main pushes new tokens over the existing `paywall:token-refreshed` channel; `AuthContext` adopts them via `setSession` as it already does.
- Keep the dedupe in `refreshAccessToken()`. Keep the reactive 401 path.
- `scheduleAutoRefresh()`'s comment must be rewritten to describe the new arrangement, including *why* it is main and not the renderer. The next person to read it must not re-derive the original fix and revert this one.

**Do not simply set `backgroundThrottling: false`.** It masks the failure without fixing ownership, and leaves two refreshers racing again.

### 3.2 An expired token is not a signed-out user

This is the change that delivers "a signed-in user should never be signed out", and it is separate from §3.1 — it makes the refresh path fail gracefully instead of visibly.

**Signed out must mean: the refresh token is gone, or the server rejected it.** Nothing else.

- Distinguish *no credential* from *stale access token* wherever auth state is derived.
- A stale access token with a valid refresh token must never render as signed out, and must never cause the dictation path to announce a downgrade. It refreshes and continues.
- If a refresh is genuinely in flight, the correct user-visible state is *nothing* — not an error, not a downgrade notice.
- `SIGNED_OUT` from supabase-js is authoritative only when the refresh token was actually rejected. A transient network failure is not a sign-out.

## 4. What to verify by reproduction, not reasoning

The diagnosis above is well-evidenced but not proven. **Reproduce it before fixing, and again after:**

1. Sign in. Confirm cloud transcription works.
2. Close or hide the main window. Leave the app running.
3. Wait past the access-token lifetime.
4. Dictate.

Before the fix: falls back to local and reports signed out. After: transcribes on cloud with no interruption.

If step 4 does **not** reproduce before the fix, stop and report — the diagnosis is wrong and the rest of this spec is built on it.

## 5. Constraints

- Do not change the sign-in flow, the OAuth deep link, or the keychain storage adapter.
- Do not touch anything outside the three owned files.
- The keychain remains the token store. `safeStorage` behaviour is unchanged.
- Note for the record: unsigned local builds degrade `safeStorage` to plaintext and can produce a *different* logout symptom. That is a build-configuration issue, not this bug, and is out of scope — but the reproduction in §4 must be run on a **signed** build so the two are not confused.
- `npm run typecheck` passes; tests do not regress.

## 6. Definition of done

A signed-in user with the main window hidden for an hour dictates and gets cloud transcription. Only one process ever calls the token endpoint. Nowhere in the UI does an expired access token render as signed out.
