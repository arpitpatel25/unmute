// Help → Orchestrator.
//
// SOURCES:
//   keyboard.ts:14-19        the orchestrator trigger is its own key, and it is
//                            push-to-talk: `remote-start` on press, `remote-stop`
//                            on release. It is the key dictation is NOT using.
//   keyboard.ts:396-401      mutual exclusion — the instruction key is ignored
//                            while an orchestrator capture is running.
//   remote/setup-status.ts:119-133   the two backends: the Claude Code CLI, and
//                            the Codex desktop app, which "Unmute drives … so it
//                            must be installed at that exact path". Both are
//                            programs on this Mac.
//   remote/init.ts:3376-3379 overlayAutoPresent — the surface presents itself on
//                            terminal and attention states; init.ts:785 is the
//                            gate the Appearance & notch toggle writes.
//   native-notch/…/main.swift:3-11  the notch runs as an .accessory app that
//                            "never becomes active, so it can never steal focus
//                            from the user's foreground app".
//   RemoteHowItWorks.tsx     the elevated-permissions posture, stated there in
//                            full; this page says it plainly and points at it.
//
// NOT CLAIMED: anything about unmute learning from the tasks you run (D7 — the
// curator and the librarian are off, so it does not).

import { Shell, Sec, P, Note, type HelpProps } from './index'

export default function Orchestrator({ onBack }: HelpProps) {
  return (
    <Shell
      title="Orchestrator"
      standfirst="Say what you want done and an agent does it on this Mac, while you carry on with something else."
      onBack={onBack}
    >
      <Sec title="Who is actually driving">
        <P>
          Unmute has no intelligence of its own here. The thinking and the doing
          are <b>Claude Code</b> or the <b>Codex desktop app</b> — whichever you
          pick — running on this machine, under your account, with your logins.
        </P>
        <P>
          Unmute is the interface: it hears you, starts the task, watches it, and
          brings it back. Your tasks are not sent to us and are not run on our
          machines.
        </P>
      </Sec>

      <Sec title="Why voice">
        <P>
          The work an agent is good at — extract that archive, reply to that
          thread, put the next episode on — is work you think of while doing
          something else. Typing it means stopping, finding a window and
          switching context, which costs more than the errand is worth.
        </P>
        <P>
          So the orchestrator sits on a key. Hold it, say the thing, let go. It
          is push-to-talk on the key dictation is not using, so the two never
          collide.
        </P>
      </Sec>

      <Sec title="Why the notch">
        <P>
          Once a task is running you should not have to go and look at it, but
          you do need to know when it needs you. The notch is a surface with no
          window and no dock icon — it can never take focus from what you are
          doing — that shows the state of your tasks and comes forward when one
          finishes or gets stuck.
        </P>
        <Note>
          Settings → Appearance &amp; notch controls whether it comes forward by
          itself, and what it is made of.
        </Note>
      </Sec>

      <Sec title="It runs with real permissions">
        <P>
          To finish a job without stopping to ask about every step, the agent
          runs with elevated permissions on your Mac. We would rather say that
          plainly than bury it.
        </P>
        <P>
          What keeps it safe is that you are the one driving: every task is a
          single thing you asked for out loud, not a loop making its own plans.
          You can watch any task, answer it or kill it, turn on a prompt before
          each action, or fence tasks into specific folders.
        </P>
        <Note>
          The full account, including what happens when a task asks for
          something, is in Orchestrator → How it works.
        </Note>
      </Sec>
    </Shell>
  )
}
