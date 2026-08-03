# Pack E — Auth persistence: decisions

**Branch:** `arpit/launch-auth` · **Base:** `arpit/launch-readiness`, branched at `55cf515`
**Files changed:** `desktop/electron/paywall-glue.ts`, `desktop/src/paywall/AuthContext.tsx`, `desktop/src/paywall/supabase-client.ts` (+ this file)

> **Diff against `arpit/launch-readiness`, not `origin/main`.** VERIFY §20 and §15 name the
> wrong base; the coordinator recorded this as integration item I6. `launch-readiness` has
> since moved two commits ahead of the branch point, both docs-only, so the three-dot diff
> `arpit/launch-readiness...HEAD` is the correct and complete view of this pack.

---

## 1. Did the bug reproduce? — **No. I did not run the SPEC §4 reproduction.**

Stated plainly so it is not mistaken for a verified result: **the end-to-end reproduction in SPEC §4 was not run, before or after the fix.** Nothing below should be read as confirming the user-visible symptom.

What blocked it — the reasons are concrete, not "no credentials":

| §4 step | Blocked by |
|---|---|
| Build a **signed** app | Signing identities and notarisation secrets *are* present (`Developer ID Application: Arpit Patel (D8ZHT5S2XQ)`, `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` all set). But `npm run build` runs `build/wire-into-engine.sh`, which overlays this repo onto the OSS engine at `desktop/work/oss-engine` — **that directory does not exist in this worktree**, so no build of any kind can be produced here. |
| "Sign in" | Requires interactive Google OAuth in a browser as the real user. I cannot authenticate as them. |
| "Wait past the access-token lifetime" | ~1 hour. Feasible, but only after the two steps above. |
| "Dictate" | Requires holding a physical key and speaking into a microphone. |
| Installing the build at all | Per the project's own `unmute-test-build` guidance, installing a local build over the production app disturbs the user's real session. Doing that unattended to chase a repro would itself cause the symptom under investigation. |

**Assertions 26–32 and 34–36 are un-run and must be escalated to a human, not self-certified.**

## 2. What I could establish instead — and it changed the fix

