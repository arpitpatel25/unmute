// Help → Unmute Agent.
//
// Written from what the Agent actually does, not from what it was hoped it
// would do. Every claim here is checkable in the code:
//
//   agent/constitution.ts        what it is told about itself, verbatim
//   agent/caption.ts             one line, ≤200 chars, 2.5–8s dwell
//   agent/capabilities/*.ts      the 21 tools and their consequence classes
//   providers/claude-headless.ts the allowlist and the denylist, with reasons

import { Shell, Sec, P, Note, type HelpProps } from './index'

export default function Agent({ onBack }: HelpProps) {
  return (
    <Shell
      title="Unmute Agent"
      standfirst="Everything else in Unmute talks to your coding agents. This talks to Unmute — what it remembers for you, what you have been working on, and what to pick back up."
      onBack={onBack}
    >
      <Sec title="It has its own key">
        <P>
          Double-tap <strong>Right Command</strong> and speak. Tap Right Command
          once when you are ready to send. That is deliberately a
          different key from dictation and from Remote, so adding an agent could
          not change either — and so a sentence addressed to Unmute can never be
          mistaken for one addressed to a session.
        </P>
        <P>
          The answer arrives as a caption: one line, low on the screen, gone in
          a few seconds. Not a window, not a panel, not a notification you
          expand. A caption belongs to the machine — you asked your computer
          something and your computer answered.
        </P>
        <Note>
          When the answer is genuinely longer than a line — a summary you asked
          for rather than a confirmation — the caption is held open until you
          dismiss it instead of vanishing.
        </Note>
      </Sec>

      <Sec title="It is your session manager">
        <P>
          A session does the work. The Unmute Agent helps you find and manage
          sessions. Ask it when you cannot remember where some work lives, when
          several sessions are involved, or when you want to resume or create
          the right session without choosing it yourself.
        </P>
        <Note>
          Try: “Find the session that was fixing checkout, resume it, and tell
          it what we decided in today’s meeting.”
        </Note>
      </Sec>

      <Sec title="It knows what you have been working on">
        <P>
          Every coding session on this Mac is on disk — whichever agent ran it,
          the ones Unmute started and the ones you ran yourself in a
          terminal. The Agent reads those transcripts directly when you refer
          to work you have already done.
        </P>
        <P>
          That is what lets you say <em>“carry on with the migration”</em> or{' '}
          <em>“add a row to that sheet we made”</em> without naming a session.
          You should not have to remember which window a thing happened in.
        </P>
        <P>
          Picking work back up is ordinary: it finds the session and reopens
          it, with its whole history intact, as a card you can watch. Asked to
          continue in a different harness, it starts a fresh session there
          carrying what the old one was about — and says so honestly, because
          the original is still exactly where you left it.
        </P>
      </Sec>

      <Sec title="Nothing reads your sessions in the background">
        <P>
          A transcript is opened <strong>only when you ask for something that
          needs it</strong>. There is no scheduled job, no rolling window and
          no summary index kept up to date behind you — an earlier version had
          one, and it spent your own CLI usage re-reading work nobody had asked
          about.
        </P>
        <Note>
          Reopening a session you ran yourself starts a fork of it: the new card
          inherits the whole conversation, and your original session stays
          exactly as it was.
        </Note>
      </Sec>

      <Sec title="What it can and cannot do">
        <P>
          It can read: your memory, your session transcripts, your meeting
          notes, and what you dictated recently. It can keep things for you,
          put something on your clipboard, open a file, and create tasks.
        </P>
        <P>
          It cannot run a shell, write a file, or reach the network. Anything
          that touches the world beyond Unmute — sending a message, driving an
          app, writing code — becomes a task you can watch, and it will tell you
          it made one rather than claiming the thing is done.
        </P>
        <Note>
          Everything it reads is treated as evidence about you, never as
          instructions to it. A note that tells it how to behave is something it
          keeps for you, not something it obeys.
        </Note>
      </Sec>

      <Sec title="Its memory is yours">
        <P>
          What you ask it to keep is encrypted on this Mac, with the key held in
          your macOS Keychain. Nothing is sent anywhere. Forgetting moves a
          record to a recoverable trash rather than destroying it, and every
          change is versioned.
        </P>
        <P>
          You can see everything it holds, and remove any of it, from the memory
          view — it is a store you can inspect, not a black box that accumulates.
        </P>
      </Sec>
    </Shell>
  )
}
