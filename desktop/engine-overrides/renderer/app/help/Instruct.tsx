// Help → Instruct.
//
// DECISION D2 LANDS HERE. The Features tab (Voice.tsx, in the OSS engine) was
// deleted in this release. Almost everything on it is said better by the
// Dictation page — except CHAINING, which is genuinely useful and was
// documented nowhere else in the product. It is the "Chain them" section below,
// and it is the reason this page exists rather than a paragraph on Dictation.
//
// SOURCES:
//   keyboard.ts:419-428   the live chain: pressing the instruction key while a
//                         dictation is recording emits `session-stop` for the
//                         dictation and `chain-start` for the instruction, in
//                         that order, with no gap — "Dictation STOPPED (direct
//                         chain to instruction)" / "Instruction CHAIN-START".
//   keyboard.ts:359-366   the same thing in the other direction.
//   keyboard.ts:410-416   pressing it again while the instruction is recording
//                         just stops it, and processing starts immediately.
//   sessionManager.ts:41  the five flows: dictation | transform | quote |
//                         context | instruction. Which one runs depends on
//                         whether there was a selection.
//   sessionManager.ts:909-921  the selection is read after the HUD appears.
//   Settings → Triggers   paywallGetInstructionEnabled / SetInstructionEnabled.
//
// NOT CLAIMED HERE, deliberately: any specific window of time after a dictation
// ENDS in which you can still chain. `stopDictation` emits `chain-expired`
// immediately (keyboard.ts:386-392), so the deferred window in that file is not
// live. The chain that works is the one described below — press the second key
// while the first is still recording.

import { Shell, Sec, P, Lit, Note, type HelpProps } from './index'

export default function Instruct({ onBack }: HelpProps) {
  return (
    <Shell
      title="Instruct"
      standfirst="Select something, say what to do with it, and get the result back in its place."
      onBack={onBack}
    >
      <Sec title="How you use it">
        <P>
          Select some text. Press <Lit>Caps Lock</Lit>, say what you want done
          with it — &ldquo;make this two sentences&rdquo;, &ldquo;turn this into
          a bulleted list&rdquo; — and press it again.
        </P>
        <P>
          The selection and your instruction go to the model together, and the
          result is delivered the same way a dictation is: pasted at your cursor,
          or copied, depending on your output mode.
        </P>
        <P>
          With nothing selected, it acts on what you say alone. That is the
          difference between the two keys: dictation writes down your words,
          Instruct does something with them.
        </P>
      </Sec>

      <Sec title="Chain them">
        <P>
          The two keys chain. Start dictating with your dictation key, and while
          the mic is <i>still running</i> press <Lit>Caps Lock</Lit>. The
          dictation closes and the instruction opens in the same breath, so what
          you just said becomes the thing being reshaped — no selecting, no
          pause, no second thought about it.
        </P>
        <P>
          Speak the draft, then immediately say what to do with it. It works in
          the other direction too: press the dictation key during an instruction
          and the instruction closes and dictation takes over.
        </P>
        <Note>
          Press the same key again instead and it simply stops, and processing
          starts straight away.
        </Note>
      </Sec>

      <Sec title="Turning it off">
        <P>
          Caps Lock is a real key that people really use. Switch Instruct off in
          Settings → Triggers and Caps Lock goes back to being Caps Lock —
          nothing is intercepted.
        </P>
      </Sec>
    </Shell>
  )
}
