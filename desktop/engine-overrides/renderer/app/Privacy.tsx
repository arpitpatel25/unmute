// Privacy — a Settings SECTION (it used to be a top-level tab).
//
// EVERY SENTENCE ON THIS PAGE IS SOURCED. Decision D3 traced the old page
// through the backend and found three things wrong with it, all of which are
// fixed here:
//
//   1. It described the pay-per-use balance the app stopped running. Migration
//      012_retire_payperuse.sql retired that model; 011_subscriptions.sql is
//      what actually bills now. The whole paragraph is gone rather than patched.
//   2. It claimed a single daily wipe covering everything the app stores. Two
//      different things are kept, for two different lengths of time: History is
//      same-day (db.ts:238-239, a 24h cutoff) and diagnostics are SEVEN days
//      (dictationTelemetry.ts:20, KEEP_DAYS = 7). Stated separately below,
//      because one number for both was simply wrong.
//   3. "No telemetry or analytics SDKs" stood alone. It is literally true — the
//      app bundles no third-party analytics — but it reads as "nothing is
//      recorded", while the app does keep local diagnostics. It is now stated
//      together with what IS kept, which is the honest version.
//
// And one thing was missing entirely: the orchestrator, which is the biggest
// data-flow question in the product. It has its own group now.
//
// THE EVIDENCE, claim by claim:
//   "we do not store your transcripts / audio"
//       backend/supabase/migrations/008_billing_reconcile.sql:49-70 — log_usage
//       takes user_id, call_type, flow_type, provider, model, prompt_tokens,
//       completion_tokens, audio_duration_seconds, estimated_cost, latency_ms,
//       and inserts exactly those. No transcript column, no audio column. A grep
//       for "transcript" across backend/ returns nothing outside node_modules.
//   "on-device is offline"
//       engine-overrides/electron/parakeet.ts:35 — the model is fetched once
//       from a release URL; transcription itself is local.
//   "diagnostics never leave this Mac"
//       engine-overrides/electron/dictationTelemetry.ts:1 — JSONL under
//       <userData>/telemetry/. There is no fetch, upload or post anywhere in
//       that file or in anything that calls it.
//   "diagnostics contain no transcript text"
//       dictationTelemetry.ts:12-18 — DEV_BUILD is false in production, and
//       transcript text is only included when it is true.
//   "seven days"        dictationTelemetry.ts:20 — KEEP_DAYS = 7.
//   "History is same-day"  engine-overrides/electron/db.ts:238-239 — every open
//       and every save deletes rows older than 24 hours (and caps at 100).
//   "the agent runs here, under your account"
//       electron/remote/setup-status.ts:119-133 — both backends are programs
//       installed on this Mac (the Claude Code CLI; the Codex desktop app,
//       which "Unmute drives" in place).
//   "elevated permissions"
//       stated in RemoteHowItWorks.tsx and repeated here rather than left on a
//       page most people will not open.
//   "Dodo Payments"
//       backend/supabase/migrations/007_dodo_webhook_rpcs.sql and
//       011_subscriptions.sql (dodo_subscription_id, dodo_customer_id).
//
// If you change a sentence here, change the source comment with it. A privacy
// page that has drifted from the code is worse than no privacy page.

import React from 'react'

