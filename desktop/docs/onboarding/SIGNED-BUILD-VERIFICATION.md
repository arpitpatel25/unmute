# Signed Build Onboarding Verification

Use a signed and notarized build. Test with a clean macOS account and with an account that has previously granted each TCC permission. Keep Claude Code and Codex combinations separate: neither installed, Claude only, Codex only, both ready, installed but signed out.

## Acceptance matrix

| Matrix | Values |
|---|---|
| Display | notched MacBook; external notchless display |
| Appearance | light wallpaper; dark wallpaper; high-detail/color wallpaper |
| Permissions | clean; denied; granted; grant requiring relaunch; revoked after checkpoint |
| Providers | neither; Claude; Codex; both; auth-required; timeout |
| Network | online; offline before grant; interrupted during transcription |
| Resume | quit at every chapter; force quit during System Settings; macOS restart |
| Capture | clipboard text; macOS screenshot; duplicate detector signal; Desktop-folder denial |
| Auth | signed out; OAuth success; magic link; cancelled; existing session |

## Procedure

1. Remove only the test account’s Unmute app data and TCC entries. Install the notarized DMG and launch from `/Applications`.
2. Confirm the presenter is compact, translucent, background-adaptive, clear of the physical notch, and never replaces the real app with a fake product page.
3. Complete every permission individually. At a relaunch prompt, quit/relaunch and confirm the exact chapter resumes.
4. Set “Press 🌐 key to” to “Do Nothing.” Confirm the readiness test consumes one Function tap without starting Dictation and cannot advance without the real key event.
5. Confirm provider detection launches an isolated ephemeral readiness check, terminates it, and reports missing versus authentication-required accurately.
6. Complete Dictation in Apple Notes with Function start and Function submit. Confirm a missing or out-of-order tap, transcription alone, or delivery into another app cannot advance.
7. Copy text and take a normal screenshot between Function start and Function submit. Confirm only a composition containing the observed item advances.
8. Start an Unmute task with Right Option start and submit. Confirm the task runs only in `userData/onboarding/workspace` and `hello-unmute.txt` contains exactly `My first Unmute task`.
9. Complete the Agent follow-up with its real start and submit sequence, then open its matching native task link. Plain text resembling a link must not advance.
10. Start Notetaker with the real Left Control gesture and save from the real pill. Discard must not advance; summary generation may remain honestly processing.
11. Continue through the Agent-notes explanation, inspect Tasks and Notetaker in the real Electron app, sign in, and confirm the presenter closes only after authenticated state arrives.
12. Use Settings → Replay onboarding. Confirm the durable main-process progress resets and no duplicate Cloudflare grant is required after a relaunch.

Record app logs, macOS version, display arrangement, build version, Cloudflare worker version, and pass/fail for every matrix cell. A release fails if any step can advance from a timer, prose, a mocked surface, or an unrelated event.
