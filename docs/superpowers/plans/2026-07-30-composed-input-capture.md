# Composed Input Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copies and screenshots made during a dictation land in the transcript at the position they happened, and a scratchpad lets the user hold what they have built instead of committing it on stop.

**Architecture:** Two independent axes. *Capture* is unmoded and always on: a `changeCount` poll plus an FSEvents watch detect inserts during a hot mic, content is rescued immediately into Unmute-owned storage, and the buffer records position by timestamp. *Retention* is the scratchpad: an armable flag that changes what stopping means. Five pure, dependency-free modules carry the logic and the test coverage; two thin seams (`sessionManager.ts` for capture, `init.ts` for delivery) do the wiring.

**Tech Stack:** TypeScript, Electron main process, `node:test` + `node:assert`, node-gyp/N-API Objective-C++ addon, Swift/SwiftUI (native-notch).

**Spec:** `docs/superpowers/specs/2026-07-30-composed-input-capture-design.md`

## Global Constraints

- **The fast path must not move.** Unarmed: tap, talk, tap, paste. When nothing was copied, output is byte-identical to today. Verify after every wiring task.
- **No heavy main-process work while recording.** It corrupts audio (`ffmpeg: Invalid data`). Detection on the main thread must be an integer read or an event callback — never image decode, never `readdir` in a loop.
- **Capture only while the mic is hot.** Both watchers arm on capture start and disarm on capture stop. Never observe outside a consented window.
- **Never mutate the user's clipboard.** No `clipboard.clear()`. The only Unmute write is delivery's existing `injectOutput`.
- **One reader, one PNG encoder.** Exactly one code path reads pasteboard image data: the `osascript` child. A second reader is the documented cause of duplicated pastes.
- **Test files are only discovered under these globs** (`desktop/package.json`): `electron/remote/**/*.test.ts`, `engine-overrides/electron/**/*.test.ts`, `engine-overrides/renderer/widget/**/*.test.ts`, `engine-overrides/renderer/remote/**/*.test.ts`. New modules go under `electron/remote/capture/` so their tests run.
- **Pure modules import nothing** — no `electron`, no `fs`. Filesystem checks are injected as function parameters. This is the house pattern (`vadPolicy`, `remoteTriggerGate`, `promptTail`).
- **Run the full suite** with `cd desktop && npm test`. Baseline is 805 passing.
- **Commit after every task.**

---

## File Structure

**Create — pure modules (`desktop/electron/remote/capture/`):**

| File | Responsibility |
|---|---|
| `types.ts` | Shared types: `InsertKind`, `Segment`, `Insert`, `Entry`, `Pad`, `Destination` |
| `captureBuffer.ts` | Timeline: add, remove, order. Immutable operations. |
| `insertClassify.ts` | Content → `InsertKind`, by regex only |
| `insertRender.ts` | `Pad` + `Destination` → text + attachments; inline vs fenced; fence escaping |
| `clipboardLedger.ts` | Own-write skip set; cross-detector content dedup |

**Create — platform plumbing:**

| File | Responsibility |
|---|---|
| `capture/clipboardWatch.ts` | `changeCount` poll; child-process content rescue |
| `capture/screenshotWatch.ts` | FSEvents watch on the screenshot dir |
| `capture/scratchpadStore.ts` | Disk persistence, settle timer |

**Modify:**

| File | Change |
|---|---|
| `engine-overrides/renderer/widget/vadPolicy.ts` | Add `'insert'` cut decision |
| `native-paste/src/paste.mm`, `stub.cc`, `index.js` | Expose `clipboardChangeCount()` |
| `engine-overrides/electron/sessionManager.ts` | Capture seam: arm/disarm, feed segments |
| `engine-overrides/electron/clipboard.ts` | Register own writes; drop `consumeStagedForDictation` |
| `electron/remote/init.ts` | Delivery seam, destinations, IPC; **delete the old ledger** |
| `electron/remote-preload.ts` | Scratchpad IPC surface |
| `native-notch/Sources/unmute-notch/` | Pill icon + pad panel |

---

## Task 1: Capture buffer types and timeline

**Files:**
- Create: `desktop/electron/remote/capture/types.ts`
- Create: `desktop/electron/remote/capture/captureBuffer.ts`
- Test: `desktop/electron/remote/capture/captureBuffer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `InsertKind`, `Segment`, `Insert`, `Entry`, `Pad`, `Destination` (types); `emptyPad(id, origin, now)`, `addSegment(pad, seg)`, `addInsert(pad, ins)`, `removeEntry(pad, id)`, `ordered(pad)`, `isEmpty(pad)`, `setSegmentText(pad, id, text)`.

- [ ] **Step 1: Write `types.ts`**

```ts
// Shared shapes for the capture buffer. No behaviour, no imports — every
// other capture module depends on this and nothing else.

/** How an insert is rendered. Decided by regex only (insertClassify). */
export type InsertKind = 'url' | 'path' | 'line' | 'block' | 'image'

/** Where a pad is delivered. Set as a default by the trigger key that opened
 *  the capture; overridable on the pad. */
export type Destination = 'cursor' | 'task'

/** One press-to-pause stretch of speech. `text` is '' until transcription
 *  lands — the segment exists from the moment recording starts so inserts can
 *  be positioned against it. */
export interface Segment {
  type: 'segment'
  id: string
  text: string
  startMs: number
  endMs: number
}

/** Something the user copied or captured during a hot mic. `content` is the
 *  text for url/path/line/block, and an absolute file path for image. */
export interface Insert {
  type: 'insert'
  id: string
  kind: InsertKind
  content: string
  atMs: number
}

export type Entry = Segment | Insert

/** The one buffer. Exactly one exists at a time — same cardinality as the
 *  clipboard. */
export interface Pad {
  id: string
  origin: Destination
  createdAt: number
  updatedAt: number
  entries: Entry[]
}

/** Sort key: a segment is positioned by where it started, an insert by when
 *  it happened. Exported because ordering is the buffer's whole contract. */
export function timeOf(e: Entry): number {
  return e.type === 'segment' ? e.startMs : e.atMs
}
```

- [ ] **Step 2: Write the failing test**

```ts
// desktop/electron/remote/capture/captureBuffer.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import {
  emptyPad, addSegment, addInsert, removeEntry, ordered, isEmpty, setSegmentText,
} from './captureBuffer'

const pad0 = () => emptyPad('pad1', 'task', 1000)

describe('emptyPad', () => {
  test('starts empty with its origin recorded', () => {
    const p = pad0()
    assert.equal(p.id, 'pad1')
    assert.equal(p.origin, 'task')
    assert.equal(p.entries.length, 0)
    assert.equal(isEmpty(p), true)
  })
})

describe('ordering', () => {
  test('an insert lands between the segments it fell between', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'first', startMs: 0, endMs: 10_000 })
    p = addSegment(p, { id: 's2', text: 'second', startMs: 20_000, endMs: 30_000 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 15_000 })
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1', 's2'])
  })

  test('out-of-order arrival still orders by time, not insertion', () => {
    let p = pad0()
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 15_000 })
    p = addSegment(p, { id: 's1', text: 'first', startMs: 0, endMs: 10_000 })
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1'])
  })

  test('an insert inside a segment span sorts after that segment starts', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'talking', startMs: 0, endMs: 30_000 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 12_400 })
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1'])
  })

  test('ties are stable — a segment starting at the insert time comes first', () => {
    let p = pad0()
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 5_000 })
    p = addSegment(p, { id: 's1', text: 'x', startMs: 5_000, endMs: 9_000 })
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1'])
  })
})

describe('mutation is immutable', () => {
  test('addSegment does not modify the input pad', () => {
    const p = pad0()
    const q = addSegment(p, { id: 's1', text: 'a', startMs: 0, endMs: 1 })
    assert.equal(p.entries.length, 0)
    assert.equal(q.entries.length, 1)
  })

  test('updatedAt advances on every mutation', () => {
    const p = pad0()
    const q = addInsert(p, { id: 'i1', kind: 'line', content: 'x', atMs: 5, now: 2000 })
    assert.equal(q.updatedAt, 2000)
  })
})

describe('removeEntry', () => {
  test('removes a single insert, leaving segments intact', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'a', startMs: 0, endMs: 10 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 5 })
    p = removeEntry(p, 'i1')
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1'])
  })

  test('removes a whole segment, leaving inserts intact', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'a', startMs: 0, endMs: 10 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 5 })
    p = removeEntry(p, 's1')
    assert.deepEqual(ordered(p).map((e) => e.id), ['i1'])
  })

  test('removing the last entry makes the pad empty again', () => {
    let p = pad0()
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 5 })
    p = removeEntry(p, 'i1')
    assert.equal(isEmpty(p), true)
  })

  test('removing an unknown id is a no-op, not a throw', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'a', startMs: 0, endMs: 10 })
    assert.equal(removeEntry(p, 'nope').entries.length, 1)
  })
})

describe('setSegmentText', () => {
  test('fills in transcription that arrives after the segment was created', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: '', startMs: 0, endMs: 10 })
    p = setSegmentText(p, 's1', 'the words')
    const s = ordered(p)[0]
    assert.equal(s.type === 'segment' && s.text, 'the words')
  })

  test('an unknown id is a no-op', () => {
    const p = setSegmentText(pad0(), 'nope', 'x')
    assert.equal(p.entries.length, 0)
  })
})
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `cd desktop && npx tsx --test electron/remote/capture/captureBuffer.test.ts`
Expected: FAIL — `Cannot find module './captureBuffer'`

- [ ] **Step 4: Write `captureBuffer.ts`**

```ts
// The capture buffer — the one timeline every capture composes into.
//
// Pure and immutable on purpose: this is the module that decides what the user
// actually sends, so it must be exhaustively testable without a mic, a
// clipboard, or an Electron window. Every operation returns a new Pad.
//
// ORDER IS THE CONTRACT. Inserts are positioned by wall-clock time against the
// segments around them, because speech refers to artifacts deictically ("go
// through the thread" ⌘C "and compare it with the doc" ⌘C). Order is what makes
// those references resolvable; exact position is a refinement on top of it.

import type { Destination, Entry, Insert, Pad, Segment } from './types'
import { timeOf } from './types'

export function emptyPad(id: string, origin: Destination, now: number): Pad {
  return { id, origin, createdAt: now, updatedAt: now, entries: [] }
}

export function isEmpty(pad: Pad): boolean {
  return pad.entries.length === 0
}

/** Time-ordered. Ties put the segment first, so an insert made at the instant a
 *  segment begins reads as belonging to that segment rather than preceding it. */
export function ordered(pad: Pad): Entry[] {
  return [...pad.entries].sort((a, b) => {
    const d = timeOf(a) - timeOf(b)
    if (d !== 0) return d
    if (a.type === b.type) return 0
    return a.type === 'segment' ? -1 : 1
  })
}

function withEntries(pad: Pad, entries: Entry[], now?: number): Pad {
  return { ...pad, entries, updatedAt: now ?? pad.updatedAt }
}

export function addSegment(
  pad: Pad,
  seg: Omit<Segment, 'type'> & { now?: number },
): Pad {
  const { now, ...rest } = seg
  return withEntries(pad, [...pad.entries, { type: 'segment', ...rest }], now)
}

export function addInsert(
  pad: Pad,
  ins: Omit<Insert, 'type'> & { now?: number },
): Pad {
  const { now, ...rest } = ins
  return withEntries(pad, [...pad.entries, { type: 'insert', ...rest }], now)
}

export function removeEntry(pad: Pad, id: string, now?: number): Pad {
  const entries = pad.entries.filter((e) => e.id !== id)
  if (entries.length === pad.entries.length) return pad
  return withEntries(pad, entries, now)
}

/** Transcription arrives long after the segment was created (chunks are 30-45s),
 *  so the segment is born empty and filled in later. */
export function setSegmentText(pad: Pad, id: string, text: string, now?: number): Pad {
  let found = false
  const entries = pad.entries.map((e) => {
    if (e.type !== 'segment' || e.id !== id) return e
    found = true
    return { ...e, text }
  })
  return found ? withEntries(pad, entries, now) : pad
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `cd desktop && npx tsx --test electron/remote/capture/captureBuffer.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Run the full suite**

