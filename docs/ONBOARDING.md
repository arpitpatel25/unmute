# Onboarding — getting unmute-cloud running on your Mac

Everything you need to go from a fresh clone to running tests, a dev build, and
(if you have signing access) an installable one.

**Read [`UNMUTE_PROJECT_OVERVIEW.md`](../UNMUTE_PROJECT_OVERVIEW.md) first** for
*what* this is. This page is only *how*.

---

## What you need

| | Needed for | Where it comes from |
|---|---|---|
| **Repo access** | everything | GitHub |
| **Xcode Command Line Tools** | native addons + the Swift notch shell | `xcode-select --install` |
| **Node 20+** | everything | your own |
| **`desktop/.env.dev`** | **any build at all** | ask Arpit — sent out of band, never in git |
| **`cua-driver` binary** | any build | `desktop/vendor/cua-driver/fetch.sh` — public, no auth |
| **Your own Claude subscription** | running the agent lanes | your own; tasks run on *your* plan by design |
| Apple Developer ID cert + `APPLE_*` | **signed** builds only | Arpit's Apple Developer team |
| `GH_TOKEN` | publishing a release | not needed for development |

## Setup, once

```bash
git clone git@github.com:arpitpatel25/unmute-cloud.git
cd unmute-cloud/desktop

npm install

# The Computer Use binary — 42 MB, MIT, from trycua. Gitignored on purpose.
./vendor/cua-driver/fetch.sh

# Ask Arpit for this file and drop it here. Four values. Gitignored.
#   desktop/.env.dev

npm test          # ~1400 tests, ~2 minutes — needs none of the above
```

If `npm test` passes you have a working checkout. Everything below is optional
depending on what you're working on.

---

## The two traps

Both of these are **gitignored, so they do not travel to a git worktree.** If you
use worktrees — and this repo does, heavily — you will hit them on your first
one. They are not exotic mistakes; they are the normal path.

**1. `desktop/.env.dev`**

The build *refuses to run* without it:

> `desktop/.env.dev not found — refusing to build.`

That guard exists because three dev builds once shipped from a worktree silently
pointing at `localhost:54321` as the auth server. They installed, launched,
looked completely normal, and could not sign anyone in. Nothing said why.

```bash
cp <main-checkout>/desktop/.env.dev <your-worktree>/desktop/.env.dev
```

**2. `desktop/vendor/cua-driver/cua-driver`**

> `ERROR: vendor/cua-driver/cua-driver missing — run desktop/vendor/cua-driver/fetch.sh first`

Either run `fetch.sh` again in the worktree, or copy the binary and `.version`
across. Same fix either way.

---

## Build modes

| Command | What it does | Install it? |
|---|---|---|
| `npm test` | ~1400 tests | — |
| `npm run typecheck` | two tsc projects | — |
| `npm run dev` | pulls the engine, overlays, runs unpackaged | for development, yes |
| `npm run build:fast` | full build, **unsigned** | **NO — see below** |
| `npm run build` | full build, signed + notarized | yes |

### Never install an unsigned build

macOS keys Keychain and Accessibility grants by **code signature**. An unsigned
build is a *different app* to the OS: you will be signed out, auto-paste will be
dead, and permissions will look revoked. Nothing reports the cause.

`build:fast` is a compile gate. Use it to check the build works; do not put it in
`/Applications`.

### A signed build

Needs the Developer ID certificate in your keychain plus three env vars:

```bash
cd desktop
set -a && source .env.dev && set +a
PYTHON=/usr/bin/python3 PAYWALL_VERSION=<X.Y.Z-dev.N> npm run build
```

- `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` must be in the
  environment.
- Success = **`status: Accepted`** twice in the output (the app and the DMG are
  notarized separately).
- The build ends with `GH_TOKEN required to publish`. **That is expected and
  correct** — it means the build did not publish. Do not export `GH_TOKEN`.
- Notarization is a network round trip to Apple and occasionally times out with
  `HTTPClientError.connectTimeout`. Just re-run; nothing is wrong.
- The DMG lands in `desktop/work/oss-engine/release/`.

### Version numbers

A dev build's version must **beat** both the installed app and the latest
published release, and **lose** to the next real release — otherwise the
auto-updater replaces your build on relaunch.

```bash
defaults read /Applications/unmute.app/Contents/Info.plist CFBundleShortVersionString
gh release list -R arpitpatel25/unmute --limit 3
```

Installed `1.4.20` → build `1.4.21-dev.1`. Bump `dev.N` on every rebuild.

---

## Installing a build

```bash
osascript -e 'tell application "unmute" to quit'
hdiutil attach <dmg> -nobrowse -mountpoint /tmp/unmute-mnt
rm -rf /Applications/unmute.app && ditto /tmp/unmute-mnt/unmute.app /Applications/unmute.app
hdiutil detach /tmp/unmute-mnt
```

The fixed mountpoint matters: two DMGs can share a volume name, and without it
you can silently install the wrong one.

Verify:

```bash
defaults read /Applications/unmute.app/Contents/Info.plist CFBundleShortVersionString
codesign -dv /Applications/unmute.app 2>&1 | grep TeamIdentifier   # D8ZHT5S2XQ
spctl -a -vvv -t install /Applications/unmute.app                  # accepted
```

---

## Where the logs are

| What | Path |
|---|---|
| Orchestrator, router, agent lanes | `~/.unmute/remote/logs/remote-*.log` |
| Notch IPC | `~/.unmute/remote/logs/notch.log` |
| Dictation transcripts + main-process console | `~/Library/Application Support/unmute/telemetry/` |
| Task working dirs (status, transcripts) | `~/.unmute/remote/local/<task-id>/` |

**Verbose logging in a packaged build** is off by default and must be switched on
*before* building — see the `unmute-test-build` skill. Two flags, both
working-tree only:

- `DEV_BUILD = true` in `engine-overrides/electron/dictationTelemetry.ts`
- `devLogEnabled()` → `true` in `electron/remote/curator-devlog.ts`

**Revert both after the build.** They persist user transcripts and session data
to disk; production must always ship them off. `git status` should be clean of
those two files before you commit anything.

---

## Known-good baseline

So you can tell your breakage from the existing kind:

- `npm test` — all pass
- `npm run typecheck` — **3 pre-existing errors**, all from July commits:
  `init.ts` (×2, an `InstallResult` index signature and a `Model` property) and
  `notch-controller.ts` (`TurnP` not found). If you see only these, you are clean.

---

## Working in this repo

- **Worktrees are the norm.** Feature branches live in `.claude/worktrees/`.
  Remember the two traps above every time you make one.
- **Build scratch is disposable.** `desktop/work/` is a full clone of the OSS
  engine plus a built app — ~1.5 GB *per checkout*. Delete it freely; the build
  recreates it. Fifty stale copies is how ~18 GB once went missing.
- **There is more than one renderer.** The wall exists in React
  (`engine-overrides/renderer/remote/`) *and* Swift (`native-notch/`), and the
  notch has three surfaces — wall, rail, task stage — with different lifetimes.
  Changing one is not changing the others.
- **Files are the control channel.** The router writes `decision.json`; tasks
  write `status.json`. The terminal stream is display-only.
