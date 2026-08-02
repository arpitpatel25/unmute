# Pack E — verification

**You did not write this code.** Disprove that it is finished. PASS / FAIL / ESCALATE with evidence. Do not fix anything.

This pack fixes a timing bug. **Reading the diff cannot prove it works** — the reproduction in section F is the only real evidence, and it must not be skipped or simulated.

---

## A. Ownership inverted

1. `[auto]` The renderer no longer auto-refreshes.
   `grep -n "autoRefreshToken" desktop/src/paywall/supabase-client.ts` → **`false`**
2. `[auto]` Main proactively refreshes again — `scheduleAutoRefresh()` is no longer a no-op.
   `grep -n -A 12 "function scheduleAutoRefresh" desktop/electron/paywall-glue.ts` → must set a timer
3. `[auto]` The timer fires **before** expiry, not on it — find the margin.
4. `[auto]` The comment at the old no-op site has been rewritten and now explains the new arrangement and why main owns it.
   The strings "intentionally no-op" and "supabase-js (renderer) is the sole proactive refresher" must **not** survive.
5. `[auto]` **`backgroundThrottling` was not used as the fix.**
   `grep -rn "backgroundThrottling" desktop/` → if it appears in this diff, that is a **FAIL** (§3.1 forbids it).
6. `[auto]` Exactly one process calls the token endpoint. `grep -rn "grant_type=refresh_token" desktop/` → all matches in main, none in the renderer.
7. `[auto]` The dedupe (`refreshInFlight`) survives.
8. `[auto]` The reactive 401 path survives.
9. `[auto]` `paywall:token-refreshed` is still broadcast, and `AuthContext` still adopts it via `setSession`.

## B. Expired ≠ signed out

10. `[auto]` Auth state derivation distinguishes "no refresh token" from "stale access token". Find the branch. If signed-out is still derived from the presence/validity of the access token alone, that is a **FAIL**.
11. `[auto]` `SIGNED_OUT` is not treated as authoritative unconditionally — a transient network failure must not sign the user out.
12. `[eye]` With a deliberately expired access token and a valid refresh token, the UI does **not** show signed out at any point.
13. `[eye]` The dictation path does not announce a downgrade to the local model while a refresh is in flight.
14. `[eye]` A genuinely revoked refresh token **does** sign the user out. The fix must not make sign-out impossible.

## C. Unchanged surface area

15. `[auto]` The keychain storage adapter is unchanged.
    `git diff origin/main...HEAD -- desktop/src/paywall/supabase-client.ts` → `KEYCHAIN_STORAGE` must not appear in the diff
16. `[auto]` `persistSession: true` still set.
17. `[auto]` The OAuth deep-link handler is untouched.
18. `[auto]` `auth-ipc.ts` is untouched — not owned by this pack.
19. `[auto]` `safeStorage` behaviour unchanged.

## D. Boundaries — FAILs

20. `[auto]` `git diff --name-only origin/main...HEAD` contains **only**: `desktop/electron/paywall-glue.ts`, `desktop/src/paywall/AuthContext.tsx`, `desktop/src/paywall/supabase-client.ts`. Anything else is a FAIL.
21. `[auto]` No renderer app screen changed (Packs A/B).
22. `[auto]` Nothing under `backend/` changed.

## E. It builds

23. `[auto]` `cd desktop && npm run typecheck` → exit 0
24. `[auto]` `cd desktop && npm test` → no regression
25. `[auto]` No TODO/FIXME introduced.

## F. Reproduction — the only real proof

**Run on a SIGNED build.** An unsigned local build degrades `safeStorage` to plaintext and produces a different logout symptom; testing on one proves nothing about this bug.

26. `[eye]` **Before state confirmed.** On `origin/main`: sign in, hide the main window, wait past the access-token lifetime, dictate. It must fall back to local and report signed out. **If this does not reproduce, STOP** — the diagnosis is wrong and everything built on it is suspect. Report this as ESCALATE, not FAIL.
27. `[eye]` **After state.** Same steps on this branch: cloud transcription, no interruption, no signed-out message.
28. `[eye]` Extended: leave the app untouched with the window hidden for over an hour, then dictate. Still cloud.
29. `[eye]` Sleep the Mac, wake it, dictate. Still signed in.
30. `[eye]` Switching tabs inside the app is no longer what "fixes" the session — because nothing needed fixing.
31. `[eye]` Sign out explicitly: it still works, immediately and completely.
32. `[eye]` Sign back in: works, and the session survives the window being hidden.

## G. The regression this fix most plausibly reintroduces

33. `[eye]` **The original race.** The comment being replaced documents a real outage: two refreshers, token rotation, the loser rejected, `SIGNED_OUT` fired. Confirm by inspection that main and renderer can never both call the token endpoint — not "usually do not", *cannot*. This is the single highest-risk aspect of this change.
34. `[eye]` Run the app with the main window **open** and visible for an hour. If the renderer's auto-refresh was not truly disabled, this is where the race resurfaces.
35. `[eye]` Two windows / two renderers, if the app can produce them: still only one refresher.
36. `[eye]` Token refresh while a dictation is mid-flight does not corrupt or cancel it.
37. `[auto]` `ensureFreshToken()` is still called on the paths that called it before — it is the pre-emptive check that keeps a managed call off a stale token.
