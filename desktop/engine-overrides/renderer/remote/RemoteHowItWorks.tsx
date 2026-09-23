// Unmute Orchestrator — "How it works".
//
// A calm, full-page explainer reached from the Orchestrator tab. Two jobs: teach
// what the Orchestrator does, and EARN TRUST around permissions. It is
// deliberately honest that tasks run with elevated permissions, and explains why
// that is safe (on-demand, human-driven, never an autonomous loop). It explains
// the user-facing mechanics only — never the internal routing.
//
// WHY IT LOOKS NEW. This page has been finished for a long time and no user has
// ever seen it: its only importer was a task panel that nothing imported. Its
// route is the Orchestrator tab's own "How it works" segment (launch spec
// pack-c §5) — ONE route, because the tab owns which sub-page is selected and a
// second door opened from inside the settings panel would leave that selection
// reading "Settings" while this page was on screen. Two things in its copy had
// gone stale and are corrected here: the product is no longer Claude-Code-only
// — Codex desktop has shipped since v1.4.8 — and the surface is the Orchestrator.

import { showsVendor } from './detectedAgents'
import { useDetectedVendors } from './useDetectedVendors'

interface Props {
  onBack: () => void
  /** Optional route into the setup checklist. Omitted when the caller has no
   *  way to navigate there (the panel below already carries that door), in which
   *  case the closing CTA is simply not drawn rather than being a dead button. */
  onOpenSetup?: () => void
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[13px] font-semibold text-ink mb-1.5">{title}</div>
      <div className="text-[12.5px] leading-relaxed text-ink-60 space-y-2">{children}</div>
    </div>
  )
}

export function RemoteHowItWorks({ onBack, onOpenSetup }: Props) {
  const vendors = useDetectedVendors()
  const claude = showsVendor(vendors, 'claude')
  const codex = showsVendor(vendors, 'codex')
  return (
    <div className="max-w-[640px]">
      <button
        className="text-[11px] text-ink-35 hover:text-ink mb-3 flex items-center gap-1"
        onClick={onBack}
      >
        ← Back
      </button>

      <div className="text-[16px] font-semibold text-ink mb-1">How the Orchestrator works</div>
      <div className="text-[12.5px] text-ink-35 mb-5">
        Run things on your Mac just by speaking. Hold your Orchestrator key, say what
        you want, and it gets done — the result comes back to you.
      </div>

      <Section title="It’s a remote control, not a brain">
        <p>
          Unmute has no intelligence of its own here — it&rsquo;s a remote control. All
          the thinking — understanding what you asked, working out how to do it, and
          doing it — belongs to a <b>coding agent already on your machine</b>.
        </p>
        <p>
          {claude && codex
            ? <>Today that means <b>Claude Code</b> or the <b>Codex desktop app</b>, and you
                choose which in the panel behind this page.</>
            : <>On this Mac that means <b>{claude ? 'Claude Code' : 'Codex'}</b>.</>}{' '}
          Each task card says which agent ran it and on which model, so you are never guessing.
        </p>
        <p>
          That&rsquo;s a deliberate choice. Those agents are already excellent, so we
          don&rsquo;t sit between you and them and water that down. The hard part was
          never the intelligence; it was the <b>interface</b>. Unmute makes an agent
          effortless to reach by voice — and as the agents get better, so does this,
          automatically.
        </p>
      </Section>

      <Section title="What happens when you speak a task">
        <p>
          <b>1.</b> You hold your Orchestrator key and speak a command — &ldquo;extract
          the zip I just downloaded&rdquo;, &ldquo;reply to that email&rdquo;,
          &ldquo;put on the next episode&rdquo;.
        </p>
        <p>
          <b>2.</b> Unmute hands it to your chosen agent, which does the work right on
          your machine — your files, terminal, browser, and apps.
        </p>
        <p>
          <b>3.</b> When it&rsquo;s done — or if it needs you — the result surfaces
          where you&rsquo;re already working. You never have to go hunting for it.
        </p>
        <p>
          Each command is its own task. You can fire several, keep working, and let
          them come back to you as they finish. The Orchestrator wall shows them all,
          with anything waiting on an answer lifted to the top.
        </p>
      </Section>

      <Section title="Is it safe?">
        <p>
          To actually get things done without stopping to ask you about every tiny
          step, tasks run with elevated permissions. We want to be upfront about that
          — and about why it&rsquo;s safe.
        </p>
        <p>
          <b>You&rsquo;re always the driver.</b> A task only ever does the specific
          thing you asked, when you ask it. It is <b>not</b> an autonomous agent
          looping on its own or making its own plans — every task is a single
          instruction you spoke out loud. A normal, non-destructive request
          can&rsquo;t wander off and damage your system.
        </p>
        <p>
          <b>You stay in control.</b> You can watch any task live, answer it, or stop
          it instantly. If you want tighter control, turn <b>Auto-approve actions</b>{' '}
          off for per-action prompts, or add <b>sandbox folders</b> to fence where
          tasks can reach. Both are in the panel behind this page.
        </p>
      </Section>

      <Section title="Permission prompts during a task">
        <p>
          Sometimes a task needs access to finish its job — the terminal needs to run a
          command, or a tool needs your Google account. When that happens,
          you&rsquo;ll be asked. <b>Allow it and the task continues;</b> deny it and
          that step simply can&rsquo;t complete. Nothing happens behind your back.
        </p>
      </Section>

      <Section title="Dictation is untouched">
        <p>
          None of this changes dictation. Hold-to-talk, Instruct and the pill work
          exactly the same whether or not you ever install an agent.
        </p>
      </Section>

      {onOpenSetup && (
        <div className="mt-6 pt-4 border-t border-border">
          <div className="text-[12.5px] text-ink-60 mb-2">
            {claude
              ? 'Set up an agent, and add the Claude for Chrome extension if you want browser tasks.'
              : 'Set up an agent.'}
          </div>
          <button
            className="text-[12.5px] px-3 py-1.5 rounded-full bg-ink text-white hover:opacity-90"
            onClick={onOpenSetup}
          >
            Agents &amp; setup →
          </button>
        </div>
      )}
    </div>
  )
}
