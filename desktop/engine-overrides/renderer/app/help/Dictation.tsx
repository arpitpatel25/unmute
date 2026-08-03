// Help → Dictation.
//
// SOURCES for every claim on this page:
//   keyboard.ts:22            DictationKey = 'fn' | 'right-option'
//   keyboard.ts:23            ActivationMode = tap-toggle | push-to-talk | double-tap-push
//   sessionManager.ts:2068-72 the dictation flow is NEVER sent to an LLM —
//                             "Raw-by-default … the transcript is cleaned
//                             deterministically in code"
//   cleanupPass.ts:1-18       what cleanup does and, more importantly, what it
//                             is structurally prevented from doing
//   parakeet.ts:35            the on-device model is Parakeet v3 (sherpa-onnx)
//   Settings → Behaviour      outputMode 'paste' | 'clipboard'
//
// The "transcription, not authorship" section is the load-bearing one and it is
// not marketing: acceptCleanupResult requires the cleaned text to be a pure
// DELETION of the raw text, so the app cannot reword you even if the model tries.

import { Shell, Sec, P, Lit, Note, type HelpProps } from './index'

export default function Dictation({ onBack }: HelpProps) {
  return (
    <Shell
      title="Dictation"
      standfirst="Hold a key, say the thing, and the words appear where your cursor already is."
      onBack={onBack}
    >
      <Sec title="How you use it">
        <P>
          Press your dictation key, speak, and press it again. The text is
          delivered into whatever app you were already typing in.
        </P>
        <P>
          The key is <Lit>Fn</Lit> or <Lit>Right Option</Lit>, and it can tap to
          toggle, be held down like a walkie-talkie, or do both. Settings →
          Triggers.
        </P>
      </Sec>

      <Sec title="It transcribes. It does not write.">
        <P>
          A dictation is never sent to a language model. What you said is what
          you get — the transcript is delivered as-is, cleaned only by code.
        </P>
        <P>
          If you want something rewritten, that is Instruct, and it is a
          different key. Keeping them apart is deliberate: dictation you cannot
          trust to be verbatim is not dictation.
        </P>
      </Sec>

      <Sec title="Cleanup">
        <P>
          <b>Dictation cleanup</b> removes filler words and stutters — the
          &ldquo;uh so so I I want&rdquo; that makes an accurate transcript read
          badly. It only runs when there is something to remove.
        </P>
        <P>
          It can only <i>delete</i>. The result is rejected unless every
          surviving word appears in the original, in the original order, so a
          cleanup pass can never reword you, reorder you, or add a word you did
          not say. It also has a hard time budget and falls back to your raw
          words when it runs out.
        </P>
        <Note>Settings → Audio &amp; behaviour → Dictation cleanup.</Note>
      </Sec>

      <Sec title="Where it runs">
        <P>
          <b>Cloud</b> — audio goes to our transcription service and the text
          comes back. Faster and more accurate, and it needs a subscription.
        </P>
        <P>
          <b>On-device</b> — Parakeet v3 transcribes on this Mac. No account and
          no network, at some cost in speed and accuracy. Pick the engine in
          Account → Engine; what each one does with your audio is on the Privacy
          page.
        </P>
      </Sec>

      <Sec title="Where the text lands">
        <P>
          <b>Paste at cursor</b> puts the text straight into the focused app.
          <b> Clipboard only</b> copies it and leaves the paste to you. Settings
          → Audio &amp; behaviour → Output mode.
        </P>
        <Note>
          Recent dictations are listed in History, on this Mac only, for the day
          they happened.
        </Note>
      </Sec>
    </Shell>
  )
}
