# Landing demos — what each one shows (2026-10-04)

## Why the old demos didn't work

- **Too small to read.** Each demo showed the whole 1440×900 Mac screen, scaled down. In a 640px section the pill was about 10px tall and the notch about 9px, so the product itself was too small to read.
- **No reason to speak.** Requests didn't match what was on screen. For example, "build the onboarding flow" was spoken over a pricing doc, so the visitor couldn't follow the thought.
- **Too many ideas.** The hero rotated through eight unrelated examples, about 6 seconds each, so the core loop never came across.
- **Nothing came back.** Most beats ended on a small "✓ started" label. The payoff, that the work comes back to you, was only shown far down the page.

## The grammar (every demo)

1. **Wide shot:** which app you're in, and what on screen prompts the request (a highlighted Slack message, a broken Save button, a missing line in a brief).
2. **Push in** on whatever is acting: the pill while you speak, then the notch or panel. The camera eases between shots, and small stages push in further so the real UI stays readable.
3. **Subtitle under the screen,** never covering the product. It shows the key you hold, then your words appearing in time, then ✓ and what happened.
4. **The words you speak are the words in the capture.** The panel shows the same sentence as the subtitle, which proves the voice-to-session link without any annotation.

## Hero: one loop, three chapters (≈26s)

The chapter buttons above the screen show the current chapter, fill as it plays, and jump on click.

| # | Chapter | What's on screen |
|---|---|---|
| 1 | Say it, from any app | In Slack, Priya asks for the onboarding flow by Friday. Hold right ⌥ → pill → "build a first version of the new onboarding flow" → the notch opens a new Claude Code session with that exact sentence. |
| 2 | It runs in Claude Code | The notch shows "Working 1". You switch to Figma (the onboarding designs). |
| 3 | It comes back when it needs you | The notch opens by itself: "Should I keep the optional team setup step, or move it later?" Hold right ⌥ → "move it after the first project" → the agent carries on. You never left Figma. |

## Sections: one idea each

| Section | Prompt on screen | Said | Payoff (real capture) |
|---|---|---|---|
| Why | Brief: "Still needed: a landing page" | build a landing page for the pricing launch | Pricing landing page session, working |
| Start / continue | Figma, 3 sessions running | (fn, aimed at the pocket) make the signup step shorter | Pocket: sent to Onboarding flow, nothing opened |
| Capture | Save button does nothing (error text) | fix this, the save button does nothing + left ⌘ drag | Screenshot flash in the pill → working |
| Unmute Agent | Priya: "where did we land on onboarding?" | pick up the onboarding work from yesterday… | Agent finds the session and the meeting notes → back in the notch |
| Attention | Figma, Claude working | move it after the first project | Panel opens by itself → answered |
| Meetings | Meet call, notetaker pill | take the decisions from that call into the onboarding session | Decisions added to Onboarding flow |
| Dictation | Mail reply to Priya | Thanks Priya, Thursday works… | Text typed at the cursor |

## Known gaps

- Every expanded panel capture has the helper's "Jump to latest" chip baked in, because the captures were taken while scrolled up. `ui/stage.js` paints it out at runtime and leaves the source PNGs untouched. A clean re-capture would remove the need for this.
- The hero and the attention section share chapter 3's beat. If that feels repetitive, the attention section could switch to a different question (this needs a new capture).
- The capture section's real UI only shows a flash for the screenshot. A capture of the panel with the attached image would make the payoff stronger.

## Files

`landing/ui/film.js` (engine: one GSAP timeline per demo, named camera shots), `landing/app.js` (all storyboards above), `landing/film.css` (chapters, subtitles, app stand-ins). `landing/tools/film-frames.mjs` saves frames at chosen times, and `landing/tools/verify-films.mjs` checks the loop, chapters, pause and reduced motion.

## Notch and pill motion

Surfaces no longer pop in. When the notch changes size (bar → panel, bar → pocket, panel → bar, nothing → bar), a solid shape eases from the old outline to the new one: a soft spring when growing, a firm ease when shrinking. The old content fades out first, and the new capture fades in as the shape settles. The pill grows out of a dot into its capsule the same way. Swaps with the same outline, where only the panel's text changes, keep the app's own quick crossfade (Theme.swift). Code: `Stage.set` / `Stage.morph` in `landing/ui/stage.js`. Run `landing/tools/morph-frames.mjs` to film any transition frame by frame.
