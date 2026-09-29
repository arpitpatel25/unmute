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
- **App windows** on the stage are plain stand-ins for the user's own apps. The spoken words appear as a subtitle **under** the screen, never inside it.
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
