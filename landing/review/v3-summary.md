# Unmute landing v3 — decisions and review

Branch: `feat/unmute-landing-v3`  
Workspace: `/Users/zodpatel/tools/unmute/unmute-landing-redesign`  
Preview: http://127.0.0.1:4194/landing/

## What Unmute is

A way to start, continue and reach Claude Code or Codex sessions by voice from any app on a Mac. The notch keeps sessions within reach. Context can travel with the spoken instruction. When a session needs attention, the notch opens where the user is.

The winning distinction is the combined workflow: a thought arises in another app → speak and capture relevant material → start or resume a session → continue the current activity → the task comes back when it needs attention. Treat this as established product value, not an unproven possibility.

## Why it exists

Opening an agent app, finding a conversation, gathering context and reconstructing a thought introduce friction. Lowering that effort makes it easier to reach out more often and express the thought more fully. The ambition is to make delegating as easy as thinking out loud.

Lead with concrete capabilities. Put the philosophy in the why section and close, rather than spreading abstract language through every feature.

## Hero — latest revision

“Put your agents to work. From anywhere.” is the shorter version of the earlier direct positioning. The rotating “Just unmute for …” headline has been removed. Static supporting copy explains Claude Code/Codex sessions and voice access from any Mac app.

The hero demonstration has eight examples, at approximately 6–7 seconds each (about three times slower than the previous version). Pause and next-example controls remain available. A caption explains each example, and stale result labels are cleared when the example changes.

All demonstrations keep a fixed 1440×900 full-screen view on desktop and phones. The camera no longer pans or zooms into interactive elements. Product colors remain intact. App windows crossfade smoothly and speech bubbles use gentler motion.

## Page story

Hero → why asking should be effortless → start/continue sessions → capture context → Unmute Agent retrieves past work → attention returns to the user → meeting notes → dictation → existing accounts → close.

Use “agent session” for what is started or resumed. A task is the work within a session. Keep the attention headline “The task comes to you. You don't go to the task.” Explain that the notch opens wherever the user is. Retain “A shorter distance between thinking and doing.” at the close.

## Design direction

Return to the original centered hero and large colorful product demos. This version uses one upright DM Sans variable family, with consistent weights and a smaller type scale. No italics. A quiet white page (#fbfcfa), dark text (#171b19), secondary text (#626964), pale separators (#dde3dc), and a restrained green accent (#176b54). Product wallpapers, app accents and provider icons retain their original colors; there is no grayscale filter.

The full Mac screen is scaled proportionally rather than cropped on any viewport. The attention section retains its centered demonstration on a pale green surface; remaining sections alternate copy and real UI captures.

T3 Code’s rendered desktop typography was inspected on 2026-10-03: DM Sans, 76px headline, 500 weight, 1.05 line height and -0.035em tracking; supporting copy is 19px with 1.55 line height. The current hero uses those values at a 1440px viewport and scales down on phones. The wordmark is now 40px high on desktop and 32px on phones.

## References and what was taken from them

- [T3 Code](https://t3.codes/): centered headline, compact supporting explanation, clear provider context and a large product demonstration. Its dark palette and control-plane category were not adopted.
- [Conductor](https://www.conductor.build/): a direct promise followed by product proof.
- [Raycast](https://www.raycast.com/): a short memorable brand phrase backed by concrete explanatory copy.
- [DM Sans](https://fonts.google.com/specimen/DM+Sans): one font family for a coherent type hierarchy. Self-hosted official Google Fonts file and OFL license.

## Scope and preservation

This is a new local branch. Existing capture assets, scene content, session terminology, pause controls, context capture and attention behavior are retained. The previous index/CSS/app files were copied to `/tmp/unmute-landing-before-v3/` before this revision. Earlier unrelated repository changes are left in place.

The new stylesheet is `landing/v3.css`. The deployment helper has been updated to include it and the self-hosted fonts, but it has not been run. Nothing is pushed, merged or deployed.

## Verification

- JavaScript syntax checks for app.js and ui/stage.js.
- Shell syntax check for the deployment helper, without executing it.
- Local HTML references, font references and all manifest captures checked.
- Browser checks at desktop, 390px and 320px; the static heading fits without horizontal overflow, and demos retain the full-screen aspect ratio.
- Product colors, pause/next controls and automatic attention panel reviewed in the browser.
- Saved desktop, mobile and attention screenshots in landing/review/.

Broad desktop tests and builds skipped: this is a static page revision with a focused demo-framing change, verified directly in the browser.
