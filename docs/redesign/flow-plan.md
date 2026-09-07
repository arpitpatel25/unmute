# From replica to flow

Where we are, and what turns 85 static specimens into a page where the product
performs itself.

Written 8 September 2026. The replica lives in `replica/` at `0640a60`.

## The reframe

The specimens are not drawings. **Every surface we transcribed is already a
state machine**, because that is what the Swift is:

| Surface | States |
|---|---|
| Pill | 9 `PillPhase` × 3 `PillKind`, plus chips, hints, offline reasons |
| Notch, bar level | 6 `NotchState`, plus pocket-waiting, routing, agent activity, toast |
| Pocket | closed / open, N slots |
| Wall | 4 view modes × workspace selection |
| Stage / task | status, alive, terminal open, composer state |
| Notetaker | idle / discard / completed |

So a "flow" is not animation work. **A flow is a timeline of state transitions
through machines we already have.** That is the whole insight, and it changes
what needs building: not motion, but a *director*.

## The one thing that has to change first

Every renderer currently returns an HTML string and the gallery does
`el.innerHTML = ...`. That destroys and recreates the DOM on every change, so
**nothing can transition** — the CSS durations transcribed from `Theme.swift`
never get a chance to run.

Fix: **mount once, then patch.** The components are already attribute-driven —
`data-phase`, `data-state`, `aria-expanded`, `data-on`, `data-tint` — because
that is how the state machines transcribed. So:

```js
const pill = mountPill(el, initialState);   // builds the DOM once
pill.update({ phase: "processing" });       // sets attributes + text only
```

Do that and the 240ms surface morph, the 90/140ms content offset, the 150ms
hover and the breathing dots all come free, at the exact durations the app
uses. This is a refactor of the render layer, not a rewrite — maybe a day.

**Do this before anything else.** Everything below depends on it.

## The transport: scroll, not timers

Cardboard's lesson, verified in the teardown: nothing is on a timer. Sections
are `position: sticky` + `h-screen`, pinned while the page scrolls behind them,
so **scroll progress drives the beat**; everything else is `whileInView` gated
on IntersectionObserver. Jumping the scroll position with JS left their section
blank — proof nothing plays until you actually arrive.

Ours:

```
<section class="act" style="height: 500vh">     ← the scroller
  <div class="act-stage">                        ← sticky, 100vh
     … the mounted surfaces …
  </div>
</section>
```

`scrollProgress = (scrollY - top) / (height - vh)` → beat index → `update()`.

**This is a reversal of the current redesign's stance**, which chose
user-triggered motion on purpose. That decision is now overridden — noting it
so nobody rediscovers it as a bug later.

## The director

One small module. Not a library.

- **Beat**: `{ at: 0.0–1.0, surfaces: { pill: {...}, notch: {...} }, caption?: string }`
- **Act**: an ordered list of beats plus the surfaces it mounts
- **Director**: binds an act to a scroller, resolves progress → beat, diffs
  against the last applied beat, calls `update()` on what changed
- **Reduced motion**: skip the pinning entirely and render each act's *final*
  beat, statically, in normal document flow. Designed in from the start, not
  bolted on — this is the one thing Cardboard does that is worth copying
  wholesale (33 references in their bundle).

Diffing matters: without it, every scroll frame re-applies every attribute and
the browser does needless work. Only push what changed.

## The waveform needs a real signal

The gallery drives the dots with a synthetic envelope. For a scripted
performance that is wrong — the shape should match the sentence the visitor is
watching appear.

Three options, and the third is the answer:

1. **Synthetic** — safe, deterministic, but the shape means nothing.
2. **Live mic** — powerful, but needs permission on a marketing page, and the
   inherited STT endpoint still returns 401 unauthenticated.
3. **A recorded envelope, baked in.** Say the line once, run it through
   `LevelMeter.target()`, store ~200 floats, replay in sync with the caption.
   Deterministic, matches the words, costs about 1KB, needs no permission.

Take (3). It is also what makes the demo honest: the waveform is a real
recording of that sentence, not a wobble.

## The acts

The hero should be **one continuous story**, not a feature list. The rest are
set-pieces further down, each gated on `whileInView`.

**Hero — "you speak, it lands, it comes back to you"** (~400vh)

1. Cursor in a document. Fn held. Pill appears: waveform, nothing else.
2. Words land at the cursor as the envelope runs. Pill → `output`, green tick.
3. Right ⌥. Pill goes Remote — glyph, agent chip. The same voice, a different lane.
4. Pill vanishes. Notch: `routing`, "Sending".
5. Notch: `active`, "Working", the activity line.
6. Time passes. Notch goes amber: "Needs you", the question in the right half.
7. Click. The panel expands — task surface, the question, the answer.

That is the product's whole thesis in seven beats, and every one of them is a
state we already render.

**Set-pieces below the fold**

- The formatter (Caps Lock) — same pill, indigo, selected text rewritten
- The pocket — several waiting, the slot rail, swipe
- The Orchestrator — the wall, tabs, one card focused
- Meetings — the notetaker pill, recording → saved
- The scratchpad — armed chip, the pad beside the cluster
- The four keys — Fn, Caps Lock, right ⌥, left ⌃ twice

## What we do NOT need

Cardboard ships **2.2 MB of uncompressed JS across 33 chunks plus 480 KB of
CSS**, and 62 videos. They get away with it by deferring everything.

The whole replica is currently **170 KB of JS and CSS, uncompressed, and three
PNGs.** No video, no WebGL, no animation library, no remote fonts. The director
adds maybe 8 KB. That is not a rounding error in our favour — it is the
argument: a page about removing friction should not take 3 MB to say so.

## Build order

1. **Render layer: mount-once + patch.** Nothing else works until this lands.
2. **Director + reduced-motion fallback.** ~200 lines.
3. **Record the envelope and caption timings** for the hero's two spoken lines.
4. **Hero, end to end, as a vertical slice.** Ship nothing else until it feels
   right at 60fps on a MacBook and degrades sanely on a phone.
5. Set-pieces, one at a time, each `whileInView`.
6. Page copy and layout around them.
7. Delete `product-demo.js` and the 35 Playwright tests that assert its
   click-driven model.

## Open decisions

- **Mobile.** A 400vh pinned hero on a phone is a long thumb-scroll for one
  idea. Cardboard degrades rather than reproducing. Options: shorten the act,
  or autoplay-on-view instead of scroll-scrub. Needs a call.
- **Any live mic at all?** I would say no on the landing page and keep the
  guided version on `try.html`.
- **The `main` divergence** is still unresolved — 9 commits on `main` the branch
  has never seen, including the hero copy. Cheaper to settle before rebuilding
  the hero than after.
