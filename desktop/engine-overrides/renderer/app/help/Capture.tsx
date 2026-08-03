// Help → Capture.
//
// SOURCES:
//   capture/types.ts:5      InsertKind = 'url' | 'path' | 'line' | 'block' | 'image'
//                           — the five kinds, named here exactly as the code
//                           classifies them.
//   capture/types.ts:9      Destination = 'cursor' | 'task' — the two places a
//                           capture can be delivered.
//   capture/clipboardWatch.ts:1   "Watch the pasteboard during a hot mic."
//   capture/clipboardWatch.ts:14-16  "WE NEVER MUTATE IT. There is deliberately
//                           no clear() and no write() on this surface."
//   capture/screenshotWatch.ts:1-11  file-written screenshots (⌘⇧3/4) are caught
//                           by an fs.watch that "is armed only while the mic is
//                           hot, so the filesystem is never observed outside a
//                           consented window."
//   capture/clipboardWatch.ts:8-12  content is copied into Unmute-owned storage
//                           the instant it is detected, because the pasteboard
//                           is a single slot and the next copy destroys it.
//   capture/captureGate.ts:20-22    canObserve — off means nothing is observed.
//   capture/captureGate.ts:1-9      capture and the scratchpad gate independently.
//   capture/types.ts:10-25  every timestamp is relative to the PAD, not to the
//                           capture, which is what makes ordering a numeric sort.

import { Shell, Sec, P, Li, Lit, Note, type HelpProps } from './index'

export default function Capture({ onBack }: HelpProps) {
  return (
    <Shell
      title="Capture"
      standfirst="Things you copy or screenshot while the mic is on land in the text, at the point in what you were saying where they happened."
      onBack={onBack}
    >
      <Sec title="What it is for">
        <P>
          You are dictating a message and you need to paste a link into the
          middle of it. Without capture that is: stop, paste, restart, fix the
          order. With capture you just copy the link while you keep talking, and
          it appears in the right place.
        </P>
      </Sec>

      <Sec title="The boundary">
        <P>
          <b>Unmute looks at your clipboard only while the mic is on.</b> The
          watcher is started when a recording starts and stopped when it ends.
          Nothing you copy before or after a dictation is seen, stored or
          referred to.
        </P>
        <P>
          It never writes to your clipboard either. There is deliberately no
          way for this part of the app to clear or replace what you have copied —
          the only thing unmute ever puts on the pasteboard is the text it is
          delivering to you.
        </P>
        <P>
          Screenshots taken with <Lit>⌘⇧3</Lit> / <Lit>⌘⇧4</Lit> never touch the
          clipboard at all, so those are picked up by watching your screenshot
          folder — and that watcher is armed only while the mic is on, too.
        </P>
        <Note>
          Switch Capture off in Settings → Audio &amp; behaviour and neither
          watcher ever starts.
        </Note>
      </Sec>

      <Sec title="The five kinds">
        <P>Whatever you capture is classified as one of five things, and each is rendered to suit:</P>
        <Li>
          <li><Lit>url</Lit> — a link</li>
          <li><Lit>path</Lit> — a file or folder path</li>
          <li><Lit>line</Lit> — a single line of text</li>
          <li><Lit>block</Lit> — several lines, kept as a block</li>
          <li><Lit>image</Lit> — a screenshot or copied image</li>
        </Li>
      </Sec>

      <Sec title="The two destinations">
        <P>
          <Lit>cursor</Lit> — the whole thing, speech and captures in order, is
          pasted where you are typing.
        </P>
        <P>
          <Lit>task</Lit> — it goes to the orchestrator as a task instead, with
          the captures attached. Which one you get is set by the key you started
          with, and you can change it before you deliver.
        </P>
      </Sec>

      <Sec title="Order is kept">
        <P>
          A capture is stamped with the moment it happened, measured against the
          start of the pad rather than the start of the recording. That is what
          lets a single delivery hold several recordings and still come out in
          the order you lived it.
        </P>
      </Sec>
    </Shell>
  )
}
