---
name: unmute-test-build
description: Use when the user wants to test an unmute feature on their own Mac — asks for a "test build", "dev build", "private build", "install this branch", or to field-test changes in the installed app. Also use when a locally installed build signs the user out, breaks auto-paste/permissions, or auto-updates itself back to production.
---

# Unmute Test Build

Build a **production-identical private build** and install it on the user's Mac. "Dev" means only: a `-dev.N` version, **verbose logging always on** (test builds exist to be observed), and never published. Everything else — signing, notarization, env — is EXACTLY the production pipeline.

**Core law: macOS grants Keychain/Accessibility/mic by code signature.** An unsigned build is a different app: login vanishes, auto-paste silently dies. And `.env.dev` is git-ignored — it does NOT travel to worktrees; a build without it bakes `localhost:54321` auth in.

## Procedure

1. **Version** — must beat BOTH the installed app and the latest published release, and lose to the next real release:
   ```bash
   defaults read /Applications/unmute.app/Contents/Info.plist CFBundleShortVersionString   # installed
   gh release list -R arpitpatel25/unmute --limit 3                                        # published (beware junk 1.4.3-1.4.5 tags)
   ```
   Pick `<next-real-version>-dev.N` (e.g. installed 1.4.6 → `1.4.7-dev.1`). "Next real version" = whatever release is planned next; if unsure, patch-bump the max of installed/published and confirm with the user. Rebuilds during the same test day increment N.
2. **Env** — if building from a worktree: `cp <main-checkout>/desktop/.env.dev <worktree>/desktop/.env.dev` (verify it exists; never commit it).
3. **Verbose field logging (ALWAYS ON for test builds — the whole point is to observe).** A test build is packaged, so `app.isPackaged` is TRUE and the auto-on-for-unpackaged gates DON'T fire — you must flip these ON in the working tree. Both are **working-tree only — NEVER commit them** (they persist user transcripts/session data to disk; production must always ship the OFF value). Revert BOTH after the build.
   - **Dictation transcripts** — set `export const DEV_BUILD = true` in `desktop/engine-overrides/electron/dictationTelemetry.ts` (persists raw STT + LLM-cleanup text + the accept/reject metrics — needed to compare raw-vs-cleanup, judge the noisy-flag, and tune the gate/thresholds/timings).
   - **Skill-curator diagnostics** — in `desktop/electron/remote/curator-devlog.ts`, make `devLogEnabled()` return `true` (e.g. `return true || process.env.UNMUTE_CURATOR_DEVLOG === '1'`) so the curator's engine decisions + reasoning + full UX timeline log in the packaged build.
   Skip a flag only if the user explicitly says they don't want that subsystem's logs this build.
4. **Build (full pipeline — background it; 15-20 min notarization):**
   ```bash
   cd <checkout>/desktop && set -a && source .env.dev && set +a && \
   PYTHON=/usr/bin/python3 PAYWALL_VERSION=<X.Y.Z-dev.N> npm run build
   ```
   Success = `status: Accepted` (notarization) in output. Missing → do NOT install; check the build log tail for the failing step (signing needs the Developer ID in the keychain; notarization needs network + Apple creds in env from `.env.dev`/keychain) and rebuild. The publish step self-aborts without `GH_TOKEN` — that is the desired "never published" behavior; do not export GH_TOKEN.
   The DMG lands in `<checkout>/desktop/work/oss-engine/release/` — `ls` it rather than assuming the filename.
5. **Install:**
   ```bash
   osascript -e 'tell application "unmute" to quit'; sleep 2
   hdiutil attach <checkout>/desktop/work/oss-engine/release/unmute-<ver>-arm64.dmg -nobrowse -mountpoint /tmp/unmute-mnt
   rm -rf /Applications/unmute.app && ditto /tmp/unmute-mnt/unmute.app /Applications/unmute.app
   hdiutil detach /tmp/unmute-mnt
   ```
   (Fixed mountpoint avoids the two-DMGs-same-volume-name trap.)
6. **Verify, then launch:**
   ```bash
   defaults read /Applications/unmute.app/Contents/Info.plist CFBundleShortVersionString   # = your dev version
   codesign -dv /Applications/unmute.app 2>&1 | grep TeamIdentifier                        # = D8ZHT5S2XQ
   open -a /Applications/unmute.app
   ```
   User should be signed in with auto-paste working, no prompts. Tell them where logs land: `~/Library/Application Support/unmute/telemetry/` (dictation) and `~/.unmute/remote/logs/` (Remote/router).

## Red Flags — STOP

| Temptation | Reality |
|---|---|
| "`build:fast` is quicker" | `--no-sign` = different identity = signed out + auto-paste dead. NEVER for installed builds (compile-gate-only use is fine — don't install it). |
| "Skip `.env.dev`, probably fine" | Auth compiles to localhost; sign-in hits a dead server. Verify the file BEFORE building. |
| "Reuse the same version" | Updater/ShipIt caching misbehaves; always bump `-dev.N`. |
| "Commit DEV_BUILD=true / devLogEnabled→true, revert later" | It reaches main and ships transcript/session logging to users. Working-tree only, ALWAYS reverted. |
| "Version below published is fine" | Auto-updater silently replaces the test build on relaunch. |

**Before declaring the install done:** run `git status --short` in the checkout — `dictationTelemetry.ts` OR `curator-devlog.ts` appearing as modified means a logging flip was not reverted. Revert BOTH now (`git checkout -- <file>`); this is the one cleanup step agents skip when tired, and its failure mode (transcript/session logging reaching a release) is silent and delayed. The working tree MUST be clean of these two flips before the task is done.

Exiting the test: any published release ≥ the next real version auto-updates the user back to production.