export default function Privacy({ onOpenMemory }: { onOpenMemory?: () => void }) {
  return (
    <div>
      <p className="text-[13px] text-ink-60 leading-relaxed mb-6">
        Every feature is listed below with one thing made explicit: whether it
        sends anything off this Mac, and if so, exactly what.
      </p>

      {/* ═══ Dictation ═══ */}
      <GroupHeader title="Dictation" />
      <Card>
        <Row
          title="Cloud transcription"
          flow="leaves"
          body={
            <>
              {/* SOURCE: backend/cloudflare/shared/groq.ts:8 (GROQ_STT_URL);
                  pipeline/src/index.ts:231,239 posts the audio blob there.
                  The audio reaches a THIRD PARTY. We can only speak for our own
                  infrastructure, so this names the processor and claims nothing
                  about theirs. Do NOT restore "our transcription service" — it
                  reads as first-party, and it is not. */}
              <p>
                Your audio is sent over an encrypted connection to{' '}
                <span className="font-semibold text-ink">Groq</span>, the
                speech-to-text provider we use, and the text comes back. Groq
                handles it under their own privacy policy. On our side the audio
                is never written down — it is held only for the length of the
                request.
              </p>
              <p>
                We record what we need to bill you and nothing else: a
                timestamp, how many seconds of audio, which model ran, how long
                it took, and what it cost. There is no column for a transcript
                and no column for audio — not a word of what you said reaches
                our side.
              </p>
            </>
          }
        />
        <Row
          title="On-device transcription"
          flow="stays"
          body={
            <>
              <p>
                Parakeet v3 transcribes on this Mac. No account, no server,
                nothing sent. The model itself is downloaded once during setup;
                after that, dictating in this mode makes no network calls at all.
              </p>
            </>
          }
          divider
        />
      </Card>

      {/* ═══ Orchestrator ═══ */}
      <GroupHeader title="Orchestrator" />
      <Card>
        <Row
          title="Your tasks never reach us"
          flow="stays"
          body={
            <>
              <p>
                The agent is the coding agent already on this Mac, running
                under your own account and your own logins. What you ask
                for, what it reads and what it produces stay between you, your
                machine and whichever agent you signed in to.
              </p>
              <p>
                Unmute starts the task and reports on it. It is not a place your
                work is sent.
              </p>
            </>
          }
        />
        <Row
          title="Agents run with elevated permissions"
          flow="local-risk"
          body={
            <>
              <p>
                To finish a job without stopping at every step, the agent runs
                with elevated permissions on this Mac — it can read and change
                your files and drive your apps. We would rather say that plainly
                than leave you to discover it.
              </p>
              <p>
                Every task is a single thing you asked for out loud, and you can
                watch it, answer it or kill it. You can also require a prompt
                before each action, or fence tasks into specific folders.
                Orchestrator → How it works has the full account.
              </p>
            </>
          }
          divider
        />
      </Card>

      {/* ═══ Everything else ═══ */}
      <GroupHeader title="Everything else" />
      <Card>
        <button
          type="button"
          onClick={onOpenMemory}
          className="w-full px-5 py-4 text-left flex items-center justify-between gap-4 hover:bg-cream-mid transition-colors"
        >
          <span>
            <span className="block text-[13px] font-semibold text-ink">What Unmute keeps</span>
            <span className="block text-[12.5px] text-ink-60 leading-relaxed mt-1">Inspect saved memory, see where it came from, or move it to Trash.</span>
          </span>
          <span className="text-[13px] text-ink-35 shrink-0">›</span>
        </button>
        <Row
          title="History"
          flow="stays"
          body={
            <p>
              Recent dictations are stored on this Mac so History can show them.
              Anything older than a day is deleted automatically, and it is never
              uploaded.
            </p>
          }
          divider
        />
        <Row
          title="Diagnostics"
          flow="stays"
          body={
            <>
              <p>
                The app keeps a local log of how each dictation was served —
                which engine, how long it took, why a recording was cut. It is
                what makes a bad dictation explainable after the fact.
              </p>
              <p>
                It is written to a file on this Mac, kept for <b>seven days</b>,
                and then deleted. There is no code path anywhere in the app that
                uploads it, and in a release build it contains no transcript
                text.
              </p>
              <p>
                Unmute bundles no third-party analytics, crash-reporting or
                product-telemetry SDK. These local diagnostics are the only thing
                of that kind it keeps, and they stay here.
              </p>
            </>
          }
          divider
        />
        <Row
          title="Billing"
          flow="leaves"
          body={
            <p>
              Your sign-in email and your subscription status. Payments are
              processed by Dodo Payments as merchant of record; their privacy
              policy covers payment details, which we never see.
            </p>
          }
          divider
        />
      </Card>
    </div>
  )
}

/* ─── Sub-components ───
 *
 * The badge is the point of the page. Each row states, in the same place every
 * time, whether that feature sends anything off the machine — so the question
 * can be answered by scanning rather than by reading. */

type Flow = 'stays' | 'leaves' | 'local-risk'

const FLOW: Record<Flow, { label: string; className: string }> = {
  stays: { label: 'Stays on this Mac', className: 'bg-success-soft text-success' },
  leaves: { label: 'Leaves this Mac', className: 'bg-ink text-white' },
  'local-risk': { label: 'On this Mac, with real access', className: 'bg-warm-soft text-warm' },
}

function GroupHeader({ title }: { title: string }) {
  return (
    <h3 className="text-[10px] font-bold text-ink-35 uppercase tracking-[0.11em] mb-2.5 mt-5 first:mt-0">
      {title}
    </h3>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
      {children}
    </div>
  )
}

function Row({ title, flow, body, divider }: {
  title: string
  flow: Flow
  body: React.ReactNode
  divider?: boolean
}) {
  const badge = FLOW[flow]
  return (
    <div className={`px-5 py-4 ${divider ? 'border-t border-border' : ''}`}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      <div className="text-[12.5px] text-ink-60 leading-relaxed space-y-2">{body}</div>
    </div>
  )
}
