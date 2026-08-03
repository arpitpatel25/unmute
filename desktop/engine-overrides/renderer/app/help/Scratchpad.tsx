// Help → Scratchpad.
//
// The reasoning on this page is LIFTED, not invented. It already existed as
// design commentary in two files and had simply never been said to a user:
//
//   capture/scratchpadStore.ts:1-4   "Held work must survive a crash, a quit,
//                                    and a restart — that promise is the whole
//                                    reason the scratchpad exists." Written to
//                                    disk as it is built, atomically.
//   capture/scratchpadStore.ts:6-10  "SETTLE, DO NOT NAG… the CONTENT persists
//                                    while the DEMAND FOR ATTENTION decays…
//                                    It is never auto-deleted — discard is the
//                                    only way it goes away."
//   capture/scratchpadStore.ts:17-19 SETTLE_IDLE_MS = 30 minutes.
//   ScratchpadView.swift:3-11        "THE PAD IS PAPER, NOT APP CHROME… it is
//                                    off-white card stock with ink on it — and
//                                    it stays that way in BOTH system
//                                    appearances, because paper does not have a
//                                    dark mode."
//   capture/captureGate.ts:1-9       the pad and capture gate independently: a
//                                    pad can be built from speech alone.

import { Shell, Sec, P, Note, type HelpProps } from './index'

export default function Scratchpad({ onBack }: HelpProps) {
  return (
    <Shell
      title="Scratchpad"
      standfirst="A place for dictation to accumulate, so you can decide where it goes after you have said it rather than before."
      onBack={onBack}
    >
      <Sec title="It holds instead of delivering">
        <P>
          Normally a dictation is delivered the moment you stop. Arm the
          scratchpad from the icon on the recording pill and it is held instead:
          you can keep adding to it across several recordings, and nothing is
          sent anywhere until you press a destination on the pad.
        </P>
        <P>
          Arming only ever holds. There is no arrangement of the pad in which
          pressing the trigger sends something you have not chosen to send.
        </P>
      </Sec>

      <Sec title="It survives">
        <P>
          Held work survives a crash, a quit and a restart. That promise is the
          whole reason the scratchpad exists — a place you are afraid to leave
          things is not a place you will leave things — so the pad is written to
          disk as it is built, not when it is closed.
        </P>
      </Sec>

      <Sec title="It settles, it does not nag">
        <P>
          A pad that pinned the pill open until Friday&rsquo;s draft was dealt
          with on Monday would turn a calm product into a nagging one. So the
          content persists while the demand for your attention decays: after
          half an hour idle the pill goes back to normal and the pad waits
          quietly on disk until you arm the scratchpad again.
        </P>
        <Note>A pad is never deleted on its own. Discard is the only way it goes away.</Note>
      </Sec>

      <Sec title="The pad is paper, not chrome">
        <P>
          Everything else in the cluster is glass — a lens over your desktop that
          belongs to the instrument. The pad is the one surface holding your own
          words, and a note is a thing people already know how to read. So it is
          off-white card stock with ink on it, in light mode and dark mode alike,
          because paper does not have a dark mode.
        </P>
      </Sec>

      <Sec title="It is independent of Capture">
        <P>
          The two switches do not depend on each other. With Capture off you can
          still build a pad out of speech; with the scratchpad off, things you
          copy during a dictation still land inline in the delivered text.
        </P>
      </Sec>
    </Shell>
  )
}