Run: `cd desktop && npm test`
Expected: 805 baseline + new tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add desktop/electron/remote/capture/
git commit -m "feat(capture): the buffer is a time-ordered timeline, not a list

Order is the contract. Speech points at artifacts deictically, so an
insert is positioned by when it happened relative to the segments
around it — that ordering is what makes 'the thread' resolvable to the
right link. Immutable and dependency-free so it tests without a mic."
```

---

## Task 2: Insert classification

**Files:**
- Create: `desktop/electron/remote/capture/insertClassify.ts`
- Test: `desktop/electron/remote/capture/insertClassify.test.ts`

**Interfaces:**
- Consumes: `InsertKind` from `./types`.
- Produces: `classifyText(content: string, exists?: (p: string) => boolean): InsertKind`, and `LINE_MAX_CHARS = 200`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/electron/remote/capture/insertClassify.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { classifyText, LINE_MAX_CHARS } from './insertClassify'

const noFs = () => false
const anyPathExists = () => true

describe('urls', () => {
  test('https', () => assert.equal(classifyText('https://slack.com/x', noFs), 'url'))
  test('http', () => assert.equal(classifyText('http://example.com', noFs), 'url'))
  test('with a query string and fragment', () => {
    assert.equal(classifyText('https://a.com/b?c=d&e=f#g', noFs), 'url')
  })
  test('surrounding whitespace is tolerated', () => {
    assert.equal(classifyText('  https://a.com  ', noFs), 'url')
  })
  test('a bare domain is NOT a url — it is an ordinary line', () => {
    assert.equal(classifyText('example.com', noFs), 'line')
  })
  test('a url with a newline after it is a block, not a url', () => {
    assert.equal(classifyText('https://a.com\nand more', noFs), 'block')
  })
})

describe('paths', () => {
  test('absolute path that exists', () => {
    assert.equal(classifyText('/Users/me/notes.md', anyPathExists), 'path')
  })
  test('tilde path that exists', () => {
    assert.equal(classifyText('~/notes.md', anyPathExists), 'path')
  })
  test('a path with spaces that exists', () => {
    assert.equal(classifyText('/Users/me/my notes.md', anyPathExists), 'path')
  })
  test('absolute-looking but NOT on disk falls through to line', () => {
    assert.equal(classifyText('/not/real', noFs), 'line')
  })
  test('a relative path is never a path', () => {
    assert.equal(classifyText('src/index.ts', anyPathExists), 'line')
  })
})

describe('lines vs blocks', () => {
  test('short single line', () => {
    assert.equal(classifyText('fix the login bug', noFs), 'line')
  })
  test('exactly at the limit is still a line', () => {
    assert.equal(classifyText('a'.repeat(LINE_MAX_CHARS), noFs), 'line')
  })
  test('one over the limit becomes a block', () => {
    assert.equal(classifyText('a'.repeat(LINE_MAX_CHARS + 1), noFs), 'block')
  })
  test('any newline makes it a block, however short', () => {
    assert.equal(classifyText('a\nb', noFs), 'block')
  })
  test('a carriage return counts as a newline', () => {
    assert.equal(classifyText('a\r\nb', noFs), 'block')
  })
  test('a stack trace is a block', () => {
    assert.equal(classifyText('Traceback:\n  File "a.py"\nValueError', noFs), 'block')
  })
})

describe('the default is the cheap failure', () => {
  test('empty string is a block, never inlined', () => {
    assert.equal(classifyText('', noFs), 'block')
  })
  test('whitespace only is a block', () => {
    assert.equal(classifyText('   \n  ', noFs), 'block')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd desktop && npx tsx --test electron/remote/capture/insertClassify.test.ts`
Expected: FAIL — `Cannot find module './insertClassify'`

- [ ] **Step 3: Write `insertClassify.ts`**

```ts
// What KIND of thing did the user just copy?
//
// The system is not intelligent and cannot know what a copied thing MEANS. It
// does not need to — every branch here is a deterministic check. Meaning is
// never inferred; only shape.
//
// FENCED IS THE DEFAULT; INLINE MUST BE EARNED. Fencing something short is a
// cosmetic annoyance. Inlining something long or unrecognised wrecks the
// sentence AND destroys the boundary irrecoverably. So the unknown case falls
// to the cheap failure.
//
// Pure module: the on-disk check is injected, so this tests without a
// filesystem.

import type { InsertKind } from './types'

/** A single line longer than this reads as a block. 200 is about two lines of
 *  wrapped prose — past that, inlining stops being readable. */
export const LINE_MAX_CHARS = 200

const URL_RE = /^https?:\/\/\S+$/
const ABS_PATH_RE = /^(?:\/|~\/)/

export function classifyText(
  content: string,
  exists: (path: string) => boolean = () => false,
): InsertKind {
  const t = content.trim()
  if (!t) return 'block'
  if (/[\r\n]/.test(t)) return 'block'

  if (URL_RE.test(t)) return 'url'
  // A path only counts if it is really there. An absolute-looking string that
  // is not on disk is just text the user copied.
  if (ABS_PATH_RE.test(t) && exists(t)) return 'path'
  if (t.length <= LINE_MAX_CHARS) return 'line'
  return 'block'
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd desktop && npx tsx --test electron/remote/capture/insertClassify.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

```bash
cd desktop && npm test
git add desktop/electron/remote/capture/
git commit -m "feat(capture): classify an insert by shape, never by meaning

