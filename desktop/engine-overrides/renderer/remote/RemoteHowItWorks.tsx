// Unmute Remote — "How it works" page.
//
// A calm, full-page explainer reached from the Remote tab. Two jobs: teach what
// Remote does, and EARN TRUST around permissions. It is deliberately honest that
// Remote runs Claude Code with elevated permissions, and explains why that's
// safe (on-demand, human-driven, never an autonomous loop). It explains the
// user-facing mechanics only — never the internal routing/orchestration.

interface Props {
  onBack: () => void
  onOpenSetup: () => void
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[13px] font-semibold text-ink mb-1.5">{title}</div>
      <div className="text-[12px] leading-relaxed text-ink/70 space-y-2">{children}</div>
    </div>
  )
}

export function RemoteHowItWorks({ onBack, onOpenSetup }: Props) {
  return (
    <div className="p-4 max-w-[640px]">
      <button
        className="text-[11px] text-ink/50 hover:text-ink mb-3 flex items-center gap-1"
        onClick={onBack}
      >
        ← Back to tasks
      </button>

      <div className="text-lg font-semibold text-ink mb-1">How Remote works</div>
      <div className="text-[12px] text-ink/50 mb-5">
        Run things on your Mac just by speaking. Hold the Remote key, say what you
        want, and it gets done — the result comes back to you.
      </div>

      <Section title="It’s a remote, not a brain">
        <p>
          Unmute Remote has no intelligence of its own — it&rsquo;s a remote
          control. All the thinking — understanding what you asked, figuring out
          how to do it, and doing it — is <b>Claude Code</b>, Anthropic&rsquo;s
          agent running on the latest Opus model.
        </p>
        <p>
          That&rsquo;s a deliberate choice. Claude Code is already excellent — at
          everyday tasks and specialized ones alike — so we don&rsquo;t sit between
          you and it and water that down. The hard part was never the
          intelligence; it was the <b>interface</b>. Unmute makes Claude Code
          effortless to reach by voice. Claude Code does the rest — and as it gets
          better, so does Remote, automatically.
        </p>
      </Section>

      <Section title="What happens when you speak a task">
        <p>
          <b>1.</b> You hold the Remote key and speak a command — &ldquo;extract the
          zip I just downloaded&rdquo;, &ldquo;reply to that email&rdquo;,
          &ldquo;put on the next episode&rdquo;.
        </p>
        <p>
          <b>2.</b> Unmute hands it to Claude Code, which does the work right on
          your machine — your files, terminal, browser, and apps.
        </p>
        <p>
          <b>3.</b> When it&rsquo;s done — or if it needs you — the result surfaces
          where you&rsquo;re already working. You never have to go hunting for it.
        </p>
        <p>
          Each command is its own task. You can fire several, keep working, and let
          them come back to you as they finish.
        </p>
      </Section>

      <Section title="Is it safe?">
        <p>
          To actually get things done without stopping to ask you about every tiny
          step, Remote runs Claude Code with elevated permissions. We want to be
          upfront about that — and about why it&rsquo;s safe.
        </p>
        <p>
          <b>You&rsquo;re always the driver.</b> Remote only ever does the specific
          thing you asked, when you ask it. It is <b>not</b> an autonomous agent
          looping on its own or making its own plans — every task is a single
          instruction you spoke out loud. A normal, non-destructive request
          can&rsquo;t wander off and damage your system.
        </p>
        <p>
          <b>You stay in control.</b> You can watch any task live, answer it, or
          kill it instantly — including a one-click &ldquo;Kill all&rdquo;. If you
          want even tighter control, turn on <b>Ask before acting</b> for
          per-action prompts, or set <b>sandbox folders</b> to fence where tasks
          can reach. Both are in Remote settings.
        </p>
      </Section>

      <Section title="Permission prompts during a task">
        <p>
          Sometimes a task needs access to finish its job — the terminal needs to
          run a command, or a tool needs your Google account. When that happens,
          you&rsquo;ll be asked. <b>Allow it and the task continues;</b> deny it and
          that step simply can&rsquo;t complete. Nothing happens behind your back.
        </p>
      </Section>

      <div className="mt-6 pt-4 border-t border-black/10">
        <div className="text-[12px] text-ink/60 mb-2">
          Remote needs one quick thing to get started: the Claude for Chrome
          extension.
        </div>
        <button
          className="text-[12px] px-3 py-1.5 rounded-md bg-ink text-cream-mid hover:opacity-90"
          onClick={onOpenSetup}
        >
          Set up Remote →
        </button>
      </div>
    </div>
  )
}
