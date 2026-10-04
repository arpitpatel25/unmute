# Current review: landing v3

The current page uses `v3.css` and the original full-color demo assets on branch `feat/unmute-landing-v3`. See [the complete decision summary](review/v3-summary.md) for the messaging, references, scope and verification. Local preview: http://127.0.0.1:4194/landing/ . Nothing has been deployed.

The notes below include prior iterations; the v3 summary describes the current review version.

# landing/ — the redesigned page, built from the app's real UI

Open `http://localhost:4191/landing/` with `python3 -m http.server 4191` running from the repo root.

## What is real, and how

Every notch and pill surface on the page is a **capture of the real `unmute-notch` helper**, built from `unmute-cloud` at commit `db2a2016` and driven with the same JSON commands Electron sends (`IPC.swift`). Nothing in those surfaces is redrawn by hand.

| Piece | Source of truth |
|---|---|
| Pill states (fn, Right ⌥, Agent lane, flash, paused) | `PillView.swift` / `PillModel.swift`, captured |
| Bar states (Working N, Sending, Needs you, Listening/Searching/Thinking/Done, In pocket) | `BarContent.swift`, captured |
| Pocket card (slots, aimed mic chip, sent) | `PocketView.swift`, captured |
| Scratchpad (rows, "Add to auth service", Discard) | `ScratchpadView.swift` / `ScratchpadModel.swift`, captured |
| Expanded session and Unmute Agent panels, at 45% | `TaskSurfaceView` / `BlockConversation`, captured |
| Waveform motion | `LevelMeter.swift` + `DotWave.swift`, ported line for line in `ui/stage.js` |
| Notetaker pill | `NotetakerWidget.tsx` (already HTML), ported as-is |
| "un", Claude and Codex marks | base64 blobs in `UnMarkArt.swift` / `ProviderMarkArt.swift`, byte-identical |
| Crossfade timings | `Theme.swift`: content out 90ms ease-in, in 140ms ease-out after 80ms |

Settings the captures use are the app's own: `appearance: 'solid'` and `surfaceTone: 'glass'` (`surface-preferences.ts`), and `surfaceFill` 0.45, the smallest-but-one setting, so the panel clearly reads as the notch rather than a full app.

## Deliberate choices, not facts about the app

- **Screen geometry:** a 14" MacBook Pro notch (200×34pt, as the helper's own `UNMUTE_FAKE_NOTCH` notes). The capture build is a `/tmp` copy with one harness-only patch: the bar height takes the fake notch height, as it does on a real notched Mac. The product source is untouched.
- **Wallpaper** (`ui/wallpaper.css`) is ours. The glass panels were captured over exactly this wallpaper (`tools/backdrop.swift`), and the page shows them over the same pixels.
- **App windows** on the stage are plain stand-ins for the user's own apps. “You say → what it did” speech bubbles and result labels are clearly annotations over the real captures; they are not product UI.
- **Camera:** the stage keeps true proportions and zooms to the active surface, following the production bible's "punch in on the active area".
- **Content** (task titles, the Agent's replies, meeting action items) is example text. The UI rendering it is real.

## Regenerating

```sh
# build the helper once (see tools/native-capture.mjs for the /tmp patch)
node landing/tools/scenes.mjs                       # write fixtures
node landing/tools/native-capture.mjs landing/tools/fixtures/scene-core.json landing/captures/scene-core   # etc. for each scene
node landing/tools/finish-assets.mjs scene-core scene-pocket scene-scratch scene-session scene-agent scene-fixups
```

This takes over the screen for about a minute: a full-screen wallpaper window plus the helper. `captures/` holds the raw material and isn't needed by the page.

## Messaging v2 review

Continued from the interrupted “Unmute landing page audit” session on branch `feat/interactive-experience`.

- Normal scrolling, with motion confined to the demo frames. No pinned sections or delayed copy reveal.
- The hero starts with “everything” and rotates through nine examples in sync with their product demos. Its reserved height keeps the page from jumping.
- Philosophy is limited to why Unmute exists and the closing. The feature sections consistently name agent sessions.
- The attention section shows the notch opening on its own, receiving a spoken answer, and returning to work.
- One Pause/Play control covers every demo, stays paused across scrolling, and honors reduced motion on load. Next example works while paused.
- The separate four-key section, counter, Everywhere chapter, and 3D layer graphic are removed. Keys remain visible in speech bubbles.

Preview: `http://127.0.0.1:4194/landing/` (server started from the repository root).

No deployment or push has been performed. The production main checkout is untouched. The deployment script is a separate manual step and must not be run before review.

### Verification for this continuation

- JavaScript syntax checks for `app.js` and `ui/stage.js`; shell syntax check for the deployment helper.
- Static checks for page references, all 81 capture files, and scene-to-manifest mappings.
- Browser review at desktop width, 390px, and 320px; checked all nine hero examples at 390px for stable height and overflow, pause/manual-next controls, and the attention section opening its real panel.
- Fixed the 320px footer overflow, mismatched desktop column widths, paused playback on viewport re-entry, and deep-link positioning after stage layout.
- Removed the scroll-animation dependency; native viewport observers now start and stop the looping demos. No scroll pinning remains.
- No browser console errors observed. Existing broad site and desktop test suites were not run; no production checkout was changed.
- Review captures are in `landing/review/`.

## Typography, palette, and pacing refinement

Replaced the purple page accent with neutral black/white/gray. The entire demo camera, including its wallpaper and captured surfaces, is presented in grayscale so the glass captures retain matching backdrops. The source capture files are unchanged.

The headline emphasizes **unmute** in bold sans serif, with *Just* and *for [example]* in italic serif. Rotating noun phrases form complete sentences: everything; your next Claude Code session; your next Codex session; that bug you need to fix; the email you need to write; your next follow-up; that session from last week; your meeting notes; your next message.

The hero timeline runs at 2.4× its original speed (about two seconds per example), and speech text reveals are accelerated to match. Desktop and phone layout checks cover the full phrase cycle; syntax checks remain focused on the affected scripts.