Regex only — no judgement, no model. Fenced is the default and inline
must be earned, because inlining something long or unrecognised wrecks
the sentence and destroys the boundary, while fencing something short
is merely ugly. The unknown case takes the cheap failure."
```

---

## Task 3: Rendering a pad to a destination

**Files:**
- Create: `desktop/electron/remote/capture/insertRender.ts`
- Test: `desktop/electron/remote/capture/insertRender.test.ts`

**Interfaces:**
- Consumes: `Pad`, `Destination`, `Entry` from `./types`; `ordered` from `./captureBuffer`.
- Produces: `render(pad: Pad, dest: Destination): RenderResult` where `RenderResult = { text: string; attachments: string[] }`; `fenceFor(content: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/electron/remote/capture/insertRender.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { render, fenceFor } from './insertRender'
import { emptyPad, addSegment, addInsert } from './captureBuffer'
import type { Pad } from './types'

function build(): Pad {
  let p = emptyPad('p', 'task', 0)
  p = addSegment(p, { id: 's1', text: 'go through the thread', startMs: 0, endMs: 10_000 })
  p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://slack.com/x', atMs: 12_000 })
  p = addSegment(p, { id: 's2', text: 'and tell me what you think', startMs: 14_000, endMs: 20_000 })
  return p
}

describe('inline kinds read as one sentence', () => {
  test('a url joins the speech inline at the cursor', () => {
    assert.equal(
      render(build(), 'cursor').text,
      'go through the thread https://slack.com/x and tell me what you think',
    )
  })
  test('and inline for a task too — a url carries no ambiguity anywhere', () => {
    assert.equal(
      render(build(), 'task').text,
      'go through the thread https://slack.com/x and tell me what you think',
    )
  })
  test('no doubled spaces when speech already ends in one', () => {
    let p = emptyPad('p', 'cursor', 0)
    p = addSegment(p, { id: 's1', text: 'look at ', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://a.com', atMs: 2 })
    assert.equal(render(p, 'cursor').text, 'look at https://a.com')
  })
})

describe('block kinds are fenced in every destination', () => {
  test('a multi-line paste is fenced', () => {
    let p = emptyPad('p', 'task', 0)
    p = addSegment(p, { id: 's1', text: 'I got this', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'block', content: 'line one\nline two', atMs: 2 })
    p = addSegment(p, { id: 's2', text: 'please fix it', startMs: 3, endMs: 4 })
    assert.equal(
      render(p, 'task').text,
      'I got this\n\n```\nline one\nline two\n```\n\nplease fix it',
    )
  })
  test('fenced at the cursor too — readability, not provenance', () => {
    let p = emptyPad('p', 'cursor', 0)
    p = addInsert(p, { id: 'i1', kind: 'block', content: 'a\nb', atMs: 1 })
    assert.equal(render(p, 'cursor').text, '```\na\nb\n```')
  })
})

describe('fenceFor escapes content containing backticks', () => {
  test('plain content uses three', () => {
    assert.equal(fenceFor('hello'), '```')
  })
  test('content with a three-run uses four', () => {
    assert.equal(fenceFor('a ``` b'), '````')
  })
  test('content with a five-run uses six', () => {
    assert.equal(fenceFor('`````'), '``````')
  })
  test('inline single backticks do not extend the fence', () => {
    assert.equal(fenceFor('use `x` here'), '```')
  })
  test('a fenced block containing a fence still round-trips', () => {
    let p = emptyPad('p', 'task', 0)
    p = addInsert(p, { id: 'i1', kind: 'block', content: '```js\nx\n```', atMs: 1 })
    assert.equal(render(p, 'task').text, '````\n```js\nx\n```\n````')
  })
})

describe('images', () => {
  test('a task gets a real reference and the path as an attachment', () => {
    let p = emptyPad('p', 'task', 0)
    p = addSegment(p, { id: 's1', text: 'look at this', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'image', content: '/tmp/shot.png', atMs: 2 })
    const r = render(p, 'task')
    assert.match(r.text, /\/tmp\/shot\.png/)
    assert.deepEqual(r.attachments, ['/tmp/shot.png'])
  })
  test('the cursor skips images entirely — a text field cannot hold one', () => {
    let p = emptyPad('p', 'cursor', 0)
    p = addSegment(p, { id: 's1', text: 'look at this', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'image', content: '/tmp/shot.png', atMs: 2 })
    const r = render(p, 'cursor')
    assert.equal(r.text, 'look at this')
    assert.deepEqual(r.attachments, [])
  })
})

describe('nothing is ever asserted about meaning', () => {
  test('no label appears anywhere in the output', () => {
    let p = emptyPad('p', 'task', 0)
    p = addInsert(p, { id: 'i1', kind: 'block', content: 'x\ny', atMs: 1 })
    const t = render(p, 'task').text
    for (const banned of ['copied', 'selected', 'context', 'pasted', 'user']) {
      assert.ok(!t.toLowerCase().includes(banned), `must not contain "${banned}"`)
    }
  })
})

describe('edges', () => {
  test('an empty pad renders to empty string', () => {
    assert.equal(render(emptyPad('p', 'task', 0), 'task').text, '')
  })
  test('a segment with no transcription yet is skipped, not rendered blank', () => {
    let p = emptyPad('p', 'task', 0)
    p = addSegment(p, { id: 's1', text: '', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://a.com', atMs: 2 })
    assert.equal(render(p, 'task').text, 'https://a.com')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd desktop && npx tsx --test electron/remote/capture/insertRender.test.ts`
Expected: FAIL — `Cannot find module './insertRender'`

- [ ] **Step 3: Write `insertRender.ts`**

```ts
// Turn a pad into the thing that actually gets delivered.
//
// Provenance lives in the BUFFER and is rendered away HERE, per destination —
// never discarded at capture time. The cursor wants clean text; a task benefits
// from knowing what was spoken versus what was pointed at, because pasted text
// is verbatim ground truth while dictated text has been through STT and may be
// wrong.
//
// A FENCE IS A BOUNDARY MARKER, NOT A CLAIM. It asserts only "this is verbatim,
// it starts here, it ends here" — the one thing we know for certain. We never
// label an insert ("the user copied:", "context:"), because that would assert
// meaning we have no way to know.

import type { Destination, Entry, Pad } from './types'
import { ordered } from './captureBuffer'

export interface RenderResult {
  text: string
  attachments: string[]
}

/** A fence long enough to survive whatever backtick runs are inside. */
export function fenceFor(content: string): string {
  let longest = 0
  for (const run of content.match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Kinds that read as part of the sentence. Everything else gets a boundary. */
const INLINE = new Set(['url', 'path', 'line'])

export function render(pad: Pad, dest: Destination): RenderResult {
  const attachments: string[] = []
  // Each piece carries whether it must stand alone, so joining can decide
  // between a space and a blank line without re-inspecting kinds.
  const pieces: { text: string; block: boolean }[] = []

  for (const e of ordered(pad) as Entry[]) {
    if (e.type === 'segment') {
      const t = e.text.trim()
      if (t) pieces.push({ text: t, block: false })
      continue
    }
    if (e.kind === 'image') {
      // A plain text field cannot hold an image, so the cursor skips it
      // entirely rather than pasting a path the user did not ask for.
      if (dest === 'cursor') continue
      attachments.push(e.content)
      pieces.push({ text: `[image: ${e.content}]`, block: false })
      continue
    }
    if (INLINE.has(e.kind)) {
      pieces.push({ text: e.content.trim(), block: false })
      continue
    }
    const fence = fenceFor(e.content)
    pieces.push({ text: `${fence}\n${e.content}\n${fence}`, block: true })
  }

  // Track prevBlock explicitly. Do NOT look the previous piece up with
  // indexOf: two identical blocks are equal by value, so indexOf returns the
  // first one and the separator is computed against the wrong neighbour.
  let text = ''
  let prevBlock = false
  for (const p of pieces) {
    if (!text) { text = p.text; prevBlock = p.block; continue }
    text += (p.block || prevBlock ? '\n\n' : ' ') + p.text
    prevBlock = p.block
  }
  return { text, attachments }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd desktop && npx tsx --test electron/remote/capture/insertRender.test.ts`
Expected: PASS

- [ ] **Step 5: Add a regression test pinning the identical-blocks case**

```ts
test('two identical blocks both render (no indexOf aliasing)', () => {
  let p = emptyPad('p', 'task', 0)
  p = addInsert(p, { id: 'i1', kind: 'block', content: 'same\nsame', atMs: 1 })
  p = addInsert(p, { id: 'i2', kind: 'block', content: 'same\nsame', atMs: 2 })
  const t = render(p, 'task').text
  assert.equal(t.split('```').length - 1, 4)
})
```

- [ ] **Step 6: Run the full suite and commit**

```bash
cd desktop && npm test
git add desktop/electron/remote/capture/
git commit -m "feat(capture): render a pad per destination, asserting nothing

Provenance is kept in the buffer and rendered away here — the cursor
wants clean text, a task benefits from knowing what was spoken versus
pointed at. Fences are boundary markers, not claims: they say verbatim,
starts here, ends here, and nothing about meaning. No insert is ever
labelled."
```

---

## Task 4: The clipboard ledger

**Files:**
- Create: `desktop/electron/remote/capture/clipboardLedger.ts`
- Test: `desktop/electron/remote/capture/clipboardLedger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createLedger(dedupWindowMs?: number): Ledger`; `noteOwnWrite(l, changeCount)`; `shouldObserve(l, changeCount): boolean`; `claimContent(l, hash, atMs): boolean`; `resetLedger(l)`; `DEDUP_WINDOW_MS = 2000`.

**This is the critical module.** It is the entire bug class being removed.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/electron/remote/capture/clipboardLedger.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import {
  createLedger, noteOwnWrite, shouldObserve, claimContent, resetLedger, DEDUP_WINDOW_MS,
} from './clipboardLedger'

describe('our own writes are unobservable BY CONSTRUCTION', () => {
  test('a changeCount we caused is never observed', () => {
    const l = createLedger()
    noteOwnWrite(l, 42)
    assert.equal(shouldObserve(l, 42), false)
  })

  test('captureSelection then injectOutput — both of ours, neither observed', () => {
    const l = createLedger()
    noteOwnWrite(l, 10)  // synthetic Cmd+C at capture start
    noteOwnWrite(l, 11)  // transcript written for pasting
    assert.equal(shouldObserve(l, 10), false)
    assert.equal(shouldObserve(l, 11), false)
  })

  test('a user copy BETWEEN two of our writes is still observed', () => {
    const l = createLedger()
    noteOwnWrite(l, 10)
    assert.equal(shouldObserve(l, 11), true)  // the user
    noteOwnWrite(l, 12)
    assert.equal(shouldObserve(l, 12), false)
  })

  test('an unrecorded changeCount is observed — the default is to capture', () => {
    assert.equal(shouldObserve(createLedger(), 7), true)
  })

  test('the same changeCount asked twice answers the same both times', () => {
    const l = createLedger()
    noteOwnWrite(l, 5)
    assert.equal(shouldObserve(l, 5), false)
    assert.equal(shouldObserve(l, 5), false)
  })
})

describe('one user action yields one insert', () => {
  test('a tool that writes a file AND copies fires both detectors, inserts once', () => {
    const l = createLedger()
    assert.equal(claimContent(l, 'hash-abc', 1000), true)   // clipboard detector
    assert.equal(claimContent(l, 'hash-abc', 1150), false)  // file detector, same shot
  })

  test('different content within the window both land', () => {
    const l = createLedger()
    assert.equal(claimContent(l, 'hash-a', 1000), true)
    assert.equal(claimContent(l, 'hash-b', 1100), true)
  })

  test('the same content copied again AFTER the window is a real second insert', () => {
    const l = createLedger()
    assert.equal(claimContent(l, 'hash-a', 1000), true)
    assert.equal(claimContent(l, 'hash-a', 1000 + DEDUP_WINDOW_MS + 1), true)
  })

  test('exactly at the window boundary is still a duplicate', () => {
    const l = createLedger()
    assert.equal(claimContent(l, 'hash-a', 1000), true)
    assert.equal(claimContent(l, 'hash-a', 1000 + DEDUP_WINDOW_MS), false)
  })
})

describe('resetLedger', () => {
  test('a new capture window starts clean', () => {
    const l = createLedger()
    noteOwnWrite(l, 1)
    claimContent(l, 'h', 100)
    resetLedger(l)
    assert.equal(shouldObserve(l, 1), true)
    assert.equal(claimContent(l, 'h', 100), true)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd desktop && npx tsx --test electron/remote/capture/clipboardLedger.test.ts`
Expected: FAIL — `Cannot find module './clipboardLedger'`

- [ ] **Step 3: Write `clipboardLedger.ts`**

```ts
// "Have we already accounted for this?" — asked two ways.
//
// THIS MODULE IS THE POINT OF THE REWRITE. The old ledger tried to RECOGNISE
// our own clipboard writes by hashing image bytes, and to reject stale content
// by snapshotting the pasteboard before a capture. Both are inference, both are
// fragile, and both are why the shipped feature misfires.
//
// Here neither question is inferred:
//
//   * OUR OWN WRITES. Every Unmute pasteboard write records the changeCount it
//     produced. A recorded value is skipped. Not "probably ours" — ours, by
//     construction.
//
//   * DUPLICATES. A screenshot tool configured to write a file AND copy fires
//     both detectors for one user action. Content is claimed once within a
//     short window, so one action yields one insert.
//
// Staleness is not handled here because it cannot occur: provenance is a
// changeCount TRANSITION observed inside a consented window, so an image that
// was already on the pasteboard produces no transition and is never a
// candidate.

/** One physical action can reach both detectors; 2s comfortably covers the gap
 *  between a file write and the pasteboard write, without merging two
 *  deliberate copies of the same thing. */
export const DEDUP_WINDOW_MS = 2000

export interface Ledger {
  ownWrites: Set<number>
  claims: Map<string, number>
  dedupWindowMs: number
}

export function createLedger(dedupWindowMs: number = DEDUP_WINDOW_MS): Ledger {
  return { ownWrites: new Set(), claims: new Map(), dedupWindowMs }
}

/** Called immediately after any Unmute write to the pasteboard, with the
 *  changeCount that write produced. */
export function noteOwnWrite(l: Ledger, changeCount: number): void {
  l.ownWrites.add(changeCount)
}

/** The default is to capture: anything we did not cause is the user's. */
export function shouldObserve(l: Ledger, changeCount: number): boolean {
  return !l.ownWrites.has(changeCount)
}

/** True if this content is new enough to become an insert. False means another
 *  detector already claimed the same user action. */
export function claimContent(l: Ledger, hash: string, atMs: number): boolean {
  const prev = l.claims.get(hash)
  if (prev !== undefined && atMs - prev <= l.dedupWindowMs) return false
  l.claims.set(hash, atMs)
  return true
}

/** Between capture windows. Keeps the sets from growing without bound and
 *  guarantees a fresh window shares no state with the last one. */
export function resetLedger(l: Ledger): void {
  l.ownWrites.clear()
  l.claims.clear()
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd desktop && npx tsx --test electron/remote/capture/clipboardLedger.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

```bash
cd desktop && npm test
git add desktop/electron/remote/capture/
git commit -m "feat(capture): our own clipboard writes become unobservable by construction

The old ledger tried to RECOGNISE our writes by hashing image bytes and
to reject stale content by snapshotting the pasteboard first. Both are
inference; both are why the shipped feature misfires. Here we record
the changeCount each of our writes produced and skip it — ours by
construction, not by resemblance. Dedup on content covers the tool that
writes a file AND copies, so one action makes one insert."
```

---

## Task 5: The `insert` cut decision

**Files:**
- Modify: `desktop/engine-overrides/renderer/widget/vadPolicy.ts`
- Test: `desktop/engine-overrides/renderer/widget/vadPolicy.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `CutDecision` gains `'insert'`; `CutInput` gains `insertPending?: boolean` and `insertFloorMs?: number`; `INSERT_FLOOR_MS = 9000`.

- [ ] **Step 1: Add the failing tests to the existing file**

```ts
// append to desktop/engine-overrides/renderer/widget/vadPolicy.test.ts
describe('insert cut (permit, never force)', () => {
  const silent = {
    ...base, rms: 0.001, silenceSinceMs: 800, chunkElapsedMs: 12_000,
  }

  test('a pending insert in sustained silence past the floor cuts', () => {
    assert.equal(decideCut({ ...silent, insertPending: true }), 'insert')
  })

  test('no pending insert: unchanged behaviour, no cut before minChunkMs', () => {
    assert.equal(decideCut(silent), 'none')
  })

  test('NEVER cuts mid-speech, however long the chunk has run', () => {
    assert.equal(
      decideCut({ ...silent, rms: 0.2, silenceSinceMs: null, insertPending: true }),
      'none',
    )
  })

  test('never cuts below the floor — a sliver transcribes badly', () => {
    assert.equal(
      decideCut({ ...silent, chunkElapsedMs: 3_000, insertPending: true }),
      'none',
    )
  })

  test('silence must be SUSTAINED, not a momentary dip', () => {
    assert.equal(
      decideCut({ ...silent, silenceSinceMs: 100, insertPending: true }),
      'none',
    )
  })

  test('hard cap still outranks an insert cut', () => {
    assert.equal(
      decideCut({ ...silent, chunkElapsedMs: 45_000, insertPending: true }),
      'hard-cap',
    )
  })

  test('past minChunkMs an ordinary silence cut still wins the label', () => {
    assert.equal(
      decideCut({ ...silent, chunkElapsedMs: 31_000, insertPending: true }),
      'silence',
    )
  })
})
```

- [ ] **Step 2: Run and verify it fails**

Run: `cd desktop && npx tsx --test engine-overrides/renderer/widget/vadPolicy.test.ts`
Expected: FAIL — insert cases return `'none'`.

- [ ] **Step 3: Modify `vadPolicy.ts`**

Change the type and add the branch. The branch goes **after** `hard-cap` and **before** the `minChunkMs` early return, because it deliberately cuts below that minimum:

```ts
export type CutDecision = 'none' | 'silence' | 'soft-cap' | 'hard-cap' | 'insert'

/** A clipboard event PERMITS an early cut, so an insert lands close to where it
 *  happened. It never FORCES one: forcing a cut on every copy would slice
 *  mid-word, which the 2026-07-14 investigation identified as the primary
 *  source of garbled transcripts. Order already carries most of the value of
 *  interleaving, so exactness is not worth the accuracy. */
export const INSERT_FLOOR_MS = 9000

export interface CutInput {
  rms: number
  chunkElapsedMs: number
  silenceSinceMs: number | null
  minChunkMs: number
  silenceDurationMs: number
  hardCapMs: number
  softCapWindowMs: number
  threshold: number
  /** An insert was detected and has not yet been given a boundary. */
  insertPending?: boolean
  insertFloorMs?: number
}

export function decideCut(input: CutInput): CutDecision {
  if (input.chunkElapsedMs >= input.hardCapMs) return 'hard-cap'

  // Below minChunkMs on purpose — but only in real, sustained silence, so this
  // can never land mid-word, and only past a floor, so the chunk still has
  // enough audio to transcribe well.
  if (
    input.insertPending &&
    input.chunkElapsedMs < input.minChunkMs &&
    input.chunkElapsedMs >= (input.insertFloorMs ?? INSERT_FLOOR_MS) &&
    input.rms < input.threshold &&
    input.silenceSinceMs != null &&
    input.silenceSinceMs >= input.silenceDurationMs
  ) {
    return 'insert'
  }

  if (input.chunkElapsedMs < input.minChunkMs) return 'none'
  if (
    input.chunkElapsedMs >= input.hardCapMs - input.softCapWindowMs &&
    input.rms < input.threshold * SOFT_CAP_DIP
  ) {
    return 'soft-cap'
  }
  if (input.rms < input.threshold && input.silenceSinceMs != null && input.silenceSinceMs >= input.silenceDurationMs) {
    return 'silence'
  }
  return 'none'
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `cd desktop && npx tsx --test engine-overrides/renderer/widget/vadPolicy.test.ts`
Expected: PASS — including all seven pre-existing `decideCut` tests, which must be untouched.

- [ ] **Step 5: Wire `insertPending` in the recorder**

In `useAudioRecorder.ts`, add a ref set by an IPC push from main when an insert is detected, cleared when a cut is taken. Pass it into the existing `decideCut` call:

```ts
const insertPendingRef = useRef(false)
// set true on 'capture:insert-detected' from main; cleared below

const decision = decideCut({
  rms, chunkElapsedMs, silenceSinceMs,
  minChunkMs: chunkMinMsRef.current,
  silenceDurationMs: silenceDurationMsRef.current,
  hardCapMs: hardChunkCapMsRef.current,
  softCapWindowMs: softCapWindowMsRef.current,
  threshold,
  insertPending: insertPendingRef.current,
})
if (decision !== 'none') insertPendingRef.current = false
```

- [ ] **Step 6: Run the full suite and commit**

```bash
cd desktop && npm test
git add desktop/engine-overrides/renderer/widget/
git commit -m "feat(vad): a copy PERMITS an early chunk cut, never forces one

Forcing a cut on every clipboard event would slice mid-word — the exact
failure the 2026-07-14 investigation named as the primary source of
garbled transcripts. So the insert cut fires only in sustained silence
and only past a floor, where it cannot land mid-word and the chunk
still has enough audio to transcribe well. Worst case it degrades to
the next natural boundary, which is fine: order carries the meaning."
```

---

## Task 6: `clipboardChangeCount()` in the native addon

**Files:**
- Modify: `desktop/native-paste/src/paste.mm`
- Modify: `desktop/native-paste/src/stub.cc`
- Modify: `desktop/native-paste/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `require('unmute-native-paste').clipboardChangeCount(): number` — monotonic, `-1` on non-macOS.

`native-paste` is the right home: it is already the in-process clipboard owner, and the in-process requirement is the same one that put paste there (macOS grants TCC by signed bundle identity, so a spawned helper has its own identity).

- [ ] **Step 1: Add the function to `paste.mm`**

Insert before `Init`, and add `#import <AppKit/AppKit.h>` to the includes:

```objc
// ────────────────────────────────────────────────────────────────────
// clipboardChangeCount() — the cheapest possible "did the clipboard
// change?"
//
// NSPasteboard.changeCount is a monotonically increasing integer bumped on
// every write by any process. Reading it costs a single property access — no
// decode, no allocation, no image work — which is what makes it safe to poll
// on the main process WHILE RECORDING, where reading actual pasteboard
// contents corrupts the audio.
//
// It is also what makes our own writes exactly identifiable: record the value
// after an Unmute write and skip it, rather than trying to recognise our own
// content by hashing it.
// ────────────────────────────────────────────────────────────────────
Napi::Value ClipboardChangeCount(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSInteger count = [[NSPasteboard generalPasteboard] changeCount];
    return Napi::Number::New(env, (double)count);
  }
}
```

Register it:

```objc
  exports.Set("clipboardChangeCount",
              Napi::Function::New(env, ClipboardChangeCount));
```

Add `"-framework", "AppKit"` to `OTHER_LDFLAGS` in `binding.gyp`.

- [ ] **Step 2: Add the stub for non-macOS**

In `stub.cc`, before `Init`:

```cpp
Napi::Value ClipboardChangeCount(const Napi::CallbackInfo& info) {
  // -1 is distinguishable from any real count, so callers treat the platform
  // as "cannot observe" rather than "clipboard never changes".
  return Napi::Number::New(info.Env(), (double)-1);
}
```

Register it in the stub's `Init` identically.

- [ ] **Step 3: Rebuild and verify by hand**

```bash
cd desktop/native-paste && npx node-gyp rebuild --release
node -e "const a=require('./index.js'); const x=a.clipboardChangeCount(); console.log('count', x); require('child_process').execSync('printf hello | pbcopy'); console.log('after', a.clipboardChangeCount());"
```
Expected: the second number is strictly greater than the first.

- [ ] **Step 4: Commit**

```bash
git add desktop/native-paste/
git commit -m "feat(native-paste): expose NSPasteboard.changeCount

A single monotonic integer, readable for the cost of one property
access — no decode, no allocation. That is what makes it safe to poll
on the main process WHILE RECORDING, where reading real pasteboard
contents corrupts the audio. It is also what makes our own writes
exactly identifiable instead of merely recognisable."
```

---

## Task 7: Clipboard watcher

**Files:**
- Create: `desktop/electron/remote/capture/clipboardWatch.ts`
- Test: `desktop/electron/remote/capture/clipboardWatch.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `shouldObserve`, `claimContent` from `./clipboardLedger`; `classifyText` from `./insertClassify`.
- Produces: `createClipboardWatch(deps: ClipboardWatchDeps): ClipboardWatch` with `{ arm(padDir), disarm(), noteOwnWrite() }`, emitting via `deps.onInsert({ kind, content, atMs })`.

All platform access is injected so the polling logic tests without a clipboard.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/electron/remote/capture/clipboardWatch.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { createClipboardWatch, type ClipboardWatchDeps } from './clipboardWatch'
import type { InsertKind } from './types'

function harness(overrides: Partial<ClipboardWatchDeps> = {}) {
  let count = 100
  let now = 1000
  const inserts: { kind: InsertKind; content: string; atMs: number }[] = []
  const deps: ClipboardWatchDeps = {
    changeCount: () => count,
    readText: () => 'https://a.com',
    hasImage: () => false,
    rescueImage: async () => '/staged/shot.png',
    exists: () => false,
    now: () => now,
    onInsert: (i) => { inserts.push(i) },
    ...overrides,
  }
  const w = createClipboardWatch(deps)
  return {
    w, inserts,
    bump: (by = 1) => { count += by },
    setNow: (t: number) => { now = t },
    get count() { return count },
  }
}

describe('arming', () => {
  test('a change BEFORE arming is never observed', async () => {
    const h = harness()
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('arming takes a baseline, so the change that armed it does not fire', async () => {
    const h = harness()
    h.w.arm('/pad')
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('a change after arming fires once', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 1)
    assert.equal(h.inserts[0].content, 'https://a.com')
    assert.equal(h.inserts[0].kind, 'url')
  })

  test('the insert timestamp is when the change was SEEN', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.setNow(12_400)
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts[0].atMs, 12_400)
  })

  test('after disarm, nothing is observed', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.w.disarm()
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })
})

describe('our own writes', () => {
  test('a write we announced is skipped', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.bump()
    h.w.noteOwnWrite()   // reads the current count and records it
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('a user copy right after our write still lands', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.bump(); h.w.noteOwnWrite()
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 1)
  })
})

describe('content', () => {
  test('an image is rescued to a file and inserted as an image', async () => {
    const h = harness({ hasImage: () => true, readText: () => '' })
    h.w.arm('/pad')
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts[0].kind, 'image')
    assert.equal(h.inserts[0].content, '/staged/shot.png')
  })

  test('a failed image rescue produces no insert, and does not throw', async () => {
    const h = harness({
      hasImage: () => true, readText: () => '', rescueImage: async () => null,
    })
    h.w.arm('/pad')
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('empty clipboard content produces no insert', async () => {
    const h = harness({ readText: () => '' })
    h.w.arm('/pad')
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('a platform that cannot observe (-1) never fires', async () => {
    const h = harness({ changeCount: () => -1 })
    h.w.arm('/pad')
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })
})

describe('the clipboard is never mutated', () => {
  test('deps expose no clear/write — the surface makes it impossible', () => {
    const h = harness()
    assert.equal('clear' in (h.w as object), false)
    assert.equal('write' in (h.w as object), false)
  })
})
```

- [ ] **Step 2: Run and verify it fails**

Run: `cd desktop && npx tsx --test electron/remote/capture/clipboardWatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `clipboardWatch.ts`**

```ts
// Watch the pasteboard during a hot mic, without ever touching the audio.
//
// DETECTION AND READING ARE SEPARATE. Detection is one integer read per tick,
// which is safe on the main process while recording. Reading actual content is
// expensive (a Retina PNG decode), so it happens only when the integer moved,
// and image bytes are read by a CHILD PROCESS — never here.
//
// RESCUE IMMEDIATELY. The pasteboard is a single-slot global: copy A then copy
// B and A is gone. So content is copied into Unmute-owned storage the instant
// it is detected, and the buffer refers to our file from then on. We never read
// the clipboard twice for the same thing, and we never depend on it retaining
// anything.
//
// WE NEVER MUTATE IT. There is deliberately no clear() and no write() on this
// surface — the only Unmute pasteboard write is delivery's injectOutput, which
// announces itself through noteOwnWrite().
//
// All platform access is injected, so the logic tests without a clipboard.

import type { InsertKind } from './types'
import { classifyText } from './insertClassify'
import {
  createLedger, noteOwnWrite as ledgerNoteOwnWrite, resetLedger, shouldObserve,
} from './clipboardLedger'

export interface ClipboardWatchDeps {
  /** Monotonic pasteboard change counter; -1 when unobservable. */
  changeCount: () => number
  readText: () => string
  hasImage: () => boolean
  /** Copies the pasteboard image into padDir via a child process. Returns the
   *  destination path, or null if it could not be read. */
  rescueImage: (padDir: string) => Promise<string | null>
  exists: (p: string) => boolean
  now: () => number
  onInsert: (i: { kind: InsertKind; content: string; atMs: number }) => void
}

export interface ClipboardWatch {
  arm: (padDir: string) => void
  disarm: () => void
  /** Record that the change we just caused is ours. Call immediately after any
   *  Unmute pasteboard write. */
  noteOwnWrite: () => void
  /** One poll. Exposed so tests drive it deterministically instead of waiting. */
  tick: () => Promise<void>
  start: () => void
  stop: () => void
}

export const POLL_MS = 250

export function createClipboardWatch(deps: ClipboardWatchDeps): ClipboardWatch {
  const ledger = createLedger()
  let armed = false
  let padDir = ''
  let lastSeen = -1
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false

  function arm(dir: string): void {
    padDir = dir
    resetLedger(ledger)
    // Baseline: whatever is on the pasteboard right now predates the window and
    // must never fire. Staleness stops being possible rather than being
    // defended against.
    lastSeen = deps.changeCount()
    armed = true
  }

  function disarm(): void {
    armed = false
    resetLedger(ledger)
  }

  function noteOwnWrite(): void {
    ledgerNoteOwnWrite(ledger, deps.changeCount())
  }

  async function tick(): Promise<void> {
    if (!armed || busy) return
    const c = deps.changeCount()
    if (c < 0 || c === lastSeen) return
    const seenAt = deps.now()
    lastSeen = c
    if (!shouldObserve(ledger, c)) return

    busy = true
    try {
      if (deps.hasImage()) {
        // Tight catch: a failed rescue degrades to "no insert". Deliberately
        // narrow so it cannot swallow a real programming error elsewhere.
        let path: string | null = null
        try { path = await deps.rescueImage(padDir) } catch { path = null }
        if (path) {
          // The window may have closed while the rescue was in flight. Capture
          // happens ONLY while the mic is hot, so a late arrival is dropped.
          if (armed) deps.onInsert({ kind: 'image', content: path, atMs: seenAt })
        }
        return
      }
      const text = deps.readText()
      if (!text.trim()) return
      if (armed) {
        deps.onInsert({ kind: classifyText(text, deps.exists), content: text, atMs: seenAt })
      }
    } catch (err) {
      // A DETECTION TICK MUST NEVER TAKE THE PROCESS DOWN. start() calls this
      // as `void tick()`, which discards a rejection — and Node >= 15
      // terminates on an unhandled one. So a throw from any dep (readText,
      // hasImage, classifyText, onInsert) would kill the Electron main process
      // mid-recording. onInsert is the realistic one: it broadcasts to every
      // BrowserWindow, and a window destroyed between the isDestroyed() guard
      // and the send throws.
      //
      // Logged, not silently dropped — a throwing dep is a real bug someone
      // needs to be able to find.
      console.warn('[capture] clipboardWatch tick failed:', err)
    } finally {
      busy = false
    }
  }

  return {
    arm, disarm, noteOwnWrite, tick,
    start() { if (!timer) timer = setInterval(() => { void tick() }, POLL_MS) },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}
```

- [ ] **Step 4: Run and verify it passes, then commit**

```bash
cd desktop && npx tsx --test electron/remote/capture/clipboardWatch.test.ts && npm test
git add desktop/electron/remote/capture/
git commit -m "feat(capture): poll an integer, rescue content, never mutate

Detection is one integer read per tick — safe on the main process
while recording, where reading real contents corrupts audio. Content is
rescued into our own storage the instant it is seen, because the
pasteboard is a single slot and copy-A-then-B loses A. There is
deliberately no clear() or write() on this surface."
```

---

## Task 8: Screenshot file watcher

**Files:**
- Create: `desktop/electron/remote/capture/screenshotWatch.ts`
- Test: `desktop/electron/remote/capture/screenshotWatch.test.ts`

**Interfaces:**
- Consumes: `claimContent` from `./clipboardLedger`.
- Produces: `isScreenshotFile(name, inDedicatedFolder): boolean`; `createScreenshotWatch(deps): { arm, disarm }`.

`⌘⇧3`/`⌘⇧4` — the macOS default — writes a file and never touches the pasteboard. Covering only the clipboard would drop the way most people screenshot.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/electron/remote/capture/screenshotWatch.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { isScreenshotFile } from './screenshotWatch'

describe('name matching outside a dedicated folder', () => {
  test('the macOS default name is accepted', () => {
    assert.equal(isScreenshotFile('Screenshot 2026-07-30 at 14.22.01.png', false), true)
  })
  test('case and the space variant are accepted', () => {
    assert.equal(isScreenshotFile('screen shot 1.png', false), true)
    assert.equal(isScreenshotFile('SCREENSHOT.png', false), true)
  })
  test('an unrelated Desktop png is NOT swept in', () => {
    assert.equal(isScreenshotFile('logo.png', false), false)
  })
  test('a downloaded photo is not swept in', () => {
    assert.equal(isScreenshotFile('IMG_4821.jpeg', false), false)
  })
})

describe('inside a dedicated Screenshots folder any image counts', () => {
  test('an arbitrary name is accepted there', () => {
    assert.equal(isScreenshotFile('logo.png', true), true)
  })
  test('jpg and jpeg are accepted', () => {
    assert.equal(isScreenshotFile('a.jpg', true), true)
    assert.equal(isScreenshotFile('a.jpeg', true), true)
  })
  test('a non-image is still rejected', () => {
    assert.equal(isScreenshotFile('notes.txt', true), false)
    assert.equal(isScreenshotFile('Screenshot.txt', true), false)
  })
})

describe('macOS in-progress writes', () => {
  test('the .sb- temp file macOS writes first is ignored', () => {
    assert.equal(isScreenshotFile('.sb-abc123-Screenshot.png', false), false)
  })
  test('a dotfile is never a screenshot', () => {
    assert.equal(isScreenshotFile('.DS_Store', true), false)
  })
})
```

- [ ] **Step 2: Run and verify it fails**

Run: `cd desktop && npx tsx --test electron/remote/capture/screenshotWatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `screenshotWatch.ts`**

```ts
// Catch the screenshots that never reach the pasteboard.
//
// changeCount only sees the pasteboard, which covers Ctrl-Shift-3/4. But the
// macOS DEFAULT is Cmd-Shift-3/4, which writes a file and never touches the
// clipboard — so a clipboard-only design would silently drop the way most
// people actually take a screenshot.
//
// EVENT-DRIVEN, NOT POLLED. This replaces a 900ms readdir sweep: fs.watch costs
// nothing while idle, fires on the actual write rather than up to 900ms later,
// and that fire time IS the insert's position. It is armed only while the mic
// is hot, so the filesystem is never observed outside a consented window.

import type { InsertKind } from './types'

const IMAGE_RE = /\.(png|jpe?g)$/i
const SCREENSHOT_NAME_RE = /^screen ?shot/i

/** Inside a dedicated Screenshots folder any image counts; elsewhere only
 *  Screenshot-named files, so an unrelated Desktop png is never swept in. */
export function isScreenshotFile(name: string, inDedicatedFolder: boolean): boolean {
  // macOS writes a `.sb-…` temp file before renaming into place; acting on it
  // would attach a path that is about to stop existing.
  if (name.startsWith('.')) return false
  if (!IMAGE_RE.test(name)) return false
  return inDedicatedFolder || SCREENSHOT_NAME_RE.test(name)
}

export interface ScreenshotWatchDeps {
  /** Directories to watch, each flagged as dedicated or not. */
  dirs: () => { dir: string; dedicated: boolean }[]
  watch: (dir: string, cb: (filename: string) => void) => { close: () => void }
  now: () => number
  /** False when another detector already claimed this user action. */
  claim: (hash: string, atMs: number) => boolean
  onInsert: (i: { kind: InsertKind; content: string; atMs: number }) => void
}

export function createScreenshotWatch(deps: ScreenshotWatchDeps) {
  let handles: { close: () => void }[] = []

  return {
    arm(): void {
      handles = deps.dirs().map(({ dir, dedicated }) =>
        deps.watch(dir, (filename) => {
          if (!filename || !isScreenshotFile(filename, dedicated)) return
          const path = `${dir}/${filename}`
          const atMs = deps.now()
          // Dedup by path: a tool set to write a file AND copy fires both
          // detectors for one action.
          if (!deps.claim(path, atMs)) return
          deps.onInsert({ kind: 'image', content: path, atMs })
        }),
      )
    },
    disarm(): void {
      for (const h of handles) { try { h.close() } catch { /* already gone */ } }
      handles = []
    },
  }
}
```

- [ ] **Step 4: Run and verify it passes, then commit**

```bash
cd desktop && npx tsx --test electron/remote/capture/screenshotWatch.test.ts && npm test
git add desktop/electron/remote/capture/
git commit -m "feat(capture): watch for file screenshots, event-driven

Cmd-Shift-4 is the macOS DEFAULT and never touches the pasteboard, so
changeCount alone would drop the way most people screenshot. This
replaces the 900ms readdir sweep with fs.watch: free while idle, fires
on the actual write, and that fire time IS the insert's position.
Armed only while the mic is hot."
```

---

## Task 9: Scratchpad persistence and settle

**Files:**
- Create: `desktop/electron/remote/capture/scratchpadStore.ts`
- Test: `desktop/electron/remote/capture/scratchpadStore.test.ts`

**Interfaces:**
- Consumes: `Pad` from `./types`.
- Produces: `padDirFor(root, padId)`, `serialize(pad)`, `deserialize(raw): Pad | null`, `shouldSettle(pad, now, idleMs)`, `SETTLE_IDLE_MS = 30 * 60_000`.

Disk I/O uses the house atomic pattern (write `.tmp`, then rename), as `status.json` and the curator store do.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/electron/remote/capture/scratchpadStore.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { serialize, deserialize, shouldSettle, SETTLE_IDLE_MS } from './scratchpadStore'
import { emptyPad, addSegment, addInsert } from './captureBuffer'

function full() {
  let p = emptyPad('p1', 'task', 1000)
  p = addSegment(p, { id: 's1', text: 'hello', startMs: 0, endMs: 5 })
  p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://a.com', atMs: 6 })
  return p
}

describe('round trip', () => {
  test('a pad survives serialize then deserialize intact', () => {
    const p = full()
    assert.deepEqual(deserialize(serialize(p)), p)
  })
  test('an empty pad round-trips', () => {
    const p = emptyPad('p', 'cursor', 5)
    assert.deepEqual(deserialize(serialize(p)), p)
  })
})

describe('deserialize refuses anything it does not recognise', () => {
  test('malformed json returns null rather than throwing', () => {
    assert.equal(deserialize('{not json'), null)
  })
  test('json of the wrong shape returns null', () => {
    assert.equal(deserialize('{"a":1}'), null)
  })
  test('a null entries array returns null', () => {
    assert.equal(deserialize('{"id":"a","origin":"task","createdAt":0,"updatedAt":0,"entries":null}'), null)
  })
  test('an unknown origin returns null', () => {
    assert.equal(deserialize('{"id":"a","origin":"mars","createdAt":0,"updatedAt":0,"entries":[]}'), null)
  })
})

describe('settle', () => {
  test('a pad touched recently does not settle', () => {
    const p = { ...full(), updatedAt: 1000 }
    assert.equal(shouldSettle(p, 1000 + SETTLE_IDLE_MS - 1), false)
  })
  test('a pad idle past the threshold settles', () => {
    const p = { ...full(), updatedAt: 1000 }
    assert.equal(shouldSettle(p, 1000 + SETTLE_IDLE_MS + 1), true)
  })
  test('an EMPTY pad never settles — there is nothing to keep', () => {
    const p = { ...emptyPad('p', 'task', 0), updatedAt: 0 }
    assert.equal(shouldSettle(p, SETTLE_IDLE_MS * 10), false)
  })
})
```

- [ ] **Step 2: Run and verify it fails**

Run: `cd desktop && npx tsx --test electron/remote/capture/scratchpadStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `scratchpadStore.ts`**

```ts
// Held work must survive a crash, a quit, and a restart — that promise is the
// whole reason the scratchpad exists. So the pad is written to disk as it is
// built, atomically (write .tmp, then rename), the pattern status.json and the
// curator store already use.
//
// SETTLE, DO NOT NAG. A pad pinning the pill open until Friday's draft is dealt
// with on Monday turns a calm product into a nagging one. So the CONTENT
// persists while the DEMAND FOR ATTENTION decays: past the idle threshold the
// pill goes back to normal and the pad waits on disk until the scratchpad is
// armed again. It is never auto-deleted — discard is the only way it goes away.

import type { Destination, Entry, Pad } from './types'

/** Long enough to cover stepping away from a real piece of work; short enough
 *  that a forgotten pad stops occupying the screen the same day. */
export const SETTLE_IDLE_MS = 30 * 60_000

export function padDirFor(root: string, padId: string): string {
  return `${root}/${padId}`
}

export function serialize(pad: Pad): string {
  return JSON.stringify(pad)
}

const ORIGINS: Destination[] = ['cursor', 'task']

/** Anything unrecognised returns null and the caller starts fresh. A pad is
 *  user work, so a corrupt file must never crash the app or silently deliver
 *  half a payload. */
export function deserialize(raw: string): Pad | null {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!v || typeof v !== 'object') return null
  const p = v as Partial<Pad>
  if (typeof p.id !== 'string') return null
  if (typeof p.origin !== 'string' || !ORIGINS.includes(p.origin as Destination)) return null
  if (typeof p.createdAt !== 'number' || typeof p.updatedAt !== 'number') return null
  if (!Array.isArray(p.entries)) return null
  for (const e of p.entries as Entry[]) {
    if (!e || (e.type !== 'segment' && e.type !== 'insert')) return null
    if (typeof e.id !== 'string') return null
  }
  return p as Pad
}

export function shouldSettle(pad: Pad, now: number, idleMs: number = SETTLE_IDLE_MS): boolean {
  if (pad.entries.length === 0) return false
  return now - pad.updatedAt > idleMs
}
```

- [ ] **Step 4: Run and verify it passes, then commit**

```bash
cd desktop && npx tsx --test electron/remote/capture/scratchpadStore.test.ts && npm test
git add desktop/electron/remote/capture/
git commit -m "feat(scratchpad): persist the content, let the demand for attention decay

Held work surviving a crash is the promise the feature rests on, so the
pad is written atomically as it is built. But a pill pinned open until
Monday is a nagging product, so past the idle threshold the pad settles
— content on disk, pill back to normal, picked up again on the next
arm. Never auto-deleted; discard is the only exit."
```

---

## Task 10: Settings and feature gating

**Files:**
- Modify: `desktop/electron/remote/init.ts` (settings schema and defaults, ~lines 140–190)
- Create: `desktop/electron/remote/capture/captureGate.ts`
- Test: `desktop/electron/remote/capture/captureGate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `canArmScratchpad(s)`, `canObserve(s)`, where `s = { scratchpadEnabled: boolean; captureEnabled: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/electron/remote/capture/captureGate.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { canArmScratchpad, canObserve } from './captureGate'

describe('the two axes gate independently', () => {
  test('both on: everything works', () => {
    const s = { scratchpadEnabled: true, captureEnabled: true }
    assert.equal(canArmScratchpad(s), true)
    assert.equal(canObserve(s), true)
  })

  test('scratchpad OFF does not disable capture — a copy still lands inline', () => {
    const s = { scratchpadEnabled: false, captureEnabled: true }
    assert.equal(canArmScratchpad(s), false)
    assert.equal(canObserve(s), true)
  })

  test('capture OFF does not disable the scratchpad — speech alone still builds a pad', () => {
    const s = { scratchpadEnabled: true, captureEnabled: false }
    assert.equal(canArmScratchpad(s), true)
    assert.equal(canObserve(s), false)
  })

  test('both off', () => {
    const s = { scratchpadEnabled: false, captureEnabled: false }
    assert.equal(canArmScratchpad(s), false)
    assert.equal(canObserve(s), false)
  })
})

describe('defaults are permissive', () => {
  test('undefined reads as ON for both — capture is the baseline behaviour', () => {
    const s = {} as { scratchpadEnabled: boolean; captureEnabled: boolean }
    assert.equal(canArmScratchpad(s), true)
    assert.equal(canObserve(s), true)
  })
})
```

- [ ] **Step 2: Run and verify it fails**

Run: `cd desktop && npx tsx --test electron/remote/capture/captureGate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `captureGate.ts`**

```ts
// The two axes gate independently, which is the point of keeping them separate.
//
// Capture does NOT depend on the scratchpad: with the scratchpad disabled, a
// copy made during a dictation still lands inline in the pasted text. That is
// baseline behaviour, not a scratchpad feature. And capture being off does not
// disable the scratchpad — a pad can still be built from speech alone.
//
// Both default to ON when unset, matching the existing settings convention
// where `!== false` means enabled.

export interface CaptureSettings {
  scratchpadEnabled: boolean
  captureEnabled: boolean
}

export function canArmScratchpad(s: Partial<CaptureSettings>): boolean {
  return s.scratchpadEnabled !== false
}

export function canObserve(s: Partial<CaptureSettings>): boolean {
  return s.captureEnabled !== false
}
```

- [ ] **Step 4: Add the settings to the schema in `init.ts`**

Replace the `screenshotCapture` entry (declaration ~line 143, default ~line 185) with:

```ts
  // Capture: copies and screenshots made during a hot mic land in the
  // transcript at the position they happened. Replaces `screenshotCapture`,
  // widened to cover text as well as images.
  captureEnabled: boolean
  // The scratchpad: can a capture be HELD instead of delivered on stop?
  // Independent of captureEnabled — see capture/captureGate.ts.
  scratchpadEnabled: boolean
```

Defaults:

```ts
    captureEnabled: true,
    scratchpadEnabled: true,
```

- [ ] **Step 5: Run the full suite and commit**

```bash
cd desktop && npm test
git add desktop/electron/remote/
git commit -m "feat(capture): gate the two axes independently

Turning the scratchpad off must not turn capture off — a copy still
lands inline in the pasted text, because that is baseline behaviour and
not a scratchpad feature. And capture off still permits a pad built
from speech alone. Checked at the single point where arming is
requested, so a disabled state cannot half-apply."
```

---

## Task 11: Capture seam in sessionManager

**Files:**
- Modify: `desktop/engine-overrides/electron/sessionManager.ts`
- Modify: `desktop/engine-overrides/electron/clipboard.ts`
- Create: `desktop/electron/remote/capture/index.ts` (the façade main wires to)

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: `captureSession` singleton with `beginSegment(origin)`, `endSegment()`, `attachTranscript(segId, text)`, `armScratchpad(on)`, `isArmed()`, `currentPad()`, `deliver(dest)`, `discard()`.

- [ ] **Step 1: Write the façade `capture/index.ts`**

```ts
// The single object main talks to. Everything below it is pure and tested;
// this composes it and owns the two watchers' arm/disarm lifecycle.
//
// ARM ON RECORD, DISARM ON STOP. Capture happens only while the mic is hot —
// the recording window IS the consent signal, and pausing closes it. Neither
// watcher ever runs outside a window the user deliberately opened.

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Destination, InsertKind, Pad } from './types'
import { padDirFor } from './scratchpadStore'
import { createClipboardWatch } from './clipboardWatch'
import { createScreenshotWatch } from './screenshotWatch'
import { addInsert, addSegment, emptyPad, isEmpty, removeEntry, setSegmentText } from './captureBuffer'
import { render, type RenderResult } from './insertRender'

/** Where pads live on disk. Unmute-owned, safe to delete, recreated on demand. */
export const SCRATCHPAD_ROOT = join(homedir(), '.unmute', 'remote', 'scratchpad')

let pad: Pad | null = null
let armed = false
let openSegmentId: string | null = null
let captureStartedAt = 0

// ── Injected effects ────────────────────────────────────────────────────
//
// DEPENDENCY INVERSION, NOT AN IMPORT. clipboard.ts already imports from
// remote/init, and its header records why that direction is one-way: a lazy
// require of that path fails inside the bundled main, swallowed by a fail-open
// catch ("No cycle: remote/init never imports clipboard.ts"). If the delivery
// handler imported injectOutput directly, it would close exactly that loop.
//
// So the paste effect is REGISTERED by the module that already owns it
// (sessionManager, which imports injectOutput today) and called back through
// here. No new edge in the import graph.

type PasteFn = (text: string) => Promise<void>
let pasteFn: PasteFn | null = null

export function registerPaste(fn: PasteFn): void { pasteFn = fn }

export async function pasteAtCursor(text: string): Promise<boolean> {
  if (!pasteFn) return false
  await pasteFn(text)
  return true
}

/** Read once at capture start so a mid-capture settings change cannot make a
 *  half-observed window. Registered the same way, for the same reason. */
type SettingsFn = () => { scratchpadEnabled: boolean; captureEnabled: boolean }
let settingsFn: SettingsFn | null = null

export function registerSettings(fn: SettingsFn): void { settingsFn = fn }

export function getCaptureSettings(): { scratchpadEnabled: boolean; captureEnabled: boolean } {
  return settingsFn?.() ?? { scratchpadEnabled: true, captureEnabled: true }
}

export function isArmed(): boolean { return armed }
export function currentPad(): Pad | null { return pad }
export function setArmed(on: boolean): void { armed = on }

/** A capture began. Creates the pad if there is not one already (an armed pad
 *  survives between captures and the next one appends to it). */
export function beginSegment(origin: Destination, now: number): string {
  if (!pad) pad = emptyPad(randomUUID(), origin, now)
  captureStartedAt = now
  segmentStartMs = 0
  openSegmentId = randomUUID()
  pad = addSegment(pad, {
    id: openSegmentId, text: '', startMs: segmentStartMs, endMs: segmentStartMs, now,
  })
  return openSegmentId
}

export function endSegment(now: number): void {
  openSegmentId = null
  if (pad) pad = { ...pad, updatedAt: now }
}

/** Transcription lands 30-45s after the audio, so text is attached later. */
export function attachTranscript(segmentId: string, text: string, now: number): void {
  if (pad) pad = setSegmentText(pad, segmentId, text, now)
}

/** An insert arrived from either watcher. Position is relative to capture
 *  start, so it sorts against segment times on the same clock. */
export function recordInsert(
  i: { kind: InsertKind; content: string; atMs: number },
  now: number,
): void {
  if (!pad) return
  pad = addInsert(pad, {
    id: randomUUID(), kind: i.kind, content: i.content,
    atMs: i.atMs - captureStartedAt, now,
  })
}

export function removeFromPad(id: string, now: number): void {
  if (pad) pad = removeEntry(pad, id, now)
}

/** Render and clear. Returns null when there is nothing to send. */
export function deliver(dest: Destination): RenderResult | null {
  if (!pad || isEmpty(pad)) { pad = null; return null }
  const out = render(pad, dest)
  pad = null
  armed = false
  return out
}

export function discard(): void { pad = null; armed = false }

/** Drop the segment in progress without touching the rest of the pad. Escape
 *  must cancel an utterance, never destroy held work — discard is the only
 *  path that does that, and it confirms. */
export function cancelOpenSegment(now: number): void {
  if (pad && openSegmentId) pad = removeEntry(pad, openSegmentId, now)
  openSegmentId = null
}

// ── Watchers ────────────────────────────────────────────────────────────
// Owned here so arm/disarm is one call from sessionManager and the two
// watchers can never drift out of step with each other or with the mic.

let clipboardWatch: ReturnType<typeof createClipboardWatch> | null = null
let screenshotWatch: ReturnType<typeof createScreenshotWatch> | null = null

export function initWatchers(
  cw: ReturnType<typeof createClipboardWatch>,
  sw: ReturnType<typeof createScreenshotWatch>,
): void {
  clipboardWatch = cw
  screenshotWatch = sw
}

/** Called by clipboard.ts immediately after any Unmute pasteboard write. */
export function noteOwnClipboardWrite(): void {
  clipboardWatch?.noteOwnWrite()
}

function armWatchers(padDir: string, observe: boolean): void {
  if (!observe) return
  clipboardWatch?.arm(padDir)
  clipboardWatch?.start()
  screenshotWatch?.arm()
}

function disarmWatchers(): void {
  clipboardWatch?.stop()
  clipboardWatch?.disarm()
  screenshotWatch?.disarm()
}
```

Extend `beginSegment` / `endSegment` to drive them, and have both watchers' `onInsert` call `recordInsert` (wired where the watchers are constructed, in `init.ts`):

```ts
export function beginSegment(origin: Destination, now: number, observe: boolean): string {
  if (!pad) pad = emptyPad(randomUUID(), origin, now)
  captureStartedAt = now
  openSegmentId = randomUUID()
  pad = addSegment(pad, { id: openSegmentId, text: '', startMs: 0, endMs: 0, now })
  armWatchers(padDirFor(SCRATCHPAD_ROOT, pad.id), observe)
  return openSegmentId
}

export function endSegment(now: number): void {
  disarmWatchers()
  openSegmentId = null
  if (pad) pad = { ...pad, updatedAt: now }
}
```

- [ ] **Step 2: Construct and wire the watchers in `init.ts`**

Preamble — the identifiers the two constructors need:

```ts
import { existsSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLedger, claimContent } from './capture/clipboardLedger'

// Both detectors claim against ONE ledger, because a tool set to write a file
// AND copy fires each of them for a single user action.
const sharedLedger = createLedger()

// The addon may be absent (build failure, non-mac). -1 means "cannot observe",
// which the watcher treats as never firing — the same fail-quiet posture the
// rest of the native-addon call sites take.
let nativePaste: { clipboardChangeCount(): number } | null = null
try { nativePaste = require('unmute-native-paste') } catch { nativePaste = null }

/** Tell the recorder an insert is pending so decideCut may take an early cut
 *  (Task 5). Best-effort: a missed push only costs positional precision. */
function notifyInsertDetected(): void {
  try { getWidgetWindow()?.webContents.send('capture:insert-detected') } catch { /* no window */ }
}

/** The ONE pasteboard image reader — one process, one PNG encoder. A second
 *  reader with a different encoder is the documented cause of duplicated
 *  pastes. Writes into padDir and returns the path; no baseline, no signature
 *  set, and it never clears the clipboard. */
function rescueClipboardImageViaChild(padDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    try { mkdirSync(padDir, { recursive: true }) } catch { /* exists */ }
    const dest = join(padDir, `insert-${Date.now()}.png`)
    const script = [
      'try',
      'set png to the clipboard as «class PNGf»',
      `set f to open for access POSIX file "${dest}" with write permission`,
      'set eof f to 0',
      'write png to f',
      'close access f',
      'on error',
      'end try',
    ].flatMap((l) => ['-e', l])
    execFile('osascript', script, { timeout: 5000 }, (err) => {
      if (err) { resolve(null); return }
      try { resolve(statSync(dest).size > 0 ? dest : null) } catch { resolve(null) }
    })
  })
}
```

Then the two constructors:

```ts
  // onInsert is the ONLY path from a watcher into the buffer, so position and
  // dedup are decided in one place.
  const cw = createClipboardWatch({
    changeCount: () => { try { return nativePaste.clipboardChangeCount() } catch { return -1 } },
    readText: () => clipboard.readText(),
    hasImage: () => clipboard.availableFormats().some((f) => f.startsWith('image/')),
    rescueImage: (padDir) => rescueClipboardImageViaChild(padDir),
    exists: (p) => { try { return existsSync(p.replace(/^~/, homedir())) } catch { return false } },
    now: () => Date.now(),
    onInsert: (i) => { recordInsert(i, Date.now()); broadcastScratchpad(); notifyInsertDetected() },
  })

  const sw = createScreenshotWatch({
    dirs: () => {
      const base = screenshotDir()
      return [
        { dir: base, dedicated: false },
        { dir: join(base, 'Screenshots'), dedicated: true },
        { dir: join(homedir(), 'Desktop', 'Screenshots'), dedicated: true },
      ]
    },
    watch: (dir, cb) => watch(dir, (_evt, filename) => cb(String(filename ?? ''))),
    now: () => Date.now(),
    claim: (hash, atMs) => claimContent(sharedLedger, hash, atMs),
    onInsert: (i) => { recordInsert(i, Date.now()); broadcastScratchpad(); notifyInsertDetected() },
  })

  initWatchers(cw, sw)

  // Settings read through a registered function, not an import — same
  // inversion, same reason.
  registerSettings(() => ({
    scratchpadEnabled: settings.get('scratchpadEnabled') !== false,
    captureEnabled: settings.get('captureEnabled') !== false,
  }))
```

And in `sessionManager.ts`, which already imports `injectOutput`, register the paste effect once at module init:

```ts
// The delivery handler in remote/init cannot import injectOutput without
// closing the cycle clipboard.ts's header exists to prevent. It already lives
// here, so hand it over rather than importing it there.
registerPaste(async (text: string) => { await injectOutput(text) })
```

`notifyInsertDetected()` pushes `capture:insert-detected` to the widget so the recorder sets `insertPendingRef` (Task 5, Step 5) and can take an early cut.

`rescueClipboardImageViaChild` keeps the existing `osascript` PNG dump — **exactly one reader, one encoder** — but writes into `padDir` and returns the path, with no baseline, no signature set, and no clipboard clear.

- [ ] **Step 3: Wire arm/disarm into `startSession` and `stopRecording`**

In `sessionManager.ts`, inside `startSession` after `sendToWidget('recording:start', ...)`:

```ts
    // Capture arms with the mic and disarms with it — the recording window is
    // the consent signal (spec §5.4). Fire-and-forget: a capture failure must
    // never surface on the dictation path.
    try {
      const origin = this.currentSession.kind === 'remote' ? 'task' : 'cursor'
      beginSegment(origin, Date.now(), canObserve(getCaptureSettings()))
    } catch (e) { console.warn('[session] capture arm failed:', e) }
```

In `stopRecording`, after `sendToWidget('recording:stop')`:

```ts
    try { endSegment(Date.now()) } catch (e) { console.warn('[session] capture disarm failed:', e) }
```

In `cancelSession` and `cancelSessionWithUndo`:

```ts
    // Escape kills the utterance, NEVER the pad.
    try { cancelOpenSegment(Date.now()) } catch { /* nothing open */ }
```

- [ ] **Step 4: Armed stop must not deliver**

This is the behaviour the whole feature rests on. In `processSession()`, guard **both** delivery branches — the dictation paste and the remote dispatch — before either fires:

```ts
    // ARMED: stopping KEEPS instead of sending. The transcript is attached to
    // its segment and the pad stays; nothing is pasted and nothing is
    // dispatched. Unarmed, this block is skipped entirely and delivery is
    // exactly what it is today.
    if (isArmed()) {
      attachTranscript(segmentId, cleaned, Date.now())
      session.status = 'done'
      session.output = null
      sendToWidget('scratchpad:held', session.sessionId)
      this.scheduleAutoHide(1500)
      clearTimeout(apiTimeout)
      this.abortController = null
      this.isProcessing = false
      this.resetChunkState()
      this.currentSession = null
      this.onSessionEnded?.()
      return
    }
```

`segmentId` is the value returned by `beginSegment`, held on the session so the transcript attaches to the right segment when it lands.

- [ ] **Step 5: Register our own clipboard writes**

`noteOwnClipboardWrite()` reads the change counter *at call time* and records that value. So it must be called **synchronously, with no `await` between the write and the call** — otherwise the 250ms poll can slip in between and observe our own write as a user copy.

There are **three** call sites in `clipboard.ts`, not two, and the third is the one that is easy to miss:

```ts
async function captureSelectedText(...) {
  const savedClipboard = clipboard.readText()

  clipboard.writeText('')                      // ← ours (1)
  noteOwnClipboardWrite()

  await execFile('osascript', …)               // ← synthesised ⌘C
  // (2) THE ONE THAT IS EASY TO MISS. This change is CAUSED by us but
  // PERFORMED by another process, so its counter value cannot be known in
  // advance — it can only be read after the child completes. Miss it and the
  // user's selection is inserted at the top of every single dictation, which
  // is exactly the corruption this whole design exists to prevent.
  noteOwnClipboardWrite()

  const selectedText = clipboard.readText()

  clipboard.writeText(savedClipboard)          // ← ours (3), restoring
  noteOwnClipboardWrite()
}
```

And in `injectOutput`, immediately after `clipboard.writeText(padded)`:

```ts
  clipboard.writeText(padded)
  noteOwnClipboardWrite()
```

Wrap each call so a missing watcher is harmless:

```ts
  try { noteOwnClipboardWrite() } catch { /* watcher not armed — nothing to record */ }
```

If the osascript path fails and takes its error branch, the restore write still happens — so that branch needs its own `noteOwnClipboardWrite()` too. Grep the function for every `writeText` and confirm each one is followed by a record call.

Delete the `consumeStagedForDictation()` call and the `stagedImages` variable from `injectOutput` — Task 13 removes the function itself.

- [ ] **Step 6: Verify the fast path is byte-identical**

Run the app. Dictate a sentence with no copying; the pasted text must be unchanged. Then dictate while copying a URL mid-sentence and confirm it appears inline. Then arm the scratchpad mid-dictation, stop, and confirm **nothing** is pasted or dispatched and the pill persists.

Run: `cd desktop && npm run dev`

- [ ] **Step 7: Run the full suite and commit**

```bash
cd desktop && npm test
git add desktop/electron/ desktop/engine-overrides/electron/
git commit -m "feat(capture): arm with the mic, disarm with it

The recording window is the consent signal, so both watchers arm on
record and disarm on stop — the clipboard and filesystem are never
observed outside a window the user deliberately opened. Our own two
pasteboard writes announce themselves so they can never be read back
as user copies. The unarmed fast path is untouched."
```

---

## Task 12: Delivery seam and destinations

**Files:**
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote-preload.ts`

**Interfaces:**
- Consumes: `deliver`, `discard`, `currentPad`, `setArmed` from `capture/index.ts`; `dispatchFromCapture`, `orchestrateFocusId`, `manager` (existing).
- Produces: IPC `scratchpad:get`, `scratchpad:arm`, `scratchpad:remove-entry`, `scratchpad:deliver`, `scratchpad:discard`; push `scratchpad:changed`.

- [ ] **Step 1: Add the IPC handlers to `init.ts`**

```ts
  // The pad's destinations. The set is DYNAMIC: "add to open task" appears
  // only when a task is actually focused, reusing orchestrateFocusId — the
  // short-circuit that already routes an utterance to a focused session.
  ipcMain.handle('scratchpad:get', () => {
    const pad = currentPad()
    const focused = orchestrateFocusId && manager?.get(orchestrateFocusId)
    return {
      pad,
      armed: isArmed(),
      destinations: {
        cursor: true,
        newTask: true,
        openTask: focused ? { id: focused.id, name: focused.name ?? focused.intent } : null,
      },
    }
  })

  ipcMain.handle('scratchpad:arm', (_e, on: boolean) => {
    // The single gate point, so a disabled scratchpad cannot half-apply.
    if (on && !canArmScratchpad(settings.store as never)) return false
    setArmed(!!on)
    broadcastScratchpad()
    return true
  })

  ipcMain.handle('scratchpad:remove-entry', (_e, id: string) => {
    removeFromPad(id, Date.now())
    broadcastScratchpad()
  })

  ipcMain.handle('scratchpad:discard', () => {
    discard()
    broadcastScratchpad()
  })

  ipcMain.handle('scratchpad:deliver', async (_e, dest: 'cursor' | 'newTask' | 'openTask') => {
    const out = deliver(dest === 'cursor' ? 'cursor' : 'task')
    broadcastScratchpad()
    if (!out || !out.text.trim()) return null
    // pasteAtCursor, NOT a direct injectOutput import — see the dependency
    // inversion note in capture/index.ts. Importing clipboard.ts from here
    // closes the cycle its header exists to prevent.
    if (dest === 'cursor') { return (await pasteAtCursor(out.text)) ? 'cursor' : null }
    if (dest === 'openTask' && orchestrateFocusId) {
      manager?.followUp(orchestrateFocusId, out.text)
      return orchestrateFocusId
    }
    return await dispatchFromCapture(out.text)
  })
```

- [ ] **Step 2: Add the broadcast helper**

```ts
function broadcastScratchpad(): void {
  const pad = currentPad()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('scratchpad:changed', { pad, armed: isArmed() })
  }
  notchController?.notifyScratchpadChanged(pad, isArmed())
}
```

- [ ] **Step 3: Expose the channels in `remote-preload.ts`**

```ts
  scratchpad: {
    get: () => ipcRenderer.invoke('scratchpad:get'),
    arm: (on: boolean) => ipcRenderer.invoke('scratchpad:arm', on),
    removeEntry: (id: string) => ipcRenderer.invoke('scratchpad:remove-entry', id),
    deliver: (dest: 'cursor' | 'newTask' | 'openTask') => ipcRenderer.invoke('scratchpad:deliver', dest),
    discard: () => ipcRenderer.invoke('scratchpad:discard'),
    onChanged: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s)
      ipcRenderer.on('scratchpad:changed', h)
      return () => ipcRenderer.removeListener('scratchpad:changed', h)
    },
  },
```

- [ ] **Step 4: Run the full suite and commit**

```bash
cd desktop && npm test
git add desktop/electron/
git commit -m "feat(scratchpad): deliver to a destination chosen at the end

The primary defaults to the key the capture opened with, and the pad
overrides it — bound at start, decidable at the end, which is the point
of deferring. 'Add to open task' appears only when a task is really
focused, reusing the orchestrateFocusId short-circuit rather than
inventing a second notion of where a capture lands."
```

---

## Task 13: Delete the old screenshot ledger

**Files:**
- Modify: `desktop/electron/remote/init.ts` (~lines 1010–1330)
- Modify: `desktop/engine-overrides/electron/clipboard.ts`

Removing this is the point of the rewrite: ~300 lines of provenance *inference* in the largest, most-changed, least-tested file in the repo, replaced by two exact signals.

- [ ] **Step 1: Delete the inference machinery**

Remove from `init.ts`: `probeClipboardViaChild`, `clipBaselined`, `clipStagedThisCapture`, `CLIP_PROBE_FILE`, `clipProbeBusy`, `knownClipSigs`, `sigOf`, `secureAndClearClipboard`, `stageRecentScreenshotFiles`, `stageBuffer`, `startCaptureWatch`, `stopCaptureWatch`, `purgeAutoStaged`, `captureWatchTimer`, `captureWatchGen`, `pendingClipboardCount`, `stagedAttachments`, `StagedEntry`, `takeStaged`, `typeStagedInto`, `intentWithStaged`, `consumeStagedForDictation`, `broadcastStaged`, `STAGING_DIR`.

**Keep** `screenshotDir()` — the new watcher uses it for directory resolution.

- [ ] **Step 2: Remove the calls in `broadcastCapturePhase`**

```ts
function broadcastCapturePhase(phase: CapturePhase, taskId?: string | null): void {
  captureBusy = phase !== 'idle'
  if (phase === 'listening') void pushPillChips()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:capture-phase', { phase, taskId: taskId ?? null })
  }
  notchController?.notifyCapturePhase(phase, taskId ?? null)
}
```

Capture arming now lives with the mic in `sessionManager` (Task 11), not with the routing phase — which is why this only ever worked for remote captures before.

- [ ] **Step 3: Remove the staged-tray references in `dispatchFromCaptureInner`**

Delete `const staged = takeStaged()` and the three `typeStagedInto(...)` calls. Explicit paste/drop now folds into the same buffer as an ordinary insert.

- [ ] **Step 4: Remove the dead IPC**

Delete handlers for `remote:staged-changed` and any `remote:clear-staged` / `remote:staged-*` channels, and their preload entries and Swift `clearStaged` event.

- [ ] **Step 5: Typecheck, test, and verify by hand**

```bash
cd desktop && npm run typecheck && npm test
```
Then run the app and confirm: dictate with no copying (byte-identical), with a `⌃⇧4` clipboard shot, and with a `⌘⇧4` file shot. Each lands exactly once.

- [ ] **Step 6: Commit**

```bash
git add desktop/
git commit -m "refactor(capture): delete ~300 lines of provenance guessing

All of it existed to answer 'is this image ours, and is it stale?' by
inference — hashing image heads, snapshotting the pasteboard before a
capture, clearing the clipboard afterwards. changeCount answers the
first exactly and makes the second unaskable, since provenance is now a
transition inside a consented window rather than a comparison against
what came before.

Also removes secureAndClearClipboard: once we stop depending on the
clipboard retaining anything, clearing it only destroys the user's own
content for our convenience."
```

---

## Task 14: Pill icon and pad panel (Swift)

**Files:**
- Modify: `desktop/native-notch/Sources/unmute-notch/PillView.swift`
- Create: `desktop/native-notch/Sources/unmute-notch/ScratchpadView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/IPC.swift`
- Modify: `desktop/electron/remote/notch/notch-controller.ts`

**Interfaces:**
- Consumes: `scratchpad:changed` payload `{ pad, armed }`.
- Produces: notch command `scratchpad { pad, armed, destinations }`; notch events `scratchpadArm`, `scratchpadRemove`, `scratchpadDeliver`, `scratchpadDiscard`.

- [ ] **Step 1: Add the command and events to the notch protocol**

In `notch-controller.ts`, add `scratchpad` to `NotchCommand` and the four events to `NotchEvent`, mapping each onto the same internals the IPC handlers call (Task 12) — the controller is pure orchestration over injected dependencies, so no new state lives here.

- [ ] **Step 2: Read `PillView.swift` before editing it**

It is 35 KB and already carries deliberate layout decisions ("ONE height and ONE radius for every element in the cluster", the no-drop-shadow note). Read the mic-source control's implementation and mirror its structure exactly rather than inventing a second idiom.

Run: `grep -n "micSource\|Menu\|Button" desktop/native-notch/Sources/unmute-notch/PillView.swift`

- [ ] **Step 3: Add the scratchpad icon to `PillView`**

Same cluster, same height and radius as the neighbouring controls:

```swift
// The scratchpad control. It ARMS AND DISARMS ONLY — it never sends.
// Toggle-off-to-send would be a silent commit dressed as a mode switch:
// a toggle reads as reversible, so a user tapping it to mean "never mind"
// would create a task instead. Send and discard live on the pad itself.
if state.scratchpadEnabled {
    Button {
        ipc.send(.scratchpadArm(!state.scratchpadArmed))
    } label: {
        Image(systemName: state.scratchpadArmed
              ? "note.text.badge.plus" : "note.text")
            .foregroundStyle(state.scratchpadArmed ? Color.accentColor : .secondary)
    }
    .buttonStyle(.plain)
    .frame(height: Self.clusterHeight)
    .help(state.scratchpadArmed ? "Keep on stop" : "Send on stop")
}
```

- [ ] **Step 4: Build `ScratchpadView`**

```swift
import SwiftUI

/// The pad. Appears only when there is content.
///
/// STRUCTURED ROWS, NOT PROSE. The job at review time is confirmation — are
/// the right things attached, where is this going — not proofreading words you
/// said thirty seconds ago. A continuous transcript would also be unable to
/// preview the output honestly, since rendering depends on a destination the
/// user has not picked yet.
struct ScratchpadView: View {
    let pad: ScratchpadPayload
    let destinations: Destinations
    let onRemove: (String) -> Void
    let onDeliver: (String) -> Void
    let onDiscard: () -> Void

    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(pad.entries) { entry in
                        EntryRow(
                            entry: entry,
                            isExpanded: expanded.contains(entry.id),
                            onToggle: {
                                if expanded.contains(entry.id) { expanded.remove(entry.id) }
                                else { expanded.insert(entry.id) }
                            },
                            onRemove: { onRemove(entry.id) },
                        )
                    }
                }
                .padding(8)
            }
            .frame(maxHeight: 320)

            Divider()

            HStack(spacing: 8) {
                // The primary is whichever destination the capture opened
                // with; the rest are alternatives. "Open task" is present only
                // when a task is really focused.
                ForEach(destinations.ordered, id: \.id) { d in
                    Button(d.label) { onDeliver(d.id) }
                        .buttonStyle(d.isPrimary ? .borderedProminent : .bordered)
                }
                Spacer()
                Button("Discard", role: .destructive) { onDiscard() }
            }
            .padding(8)
        }
        .frame(width: 340)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct EntryRow: View {
    let entry: ScratchpadEntry
    let isExpanded: Bool
    let onToggle: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: entry.isSegment
                      ? (isExpanded ? "chevron.down" : "chevron.right")
                      : entry.glyph)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(entry.preview)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                if let d = entry.durationLabel {
                    Text(d).font(.caption2).foregroundStyle(.tertiary)
                }
                Button(action: onRemove) { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
            .onTapGesture { if entry.isSegment { onToggle() } }

            if isExpanded {
                Text(entry.full)
                    .font(.callout)
                    .textSelection(.enabled)
                    .padding(.leading, 18)
                    .padding(.vertical, 2)
            }
        }
    }
}
```

- [ ] **Step 5: Host it in a non-activating panel**

Reuse `PillWindow`'s pattern — clicking the pad must **not** take focus, or the text insertion point the user is about to deliver into dies. Verify the panel sets the same non-activating style and `level` the pill uses, and position it adjacent to the pill's frame (`geometry.pillFrame()`), which is bottom-centre of the primary display.

- [ ] **Step 6: Verify by hand**

Build and run. Confirm: the icon arms; the pad appears with content; rows remove individually; each destination delivers; discard confirms; and — the one that matters — click the pad while a text field is focused behind it, then deliver to cursor and confirm the text still lands in that field.

- [ ] **Step 7: Commit**

```bash
git add desktop/native-notch/ desktop/electron/remote/notch/
git commit -m "feat(notch): the scratchpad icon arms, the pad sends

The icon only ever arms and disarms. Toggle-off-to-send would be a
silent commit dressed as a mode switch — a toggle reads as reversible,
so tapping it to mean 'never mind' would create a task instead. Send
and discard live on the pad, where they read as the deliberate acts
they are. Structured rows, because the job at review time is
confirmation, not proofreading words you said thirty seconds ago."
```

---

## Task 15: End-to-end verification

- [ ] **Step 1: The fast path has not moved**

Unarmed, no copying: dictate into a text field. Output byte-identical to `main`. Repeat in instruction mode (Caps Lock) and confirm the selection transform is unchanged.

- [ ] **Step 2: Capture works unarmed, in every destination**

Dictate into Slack while copying a URL mid-sentence → appears inline. Dictate a task while copying a stack trace → arrives fenced.

- [ ] **Step 3: Both screenshot paths land exactly once**

`⌃⇧4` (clipboard) and `⌘⇧4` (file) each produce one insert. With a tool configured to do both, still one.

- [ ] **Step 4: Our own writes are never observed**

Dictate with text selected (triggers the synthetic ⌘C) and confirm no insert appears. Confirm the delivered transcript does not reappear as an insert in a following capture.

- [ ] **Step 5: The scratchpad holds and accumulates**

Arm mid-dictation; stop; confirm nothing is delivered and the pill persists. Unmute again; confirm it appends. Deliver to each destination. Discard and confirm the pad is gone.

- [ ] **Step 6: Persistence and settle**

Build a pad, quit the app, reopen: the pad is still there. Leave one idle past the settle threshold: the pill returns to normal, and re-arming picks the pad back up.

- [ ] **Step 7: Gating**

`scratchpadEnabled: false` → no icon, cannot arm, stop always delivers, **and a copy still lands inline**. `captureEnabled: false` → no inserts at all, but a pad still builds from speech.

- [ ] **Step 8: Audio integrity under a long composed capture**

Record for 3+ minutes while copying repeatedly and taking screenshots. Confirm the transcript is not garbled — this is the constraint the whole detection design exists to protect.

- [ ] **Step 9: Full suite and typecheck**

```bash
cd desktop && npm run typecheck && npm test
```
Expected: 805 baseline + ~90 new tests, 0 failures.

- [ ] **Step 10: Commit**

```bash
git commit --allow-empty -m "test(capture): end-to-end verification passed

Fast path unchanged, both screenshot paths land once, our own writes
stay invisible, gating is independent, and a 3-minute composed capture
does not garble — the constraint the detection design exists to
protect."
```