I could not test the app, but I could test the *library the diagnosis rests on*: the installed `@supabase/auth-js` 2.108.2, driven directly, with a fake keychain and a fetch spy. Scripts are in the session scratchpad (not committed, because `desktop/package.json`'s test glob only covers `electron/remote/**` and `engine-overrides/**` — adding a permanent test would mean editing `package.json`, which this pack does not own).

### 2.1 The diagnosis's core mechanism: **confirmed**

With `autoRefreshToken: true` and `document.visibilityState = 'hidden'`:

```
token-endpoint calls while hidden = 0; auto-refresh ticker cleared = true
```

`GoTrueClient._onVisibilityChanged` calls `_stopAutoRefresh()` on `hidden`. So the renderer — the SPEC's "sole proactive refresher" — genuinely stops refreshing when the window is hidden, before Electron's timer throttling is even considered. The SPEC's §2 mechanism is real at the library level. What remains unproven is only the last link: that this is what the *user* experienced.

### 2.2 Evidence that **contradicts the SPEC's proposed fix**

SPEC §3.1 says: "Renderer sets `autoRefreshToken: false`. It no longer competes." **That is not true of this library**, and it matters because VERIFY §33 demands *cannot*, not *usually does not*.

Only `_recoverAndRefresh()` honours the flag. `__loadSession()` refreshes whenever the stored session is inside the 90s `EXPIRY_MARGIN_MS`, **ungated**, and it is reached from several places. Measured with `autoRefreshToken: false` and an expired session in storage:

```
after initialize()                    : 1 token call
getSession() on an expired session    : 1 token call
getUser()  on an expired session      : 1 token call
hidden -> visible transition          : 0 token calls
TOTAL with autoRefreshToken:false     = 3
```

The `initialize()` call is not even ours: `supabase-js`'s own `SupabaseClient` constructor registers an auth listener (`_listenForAuthEvents`), and registering a listener calls `getSession()` to emit `INITIAL_SESSION`.

**So `autoRefreshToken: false` alone would have left two processes able to call the token endpoint — exactly the outage condition — while the code read as if it had been fixed.** This is the most important finding in the pack.

### 2.3 Verification of the fix as actually built

Running the **real** `supabase-client.ts` (imported, not reimplemented) with an expired session in a fake keychain:

```
PASS  guard blocks every refresh-grant URL shape           3/3 blocked
PASS  guard lets every non-refresh auth call through       5/5 reached the network
PASS  the real client NEVER reaches the token endpoint     network refresh-grant requests = 0
                                                           (total network calls by the client = 0)
PASS  the blocked refresh does NOT emit SIGNED_OUT         auth events = ["INITIAL_SESSION"]
PASS  the credential is still in the keychain afterwards   keychain keys = ["sb-probe-auth-token"]
PASS  a token pushed from main is adopted                  setSession -> session present
6/6
```

---

## 3. Judgement calls

### 3.1 The renderer is blocked at the transport layer, not just by a flag

Given §2.2, `autoRefreshToken: false` is necessary but not sufficient. The renderer's client is additionally built with a `fetch` (`rendererFetchWithoutRefresh`) that refuses a refresh-token grant. **This is what makes VERIFY §33 answerable as "cannot".** The proof is by inspection, in three steps:

1. `getSupabase()` is the only constructor of a supabase client in the renderer (`grep -rn "createClient" desktop --include='*.ts*'` → one match, in `supabase-client.ts`), and it passes `global: { fetch: rendererFetchWithoutRefresh }`.
2. `supabase-js` hands `settings.global.fetch` straight to its auth client (`dist/index.cjs:1256` → `_initSupabaseAuthClient(..., settings.global.fetch)`), and `GoTrueClient` uses it for *every* request via `resolveFetch(settings.fetch)`. There is no second path to the network.
3. `rendererFetchWithoutRefresh` rejects any request to a `…/token` path carrying `grant_type=refresh_token`, **before** calling `fetch`.

So the renderer's refresh does not lose a race; it never starts one. Main is the only process with a code path to the endpoint (`grep -rn "grant_type=refresh_token" desktop` → matches only in `paywall-glue.ts`).

### 3.2 The guard *throws* rather than returning an error response

Deliberate, and load-bearing. `auth-js` wraps a thrown fetch into `AuthRetryableFetchError`; its refresh path treats a retryable error as "the network is down" and **preserves the stored session without emitting `SIGNED_OUT`** (`_callRefreshToken`'s `if (!isAuthRetryableFetchError(error))` guard). An HTTP error response would instead be non-retryable and would destroy the session — turning the guard into the very bug we are fixing. Confirmed empirically in §2.3.

Side effect, and it is not small: `_refreshAccessToken` wraps the call in `retryable()` with exponential backoff bounded by `AUTO_REFRESH_TICK_DURATION_MS` (30s). Because the guard refuses instantly, the whole budget is spent sleeping — **a blocked refresh takes ~25 seconds to give up**, measured. Nothing touches the network, and `lastRefreshFailure` then caches the failure for 60s keyed by refresh token so it does not repeat per call. But any code path that *awaits* a supabase-js call which internally refreshes will stall for 25s. Two did; see §5.5. **Anyone adding a new `await supa.auth.*` call in the renderer must check whether it can reach `__loadSession` on a stale token, and must not block the UI on it.**

### 3.3 The refresh-grant check parses the URL instead of matching the string

`isRefreshGrant()` uses `new URL()` + `searchParams.get('grant_type')`. This is the more robust check — parameter order and percent-encoding cannot slip past it — and it also means the literal `grant_type=refresh_token` does not appear in renderer code, which keeps VERIFY §6's grep clean and truthful. **Flagging it explicitly so nobody thinks the grep was gamed:** the intent is the robust parse; the clean grep is a consequence, and the check is *stricter* than a substring match, not weaker.

It is deliberately **looser than the one URL shape auth-js 2.108.2 happens to emit today**, which is the opposite of what a first reading suggests. An interlock that recognised only the exact current string would be silently unpicked by a dependency bump, with every gate in this repo still green (nothing here compiles or tests these files — §4). So relative URLs are resolved against a base, trailing slashes are stripped, the path test is `/token` rather than the full `/auth/v1/token` mount, and a URL too malformed for `new URL()` still fails **closed** if it names the grant. Round four found the earlier version failing *open* on both the trailing-slash and the unparseable cases; see §5.6.

The over-matching risk is the one that would break sign-in, and it is bounded by the `grant_type` test: auth-js issues exactly five grants — `password`, `web3`, `pkce`, `id_token`, `refresh_token` — and only the last is refused. `exchangeCodeForSession` uses `pkce`; `/auth/v1/user` and `/auth/v1/logout` carry no `grant_type` at all. All verified to pass through.

### 3.4 Main's timer margin: 5 minutes

`REFRESH_MARGIN_SEC = 300`, versus supabase-js's `EXPIRY_MARGIN_MS = 90s`. Chosen so main renews while the renderer's copy still looks fresh to supabase-js — in normal operation the renderer never even *wants* to refresh, so the guard in §3.1 is a backstop rather than a hot path. Fires before expiry, never on it.

Loop safety: `MIN_REFRESH_INTERVAL_MS = 30_000` floors the gap between two proactive refreshes. Without it, a token issued with a lifetime shorter than the margin would schedule at 0ms forever. A due-in-the-past deadline (cold start, wake from sleep) still fires immediately, because `lastProactiveRefreshMs` is 0 / long past in exactly those cases.

Failure handling: a *transient* failure re-arms at `REFRESH_RETRY_MS` (60s) — previously nothing re-armed after a failed refresh at all, so an offline stretch left the session with nothing to renew it. A *rejected* refresh token clears the session, and the re-arm is guarded on `currentSession.refreshToken` so it stops rather than polling a credential that no longer exists.

### 3.5 "Signed out" now has exactly one definition, and main owns it

Main is the only process that calls the token endpoint, so main is the only one that can be *told* a refresh token is dead. `refreshAccessToken` splits the failure on **two** axes, and both are needed — getting only the first right is what round four caught (§5.6):

1. **Is the error even about the credential?** `>= 500` (incl. Cloudflare 520–530) or `429` → transient, session kept. This mirrors `auth-js`'s own `NETWORK_ERROR_CODES` list. **429 is called out separately** because Supabase does rate-limit the token endpoint and a rate-limit must never read as a revocation. A thrown fetch (offline) lands in the `catch` and is likewise non-destructive.
2. **Is the rejection decisive yet?** Everything else *looks* like a rejection — but this refresh fires 300 s **before** expiry, so it normally arrives while the access token still works, and a 4xx can come from a WAF, a captive portal or a MITM proxy rather than from Supabase. So a rejection clears the session **only once the access token has also expired**, i.e. once the refresh token is the sole remaining credential. Until then the session is kept and `armRefreshTimer` retries at `REFRESH_RETRY_MS`. `auth-js` draws the line in exactly the same place (`_callRefreshToken`: *"destroying it now would log out a user whose access token works"*).

When both axes say yes: `clearSessionState()`, and broadcast a **null token pair** on the existing `paywall:token-refreshed` channel.

This converges rather than deferring forever — with a genuinely revoked token the retries continue only until the access token expires (≤ 5 more attempts at the 3600 s default), and the first rejection after that is decisive. VERIFY §14 still holds; it just cannot fire earlier than it should.

The null pair is the new "your credential was rejected" signal. It rides an existing channel deliberately: adding an IPC would mean editing `electron/preload-extensions.ts`, which this pack does not own.

Because a null in that field is now meaningful, the success broadcast was changed to send `currentSession.refreshToken` rather than `body.refresh_token` — if the server ever omitted a rotated token, the old code would have broadcast `refreshToken: undefined` and **signed the user out on a successful refresh**. That was a footgun introduced by this design and closed in the same change.

### 3.6 What the renderer will and will not act on

`AuthContext` previously did `setUser(session?.user ?? null)` on *every* auth event and on the bootstrap `getSession()`. That single line is the whole of §3.2's bug: a null session pushed `accessToken: null` into main, and main's `getPaywallAccessToken()` returning null is precisely what makes `shouldTryManaged()` false, dictation fall back to local, and `main-extensions.localReason()` report `not_signed_in`. **The UI flipping to signed-out and the dictation downgrade are the same event.**

Now:

- `getSession()` returning `{ session: null, error }` → keep the cached user, and **do not push null to main**. Measured in §2.3: this is exactly what a blocked/failed refresh produces (`session=null`, `AuthRetryableFetchError`) while the credential is still in the keychain.
- `getSession()` returning `{ session: null, error: null }` → genuinely nothing stored → sign out.
- A null session on `INITIAL_SESSION` / `TOKEN_REFRESHED` / `USER_UPDATED` → not a sign-out. Ignored.
- `SIGNED_OUT` → honoured, but see below.

### 3.7 `SIGNED_OUT` is corroborated, not obeyed (VERIFY §11)

`supabase-js` emits `SIGNED_OUT` from `_removeSession`, which it also reaches for a stored session it merely failed to *parse* — not only for a rejected credential. So an unsolicited `SIGNED_OUT` asks main for a second opinion via `paywallGetUser()`; if main still holds a session, the event is ignored.

This is safe rather than sticky because main clears its own session the moment the server rejects the refresh token (§3.5), so "main still has a user" really does mean "the credential has not been rejected". It is also self-healing: main's next broadcast feeds a good token back through `setSession` and repopulates the keychain.

Two routes bypass the second opinion by setting `signOutExpectedRef` first — the user pressing Sign out, and main's null-pair broadcast. So explicit sign-out stays immediate and complete (VERIFY §31), and a genuine revocation still signs the user out (VERIFY §14) — **detected by main, not by the renderer**, which is the necessary consequence of the renderer no longer being able to call the endpoint.

`paywallGetUser` is reached through a local cast. `window.electronAPI`'s ambient type comes from the OSS engine at build time and is not resolvable in this repo, so the cast avoids depending on a declaration I cannot see or verify here. The method itself is real (`electron/preload-extensions.ts:142`).

### 3.8 "Main is always awake" is not the load-bearing claim — and saying it was, was wrong

SPEC §2 argues main wins because it "is always awake and is not subject to renderer
throttling". The first half of that is not quite true on macOS, and the original comment in
`scheduleAutoRefresh` repeated it ("Main has no window, no visibility state and no
throttling"). **App Nap stretches a backgrounded app's timers in the main process too** —
this repo already knows that: `warmNow`'s pre-existing comment says the 25s keep-alive timer
"macOS App Nap suspends … while the app is backgrounded". Sleep stops main's timers outright.

The fix survives that, and the reason is worth stating precisely because it is *not* "main
doesn't get throttled":

- Main can refresh **on demand**. `ensureFreshToken()` runs at recording start
  (`sessionManager.ts:907`) and again before every managed call (`paywall-route.ts:116,269`),
  and `powerMonitor.on('resume')` calls it on wake (`main-extensions.ts:118`). All three are
  pre-existing and unchanged by this pack. A timer that fires late costs one on-demand
  refresh at the top of a dictation.
- The renderer had no equivalent recovery. By the time supabase-js noticed anything, the
  routing decision had already been made and the call was already on the local model — which
  is the whole symptom.

So the correct claim is **"main can still act when it wakes up"**, not "main never sleeps".
The code comment was corrected to say that; a future reader who believed the stronger claim
could reasonably conclude the timer alone is sufficient and delete one of the on-demand
calls.

### 3.9 `backgroundThrottling` was not touched

Forbidden by SPEC §3.1 and not used. The one pre-existing occurrence, `electron/remote/overlay.ts:143`, is untouched and outside this pack — VERIFY §5's `grep -rn backgroundThrottling desktop/` will find it, but it is **not in this diff**.

---

## 4. Verification status of the build gates

Both are reported as measured, not as passed.

### `npm run typecheck` — **fails on the base commit too. Measured per stage, before vs after.**

VERIFY §23 asks for `exit 0`. That is not achievable and never was: the script is
`tsc -p tsconfig.typecheck.json && tsc -p tsconfig.renderer.json`, the first stage fails on
the base commit in files no pack may touch, and `&&` short-circuits so the renderer stage
never even runs. The coordinator recorded this as integration item I6. The gate was therefore
**measured per stage against `arpit/launch-readiness`** rather than asserted:

| stage | base `arpit/launch-readiness` | this branch |
|---|---|---|
| `tsc -p tsconfig.typecheck.json` | 3 errors | 3 errors |
| `tsc -p tsconfig.renderer.json` | 137 errors | 137 errors |

Not increased. The three stage-1 errors are pre-existing and in other packs' files
(`electron/remote/init.ts` ×2 → Pack F; `electron/remote/notch/notch-controller.ts:34`
`Cannot find name 'TurnP'` → notch). They were escalated, not touched.

The counts are identical **by construction, not by luck**: neither config compiles any file
this pack changed. Proved directly rather than inferred —

```
tsc -p tsconfig.renderer.json  --listFiles | grep -E 'src/paywall|paywall-glue'  → (empty)
tsc -p tsconfig.typecheck.json --listFiles | grep -E 'src/paywall|paywall-glue'  → (empty)
```

`tsconfig.typecheck.json` includes only `electron/remote/**` + `electron/remote-preload.ts`;
`tsconfig.renderer.json` only `engine-overrides/renderer/**`. `electron/paywall-glue.ts` and
`src/paywall/**` are in neither, and nothing in either include-set imports them.

**So no check in this repo compiles my three files.** They were typechecked separately against
an ad-hoc config (`src/paywall/**` + `electron/paywall-glue.ts` + the electron stub), before
and after, and the normalised error sets compared: **75 → 79, no new error category.** The
whole delta is `Property 'electronAPI' does not exist on type 'Window'` ×5 — one per new
`window.electronAPI` call site — plus an implicit-any that moved from two binding elements to
one callback parameter. That error already fires at all 40 pre-existing `electronAPI` call
sites in these files: the ambient declaration comes from the OSS engine at build time and is
not resolvable in this repo. It disappears in the real engine build, which is the only place
these files are actually compiled and which could not be run here (see §1).

### `npm test` — **1400/1400 pass**

Baseline 1400/1400. First post-change run showed `1399/1400`, failing `electron/remote/capture/index.test.ts` → "a sequence that never ends expires, and observation resumes". Investigated rather than re-run-until-green:

- No test file in the suite imports `paywall-glue`, `AuthContext`, or `supabase-client` (`grep -rln` over all `*.test.ts` → no matches). The glob does not even include `src/`.
- That test in isolation: **5/5 passes**.
- Full suite re-run: **1400/1400, exit 0**.

Conclusion: a pre-existing timing-sensitive test that is flaky under full-suite load. Not caused by this change, and not "fixed" by it either.

---

## 5. What independent verification caught — seven rounds, and what each one cost

The verification subagent found two genuine, severe regressions in the first cut of this pack. Both are recorded here because both are instructive about the shape of this change, and because the first cut *passed every `[auto]` check while being broken*.

Both have the same root cause: **`supabase-js` fuses "read the session" with "refresh it if stale".** `__loadSession()` does not have a read-only mode. So the moment the renderer is denied refresh, every *read* of an expired session also fails — and things that merely wanted to read got caught in the blast.

### 5.1 Cold start left main with no credential at all — and no way to get one

Main has no independent way to load a session: `currentSession` starts all-null and the only writer is the `paywall:set-session` IPC, whose only caller is the renderer. The renderer's only source was `getSession()` — which, after the app had been closed long enough for the access token to expire, returned `{ session: null, error }`, and my new "don't push null to main" branch then returned without pushing anything.

Net effect: UI shows the cached user as signed in, main holds no token, the refresh timer is never armed, dictation routes to local — **permanently**, with a perfectly good refresh token sitting unused in the keychain. This is a regression against the base commit, where the unguarded renderer simply refreshed on cold start. "Quit overnight, reopen, dictate" would hit it every morning: the same symptom the pack exists to fix, relocated from *window hidden* to *app restarted*.

**Fix:** when `getSession()` errors, read the persisted session straight from the keychain (`readStoredSession()`) and push the credential to main. Main is the only process that can use a refresh token, so handing it one is all that is required — `scheduleAutoRefresh()` sees a past-due expiry, refreshes at once, and broadcasts, which repairs supabase-js's own session via `setSession`.

Verified against the real module: `getSession() -> session=null, error=AuthRetryableFetchError` while `readStoredSession() -> refreshToken=<present>, user=<present>`.

### 5.2 Sign-out became a silent no-op exactly when the token was stale

`GoTrueClient._signOut()` opens with `_useSession`, and:

```js
if (sessionError && !isAuthSessionMissingError(sessionError)) {
    return this._returnResult({ error: sessionError });   // ← before _removeSession()
}
```

A blocked refresh produces `AuthRetryableFetchError`, not `AuthSessionMissingError`. So `signOut()` returned early: storage not cleared, no `SIGNED_OUT` emitted. And it **resolves** with an `{ error }` rather than throwing, so the existing `try { await signOut() } catch {}` caught nothing. `AuthContext` was relying entirely on an event that never arrived.

Consequences: pressing Sign out did nothing at all (VERIFY §31), and the revoked-token path — which by definition runs when the access token is stale — hit the same early return, so a genuine revocation left the renderer showing a signed-in user (VERIFY §14).

**Fix:** `signOut()` still asks supabase-js (it revokes server-side when it can) but no longer depends on it. It then destroys the credential itself (`clearStoredSession()`), clears main (`paywallSignOut()`), and clears local state — unconditionally.

Verified against the real module: after `supa.auth.signOut()` the credential was **still in the keychain** and the only event seen was `INITIAL_SESSION`; after `clearStoredSession()` the keychain is empty and `readStoredSession()` returns null.

### 5.3 Sign-out during an in-flight refresh could resurrect the session

Lower severity, also real, and made worse by this pack because a resurrected session now re-arms an hourly timer. `refreshAccessToken` mutates `currentSession` after its `await fetch`; `clearSessionState()` rebinds the module-level object, so a refresh that started before a sign-out would write a fresh token into the session that replaced it and broadcast it to the renderer, signing the user back in.

**Fix:** a `sessionGeneration` counter, bumped by `clearSessionState()` and checked after the fetch — the same commit-guard shape `auth-js` uses internally (`_sessionRemovalEpoch`). A refresh whose generation has moved discards its result.

### 5.4 Round two: the fix for 5.2 was applied to only one of the two sign-out routes

A second verification pass caught that 5.2's remedy had been applied to the user-initiated `signOut()` but **not** to the revocation route, which called `supa.auth.signOut({ scope: 'local' }).catch(() => honourSignOut())`. That route depends on the exact primitive 5.2 established cannot be trusted — and recovers only via `.catch()`, which never fires because `signOut()` resolves with an `{ error }` instead of rejecting.

It is also the worse of the two places to get wrong: the revocation path runs *by definition* when the access token is stale, so it would always have taken `_signOut`'s early return. A genuinely revoked credential would have left the renderer showing a signed-in user with no token anywhere, the dead credential surviving into the next launch, and `signOutExpectedRef` latched `true` — disabling the corroboration in §3.7 for the rest of the session.

**Fix:** both routes now share one `tearDownSession(scope)`, which asks supabase-js (best effort, for the server-side revoke) and then unconditionally clears the credential, main, and local state, and always unlatches the ref. `signOut()` is `tearDownSession('global')`; revocation is `tearDownSession('local')` — nothing left to revoke.

The generation guard was also widened: `paywall:set-session` now bumps it when the incoming refresh token *differs* from the one held, so a refresh in flight against a replaced credential is discarded rather than written back. An identical refresh token — the ordinary echo of main's own broadcast returning through `setSession` — deliberately does not bump.

### 5.5 Round three: the guard's cost was 25 seconds, not milliseconds

I had written in §3.2 that a blocked refresh costs "~4 re-entries over a few hundred ms". **That was wrong, and a third verification pass caught it.** `_refreshAccessToken` wraps the call in `retryable()` with exponential backoff bounded by `AUTO_REFRESH_TICK_DURATION_MS` — 30 seconds. Because the guard refuses instantly, the entire budget is spent sleeping. Measured against the installed library:

```
readStoredSession() on an expired session :     0 ms
getSession()        on an expired session : 25435 ms   -> session=null, AuthRetryableFetchError
signOut()           on a FRESH session    :     3 ms
```

This made two paths pathological:

- **Cold start.** The credential hand-off to main was inside `getSession()`'s `if (error)` branch, so main got nothing for ~25 seconds after every launch following a night's downtime. Dictation would run on the local model and announce a downgrade for that whole window — the pack's own symptom, relocated to app start.
- **Sign-out.** `tearDownSession` awaited `auth.signOut()` before clearing anything. With a stale token that is a ~25s wait that then clears nothing, so the user would press Sign out and stay visibly signed in.

**Fixes:**

1. The credential hand-off moved **out of** the `getSession()` continuation and now runs first, unconditionally, straight off the keychain — 0 ms. `getSession()` still runs, still corrects the UI, but nothing waits on it. Main gets what it needs immediately, refreshes, and broadcasts.
2. `tearDownSession` races supabase-js's `signOut()` against `SIGN_OUT_REVOKE_BUDGET_MS` (1500 ms) instead of awaiting it. The revoke request is **not cancelled** — a slow-but-successful server-side revoke still completes, it just stops holding up the UI. A healthy sign-out is unaffected (3 ms).

Measured after: hand-off 0 ms; stale sign-out 1500 ms and complete; fresh sign-out 3 ms and complete.

Also closed in this round (the verifier's residual risk): `paywall:set-session` now **refuses a push older than the credential main already holds** for the same user. The round-three bootstrap change made this materially more likely — the renderer now pushes a keychain-read credential at startup, which a second window (or a hand-off that crossed a refresh main had already done) could deliver after rotation. Adopting it would have swapped a good token for a rotated-away one, whose next refresh gets a 400 and signs the user out for real. Sign-out pushes (no expiry) and account switches (different user) are deliberately exempt.

### 5.6 Round four: a fresh verifier found a spec violation I had written into main

This round ran after the pack was already believed finished, against a verifier that had not
seen any earlier round. It returned two FAILs. The first is the more serious, and it is mine:

**F-1 — main hard-signed-out on *any* non-5xx/429 refresh response, even while the access
token was still good.** The classifier was `res.status >= 500 || res.status === 429` →
transient, **everything else → `clearSessionState()` + null-pair broadcast → the renderer
deletes the keychain credential.** But this timer fires `REFRESH_MARGIN_SEC` (300 s) *before*
expiry, so a rejection normally arrives while the user's access token still works. And a
non-2xx is not proof of revocation: a Cloudflare WAF rule, a captive portal, a corporate MITM
proxy or a misrouted 4xx all land in that branch. The result would have been a full browser
OAuth round trip for a user whose credential was fine — **the exact symptom this pack exists
to remove, with a worse recovery, and a direct violation of SPEC §3.2** ("Signed out must
mean: the refresh token is gone, or the server rejected it. Nothing else.").

It was also a regression against the base, which did `console.warn(...); return false` and
never cleared anything. I introduced it in the same change that introduced the proactive timer
— the timer is what made "refresh failed" reachable while the access token was still valid.

`auth-js` refuses to do this, in as many words: `_callRefreshToken` re-reads storage on a
non-retryable error and calls `_removeSession()` only if `!accessTokenStillValid`, commenting
*"destroying it now would log out a user whose access token works."* §3.5 claimed to mirror
auth-js's split and mirrored only half of it — the retryable/non-retryable half, not the
proactive/reactive half.

**Fix:** a rejection is decisive only once the access token has also expired, i.e. once the
refresh token is the sole remaining credential and a rejection really does mean there is
nothing to recover. Until then the session is kept and `armRefreshTimer` retries at
`REFRESH_RETRY_MS`. This converges: with a genuinely revoked token the retries continue until
the access token expires (≤ 5 further attempts at the 3600 s default), and the first rejection
after that signs the user out — so VERIFY §14 still holds, just no earlier than it should.

**F-2 — a rotated refresh token is persisted only if a live renderer receives the
broadcast. ESCALATED, not fixed — the fix needs a file this pack does not own.** See §6 risk 12.

Three smaller findings from the same round, all fixed:

- **The `SIGNED_OUT` route reached main through the wrong door.** `honourSignOut` ended with
  `pushSessionToMain(null)`, which nulls `currentSession` but does not run
  `clearSessionState()` — so `remoteTriggerEntitled` stayed set and the per-account trigger
  pref was not reset. The Remote key stayed live for a user main considered signed out, and
  the next account would inherit this one's choice. Now calls `paywallSignOut()`, the same
  teardown the other two routes use.
- **`isRefreshGrant` failed *open*.** An unparseable URL returned `false`, and
  `/auth/v1/token/` with a trailing slash was not matched (probe-confirmed by the verifier).
  Neither is reachable from auth-js 2.108.2 — but the entire "cannot" claim of §3.1 was pinned
  to one version's exact URL construction, with nothing in the repo testing it. The guard now
  resolves relative URLs, strips trailing slashes, matches on `/token` rather than the full
  `/auth/v1/token` mount, and fails **closed** on a parse failure that still names the grant.
  It remains narrow enough not to touch sign-in: every other grant auth-js issues (`password`,
  `pkce`, `id_token`, `web3`) and every non-token endpoint fails the `grant_type` test.
- **`getCurrentUser()` had no hazard warning** while `getAccessToken()` directly above it did,
  despite being the more dangerous of the two — it reaches `__loadSession` via `getUser()` and
  so inherits the ~25 s stall and the null-for-a-signed-in-user result. Both are uncalled; the
  next caller of either would reintroduce the pack's own bug. Now documented.
- The file header of `supabase-client.ts` claimed *"The Electron main process also has its own
  client"*. It never did — main uses a plain `fetch`. In a pack whose whole subject is which
  process may talk to the auth API, a header asserting a second client is actively misleading.
  Corrected.

### 5.7 Round five: the F-1 fix was right and incomplete in three places

A second fresh verifier, given the round-four fixes, returned **no FAILs** — and then found
three real defects in the fix itself. All three are the same shape: a correct new rule applied
to some of the paths it governs and not all of them.

- **The commit guard was on the constructive path only.** `refreshAccessToken` checked
  `sessionGeneration` before *writing* a new token but not before *destroying* the session on
  a rejection. So a 4xx arriving after the credential had been replaced would be read against
  the replacement — judging credential B by A's rejection and deleting a credential nobody
  rejected, then broadcasting the null pair that makes every renderer wipe the keychain. The
  destructive path needs the guard at least as much as the constructive one. Now guarded.

- **`expiresAt == null` walked straight through the F-1 protection.** The new test was
  `accessToken && expiresAt != null && expiresAt > now`; a session with no recorded expiry
  failed it and was treated exactly as an expired one — i.e. **F-1 was still live on that
  path**. It is reachable: `readStoredSession()` tolerates a stored session with no numeric
  `expires_at`, and a refresh response can carry neither `expires_at` nor `expires_in`.
  Unknown is now its own case: hold the session, but only for `MAX_UNDECIDED_REJECTIONS` (3)
  rejections, then accept the verdict. Treating unknown as expired abandons the protection;
  treating it as valid forever makes revocation undetectable; a bounded hold does neither.

- **The retry had no backoff and no ceiling.** A permanently-5xx token endpoint meant one
  request every 60 s forever — roughly 10,000 per client per week, and *new*: before this pack
  nothing re-armed after a failed refresh at all. During a multi-hour Supabase incident that is
  every installed client polling in lockstep. Now doubles per consecutive failure to a 15-minute
  cap. It costs nothing in recovery time for the case that matters, because the paths a user
  actually waits on don't use the timer: `ensureFreshToken()` refreshes on demand at the top of
  every dictation, and `powerMonitor`'s `resume` does the same on wake.

All three counters reset on any successful refresh, on `clearSessionState()`, and when
`paywall:set-session` installs a different credential — a new sign-in must not inherit the dead
one's backoff or its rejection tally.

**One finding was assessed and deliberately not acted on.** The verifier flagged the bootstrap
branch at `AuthContext.tsx` (`getSession()` → clean `null`, no error → `pushSessionToMain(null)`)
as "the same site" as `honourSignOut`, which round four changed to `paywallSignOut()`. They are
not the same. `honourSignOut` is a *transition* — the user was signed in a moment ago and now is
not, so main's per-session state (the Remote entitlement, the trigger pref) has to come down
with it. The bootstrap branch is not a transition: it fires at launch when the keychain is
empty and main has never held a session this run. Routing it through `paywallSignOut()` would
reset Remote settings on every launch of a signed-out user, reaching into a subsystem this pack
has no business in. The underlying observation — that a persisted `remoteTriggerEntitled: true`
can survive into a launch where nobody is signed in — is real, **pre-existing, and not created
by this pack**; recorded as risk 13 rather than fixed here.

### 5.8 Round six: the timer, and a 4xx that isn't from Supabase

A third fresh verifier returned no FAILs and executed the new state machine rather than
reading it — six failure scenarios over virtual time, all terminating correctly. It then found
five more defects, four of them in the machinery rounds four and five added. All fixed.

- **The retry re-arm had no commit guard, though the refresh it followed did.** Round five put
  the generation check inside `refreshAccessToken`; the timer callback that *calls* it re-armed
  on `!ok && currentSession.refreshToken` without one. Demonstrated: a sign-in landing while a
  doomed refresh was in flight had its correct ~55-minute deadline clobbered by a 60 s retry
  belonging to the credential it replaced — and the failure counters `paywall:set-session` had
  just reset were re-dirtied one line later. The callback now captures the generation at tick
  and returns if it moved. Same lesson as §5.7's first bullet, one level up the call stack:
  guarding the operation is not the same as guarding the thing that schedules it.

- **A captive portal could sign a user out — and precisely when it is most likely to.**
  `res.status >= 500 || res.status === 429` classified everything else as a verdict from
  Supabase. Hotel and conference wifi, corporate MITM proxies and misconfigured gateways all
  answer a POST with a 4xx and an HTML body. The protection added in round four cannot help,
  because it only holds while the *access token* is still valid — and the scenario where this
  fires is "laptop slept for hours", where it is long expired. So: portal 403 → session
  destroyed → full browser OAuth round trip, on a machine that has no working internet yet.
  This is VERIFY §29's scenario. GoTrue always answers a rejected refresh with its own JSON
  error shape, so the fix costs nothing against the real server: a rejection is now only acted
  on if the body parses as JSON carrying `error_code` / `code` / `error` / `msg` /
  `error_description`. Anything else is treated as transient. auth-js draws the same line, via
  `isAuthApiError` on a parsed body.

- **`setTimeout` overflow.** `dueMs` is derived from a server-supplied `expires_at` and was
  passed to `setTimeout` unclamped. Past ~24.85 days it exceeds the signed 32-bit delay, and
  Node fires it on the **next tick** instead — and since success re-arms the same way, that is
  a hot loop against the token endpoint, not a late timer. Unreachable from a legitimate
  Supabase config (JWT expiry caps at a week) so this is corrupt-state hardening, but the
  failure mode is bad enough to be worth three lines. Now clamped, with a NaN fallback.

- **The unknown-lifetime branch was a rotation storm waiting for a shape Supabase doesn't
  send.** `scheduleAutoRefresh` armed at `REFRESH_RETRY_MS` when `expiresAt == null` — and that
  is the one branch where a *success* re-arms itself, since with no expiry there is no deadline
  to compute and every refresh lands back in it. So the retry delay silently became the
  rotation rate: one refresh a minute, forever, each one rotating the refresh token. Now armed
  at the cap (four an hour) instead.

- **`undecidedRejections` did not mean "consecutive".** The offline `catch` did not reset it,
  so an offline stretch interleaved with unknown-expiry rejections still counted toward a
  sign-out. It always converged, so this was a semantics bug rather than a hang. Reset added,
  and the commit guard moved above the transient branch so a response belonging to a discarded
  session can no longer touch the live session's counters either.

### 5.9 Round seven: closing, and where I chose to stop

A fourth fresh verifier returned **no FAILs, all 24 `[auto]` assertions passing**, and stated
the pack is finished modulo the `[eye]` items. It executed the two changes most likely to be
wrong rather than reading them: `looksLikeSupabaseAuthError` against all five real GoTrue error
bodies (the legacy shape this code actually elicits — no `X-Supabase-Api-Version` header — hits
on three independent keys, and `code` is numeric there and a string in the 2024-01-01 shape,
which is why the test accepts both), and the timer's generation guard (the bump and the re-arm
in `paywall:set-session` are in the same synchronous run, so a live session can never be left
with no armed timer).

Three of its remaining findings were small, certain, and worth taking:

- **The refresh request had no timeout.** `refreshInFlight` dedupes every caller onto one
  promise, and two of those callers are `await ensureFreshToken()` on the managed-STT path. A
  hung socket therefore stalls a *dictation* for as long as the request takes to give up —
  undici's default body timeout is 300 s. Now bounded at 15 s, which rejects into the catch and
  is handled as transient. `AbortSignal.timeout` is already used elsewhere in this main process.
- **`MIN_REFRESH_INTERVAL_MS` did not floor a reactive refresh.** `lastProactiveRefreshMs` was
  written only inside the timer tick, so a refresh triggered by `ensureFreshToken` or a 401 that
  returned a token already inside the 300 s margin computed `floorMs = 0` and re-armed
  immediately. Bounded, but a server issuing short-lived tokens would have sustained two
  rotations a minute. Now set on every successful refresh.
- **Two comments claimed more than the code delivers** — the guard's `catch` described as
  failing closed when resolving against a base means almost nothing reaches it, and "GoTrue
  always answers with JSON" glossing over Supabase's gateway, which can answer `{"message":…}`
  and is deliberately treated as transient. Both corrected: in a pack whose value is largely in
  what the next reader believes, a comment that overstates the guarantee is a defect.

**And where I stopped.** Four further findings were assessed and deliberately left as recorded
risks rather than code (14–17 below). The common thread: each needs a condition outside normal
operation, and by this point every round of fixes had itself introduced something — the
marginal value of another change was below the marginal risk of making one. They are written
down precisely enough to act on if any of them ever shows up in the field.

### 5.10 The lesson worth keeping

Every `[auto]` assertion in VERIFY.md passed on the broken first cut, and on every broken cut
after it. Seven verification rounds found eleven real defects between them, and **not one was
visible to an `[auto]` check** — because every single one was about a *sequence over time*
(cold start after expiry; sign-out while stale; a rejection landing after the credential was
replaced; a retry re-armed for a credential that no longer exists; a timer that overflows into
a hot loop) rather than about the shape of the code. Greps and type errors cannot see any of
that. Only executing the state machine could, and the rounds that found the most were the ones
that ran it instead of reading it.

The second, harder lesson: **a correct new rule is usually applied to fewer paths than it
governs.** Rounds five, six and seven each found the previous round's fix in one place and
missing from its sibling — the commit guard on the constructive path but not the destructive
one, then on the refresh but not on the timer that schedules it; the sign-out teardown on one
route and not the other. After each fix, the question worth asking is not "is this right?" but
"where else does this rule apply, and did I put it there too?"

**VERIFY's §F reproduction list is missing two cases**, both of which the rounds above showed
matter more than the ones it has:
- *Quit the app, wait past the access-token lifetime, relaunch, dictate.* Would have caught 5.1.
- *Sign in, **close** (not hide) the main window, leave it running past one refresh, quit,
  relaunch, dictate.* This is the only test that can settle risk 11 — and §28 as written tests
  the window *hidden*, which is the case that cannot fail.

---

## 6. Open risks, stated rather than smoothed over

1. **The symptom itself is still unproven.** §2.1 confirms the mechanism the diagnosis names, but nobody has watched a signed build sign a user out and then watched it not do so. VERIFY §F remains the only real evidence and remains un-run.
2. **My three files compile nowhere in this repo.** The isolated typecheck is a good signal, not a build.
3. **Revocation is now detected only by main.** By construction — the renderer cannot call the endpoint. If main never had the session (a cold start that never received `paywall:set-session`), a revoked credential would not be noticed until something forces a refresh. Previously the renderer might have noticed first. Judged an acceptable trade for removing the second refresher; worth a look during the §F pass (VERIFY §14).
4. **`signOutExpectedRef` is not time-boxed.** If `signOut()` were to set it and no `SIGNED_OUT` ever arrived, the next unsolicited `SIGNED_OUT` would be honoured without the second opinion — i.e. it degrades to today's behaviour. Left simple on purpose.
5. **The guard's retry noise.** ~4 refused re-entries per blocked refresh, none reaching the network, then suppressed for 60s by `auth-js`'s own failure cache. Cosmetic in logs.
6. **A short JWT TTL would turn the margin into a rotation storm.** `dueMs = (expiresAt - 300) * 1000 - Date.now()`. Supabase allows a JWT expiry as low as 300s; at or below that, `dueMs` is permanently negative and `MIN_REFRESH_INTERVAL_MS` pins refresh to one every 30s. Harmless at the 3600s default and it is not a race — but check this before anyone lowers the project's token TTL.
7. **The preload's declared type for `paywall:token-refreshed` is now inaccurate.** `electron/preload-extensions.ts:296` types the callback as `{ accessToken: string; refreshToken: string }`, but main now also sends `{ accessToken: null, refreshToken: null }` as the "credential rejected" signal. It is correct at runtime, and `AuthContext` handles both shapes, but the declaration should be widened to `string | null`. **That file is outside this pack's ownership, so it was not touched** — it needs a one-line change by whoever owns it. Combined with risk 2 (nothing typechecks the renderer), no check in this repo would catch a future mismatch here.
8. **`setSession()` costs one extra round trip per adoption.** `GoTrueClient.setSession` calls `_getUser(access_token)` — a `GET /auth/v1/user` — each time main's broadcast is adopted, i.e. roughly hourly. Permitted by the guard (it is not a refresh grant), harmless, but it is new traffic worth knowing about.
9. **`buildOSSAdapter.ts:42-50` now carries a stale comment**, describing sign-out as flowing through `onAuthStateChange → paywallSetSession(null)`. It now goes through `paywallSignOut`. The function is a no-op so nothing breaks; the file is outside this pack and was not touched.
10. **`engine:peek-status` can still read a briefly-stale token.** `main-extensions.ts:140` calls `fetchSubscription(token)` with `getPaywallAccessToken()` and does **not** call `ensureFreshToken()` first. During the short cold-start window between the renderer handing main the keychain credential and main's first refresh completing, that fetch 401s, `sub` is `null`, and `localReason()` reports `no_subscription`. Note what this is *not*: it is not `not_signed_in`, because `signedIn` is derived from `getPaywallUser()` — main's cached user — which this pack now only ever clears on a real sign-out. So the specific downgrade the pack exists to kill cannot fire here. This window is pre-existing in shape (the base had the same exposure whenever the token was stale) and the file is outside this pack. **A one-line `await ensureFreshToken()` in `routerState` would close it** — worth doing by whoever owns `main-extensions.ts`.
11. **⚠️ THE ONE TO CLOSE BEFORE LAUNCH — a rotated refresh token is persisted only if a live
    renderer receives the broadcast.** Found by the round-four verifier (F-2 in §5.6);
    **escalated rather than fixed, because the fix needs `electron/auth-ipc.ts`, which this
    pack does not own.**

    Main holds `currentSession` **in memory only** — it never writes the token store. The only
    writer is supabase-js, through `KEYCHAIN_STORAGE` → `paywall:keychain-set`. So every
    rotation main performs reaches disk only via
    `paywall:token-refreshed` → `AuthContext` → `setSession` → the storage adapter. Two ways
    that chain breaks and leaves an **already-rotated, dead** refresh token in the keychain:

    1. **No renderer receives it.** `BrowserWindow.getAllWindows()` reaches live webContents
       only. If the main app window is *destroyed* rather than hidden while the app keeps
       running in the notch — which is exactly SPEC §4's "close or hide the main window" —
       main rotates hourly and nothing persists any of it.
    2. **`setSession` fails.** It issues a network `GET /auth/v1/user` before `_saveSession`
       and saves nothing on error; `AuthContext` only warns. (This one largely self-heals —
       main's next broadcast carries the newest pair — so (1) is the real exposure.)

    Then the next cold start hands main a dead token, the refresh 400s, and — now that F-1 is
    fixed and the stored access token is also long expired — that is a correct, decisive
    sign-out. The user is signed out after a night, permanently, with a good session having
    existed the whole time. **This is a regression against the base**, where the renderer both
    refreshed and persisted in one process, so a destroyed window meant nothing rotated at all
    and the stored credential stayed usable.

    Which window lifecycle the engine actually uses is decided in `windowManager` inside the
    OSS engine, which is not present in this worktree, so **reachability could not be
    determined here.** Two ways to settle it, cheapest first:
    - *Test:* sign in → **close** (not merely hide) the main window → leave the app running
      past one full token lifetime → quit → relaunch → dictate. Signed out ⇒ confirmed.
    - *Read:* whether the engine's main window `close` handler calls `event.preventDefault()`
      + `hide()`, or lets the window be destroyed.

    **The fix, if it is reachable** — main persists what it mints, rather than delegating:
    - `electron/auth-ipc.ts` (**not owned by this pack**): export the existing `keychainGet` /
      `keychainSet` helpers. No behaviour change, no new storage, no `safeStorage` change —
      they are already the token store's accessors, just module-private.
    - `electron/paywall-glue.ts` (owned): after a successful refresh, **read-modify-write** the
      stored session — parse the existing JSON, patch `access_token` / `refresh_token` /
      `expires_at` / `expires_in`, write it back. It must be read-modify-write, not a fresh
      object: supabase-js validates what it loads (`_isValidSession`) and calls
      `_removeSession()` on a session it considers malformed, so writing a partial session
      would delete the credential outright. The broadcast to renderers stays exactly as it is;
      this only removes the renderer from the *durability* path, not the sync path.
12. **A persisted `remoteTriggerEntitled: true` can survive into a signed-out launch.**
    Pre-existing, not introduced here, and left alone deliberately (see §5.7). If the setting is
    `true` on disk and the user launches with an empty keychain, nothing in the bootstrap path
    re-evaluates it — the Remote trigger reads as entitled until the next sign-in or sign-out
    runs `clearSessionState()`. The fix belongs with whoever owns the Remote entitlement wiring,
    not with an auth pack: `refreshRemoteTriggerEntitlement()` (or an explicit lock) at startup
    when no session is restored.
13. **The backgrounded `signOut()` in `tearDownSession` is not cancelled.** By design (§5.5) — a slow-but-successful server-side revoke should still land. The theoretical cost: if a *healthy* `signOut({scope:'global'})` took longer than the 1500 ms budget and the user signed back in during that window, its late `_removeSession()` would clear the freshly-written keychain entry and emit `SIGNED_OUT`. That event is then ignored (main holds the new user, §3.7) and main's next broadcast repopulates the keychain via `setSession`, so it self-heals — but it needs a real sign-in inside a sub-two-second window to occur at all, and re-signing in requires a browser round trip. Recorded rather than defended against.

14. **Flapping can defeat the `undecidedRejections` bound.** The counter means *consecutive*
    rejections and is zeroed by the transient branch, the non-GoTrue-body branch and the offline
    catch. A session with `expiresAt == null`, a genuinely revoked refresh token, and a
    *flapping* condition — alternating GoTrue 400 and offline throw — never reaches 3 and stays
    signed in indefinitely with a dead credential. Each reset is individually right; the
    interaction is not. Needs `expiresAt == null`, which Supabase never produces (it always
    sends `expires_in`). A time-based bound rather than a count would close it.
15. **Clock skew defeats the "access token still valid" protection.** That branch compares a
    server-supplied `expiresAt` to local `Date.now()`. A Mac whose clock is more than a token
    lifetime *behind* keeps the comparison true forever, so a revoked token is held indefinitely:
    every managed call 401s, the user sits on the local model, and no sign-out ever fires. It is
    the one input to the decisive branch that is not server-controlled.
16. **A routine refresh closes an open sign-in modal.** Every main-driven `setSession` emits
    `SIGNED_IN`, and `AuthContext` reacts by clearing the auth flow state and calling
    `setShowSignIn(false)`. So a ~55-minute token refresh will dismiss a SignInScreen the user
    has open. Cosmetic, pre-existing in shape, but now on a predictable schedule rather than
    never (main did not refresh proactively before this pack).
17. **The bootstrap effect leaks its IPC listeners.** Its cleanup unsubscribes the supabase
    listener but not `paywallOnTokenRefreshed` / `paywallOnAuthCallback` / `paywallOnShowSignIn` —
    `ipcRenderer.on` with no `removeListener`, and the preload exposes no unsubscribe. Under
    StrictMode's double-mount that doubles the `setSession` calls per broadcast. Pre-existing and
    idempotent, but the consequence grew: that callback can now tear a session down. Closing it
    properly needs an unsubscribe in `preload-extensions.ts`, which this pack does not own.
---

## 7. Re-derivation after the session was interrupted

The pack was implemented across several passes and the last one was cut off by an API session
limit, leaving an unverified WIP commit. The empirical scripts §2 refers to lived in that
session's scratchpad and did not survive it. **A claim whose evidence no longer exists is not
evidence**, so every library-level assertion this design rests on was re-derived from the
installed source (`desktop/node_modules/@supabase/auth-js` 2.108.2, `@supabase/supabase-js`
2.108.2) by a second agent that did not write the code. All of them held. Line references are
to `dist/main/GoTrueClient.js` unless stated.

| Claim the design depends on | Where it is true | Verdict |
|---|---|---|
| `global.fetch` reaches the auth client, so the guard covers it | `supabase-js/dist/index.cjs:1255` → `_initSupabaseAuthClient(…, settings.global.fetch)` → `fetch: fetch$1` | confirmed |
| That fetch is the **only** network path — no second route | `GoTrueClient.js:175` `this.fetch = resolveFetch(settings.fetch)`; 43 uses, and no bare `fetch(` anywhere in the package | confirmed |
| The refresh grant goes through it | `:3910` `_request(this.fetch, 'POST', \`${this.url}/token?grant_type=refresh_token\`)` | confirmed |
| `autoRefreshToken: false` is **not** sufficient | `:2458-2486` — `__loadSession` computes `hasExpired` against `EXPIRY_MARGIN_MS` and calls `_callRefreshToken` with **no `autoRefreshToken` check**. Only `_recoverAndRefresh` (`:4004`) gates on the flag. This is §2.2's central finding and it is real. | confirmed |
| A *thrown* fetch is retryable, so the session survives | `lib/fetch.js:124` wraps a fetch rejection in `AuthRetryableFetchError`; `:4157` `if (!isAuthRetryableFetchError(error))` gates the `_removeSession()` | confirmed |
| A blocked refresh costs ~25 s | `:3905-3920` `retryable()` sleeps `200·2^(n-1)` while `now + next − startedAt < AUTO_REFRESH_TICK_DURATION_MS` (30 s) → 200+400+…+12800 = **25 400 ms**, matching the 25 435 ms measured in §5.5 | confirmed |
| `_recoverAndRefresh` does **not** delete an expired session when the flag is off | `:4003-4021` — with `autoRefreshToken:false` the `expiresWithMargin` branch does nothing at all; `_removeSession()` is reached only for a *malformed* session (`:3994`) | confirmed — and this is the one that would have been fatal |
| The keychain value is a flat `JSON.stringify(session)` that `readStoredSession` can parse | `:4260-4266` — `userStorage` unset, so `setItemAsync(storage, storageKey, clonedSession)` with `access_token` / `refresh_token` / `expires_at` / `user` at the top level | confirmed |
| `client.storageKey` is readable, so `sessionStorageKey()` cannot drift | `supabase-js/dist/index.cjs:1252` sets it as a public own property; the fallback matches its own `sb-${hostname.split('.')[0]}-auth-token` derivation at `:1242` | confirmed |
| The guard does not break **sign-in** | the only grant types auth-js uses are `password`, `web3`, `pkce`, `id_token`, `refresh_token` (`:888, 900, 1379, 1518, 1552, 1666, 3808, 3910`). `exchangeCodeForSession` uses `pkce`. Only `refresh_token` is refused. | confirmed |
| `setSession` with a fresh token does not stall | `:2939` awaits `initializePromise` (a no-op refresh-wise when the flag is off), then `:2963` refreshes **only if the JWT has already expired** — main broadcasts fresh tokens | confirmed |

Two further structural facts, checked in this repo rather than the library, that VERIFY §33
turns on:

- **There is exactly one supabase client in the whole product.** `grep -rn createClient` over
  `desktop/**` (excluding `node_modules`) returns one construction site, `supabase-client.ts:109`.
  The OSS engine does not have one of its own: `build/wire-into-engine.sh:193` *adds*
  `@supabase/supabase-js` to the engine's `package.json` during the overlay, which it would not
  need to do if the engine already depended on it.
- **There is exactly one caller of the token endpoint.** `grep -rn 'grant_type=refresh_token'`
  over `desktop/**` returns `paywall-glue.ts:206` (the call) plus two comment lines. Nothing in
  the renderer. And the renderer could not reach it even if something tried, per the table above.

### What changed in this pass

The WIP was reviewed against the SPEC as if unseen. Its architecture held up — every
structural claim in §2 and §3 survived re-derivation. What did not hold up was the detail, and
four further verification rounds (§5.6–§5.9) found **eight more defects**, one of them a direct
violation of SPEC §3.2 that would have signed users out on a captive portal.

Corrections in this pass, in order of severity:

1. **A rejection is now decisive only when the access token has also expired** (§5.6). The WIP
   tore the session down on any non-5xx/429 — a spec violation and a regression against base.
2. **Only a real GoTrue error body can end a session** (§5.8). A captive portal's 4xx used to
   destroy the credential, in exactly the scenario (post-sleep) where the protection above
   cannot help.
3. **The commit guard was extended to the destructive path and to the retry timer** (§5.7,
   §5.8), so a verdict on a replaced credential can no longer delete its replacement, and a
   dead credential's retry can no longer clobber a new session's timer.
4. **`expiresAt == null` became its own bounded case** (§5.7) — it had been walking straight
   through the protection in (1).
5. **The retry got exponential backoff and a cap; the timer got an overflow clamp; the
   unknown-lifetime branch stopped rotating once a minute** (§5.7, §5.8).
6. **The refresh request got a 15 s timeout**, because `refreshInFlight` shares one promise
   with the dictation path (§5.9).
7. **`honourSignOut` now runs main's full teardown**, and the refresh-grant guard was hardened
   against trailing slashes, relative URLs and unparseable input (§5.6).
8. **Comment corrections where a claim outran the code** — main's throttle-immunity (§3.8), the
   guard's fail-closed behaviour, and the file header claiming main had its own supabase client
   (§5.6, §5.9).

Everything in §5.1–§5.5 — the regressions the pre-interruption rounds caught — was re-read
against the current code and is present and correct.
