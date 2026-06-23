// Privacy tab — engine-override.
//
// Per-engine privacy posture. Stays vendor-agnostic in the copy
// (no Cloudflare / Supabase / Groq vendor names beyond what users
// directly configure themselves) — internal architecture isn't a
// user concern, but data flow is.

export default function Privacy() {
  return (
    <div className="max-w-lg">
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-2">Privacy</h2>
      <p className="text-[13px] text-ink-60 leading-relaxed mb-6">
        Your privacy depends on which engine you pick in the Account tab. Each
        option has a different posture — pick the one that
        matches what you need.
      </p>

      <PillarCard
        icon={<LaptopIcon />}
        title="On-device (whisper.cpp)"
        tag="Most private"
        tagTone="green"
        body={
          <>
            <p>
              Audio is transcribed locally by whisper.cpp on this Mac. Nothing
              is sent over the network. No account, no server, fully offline.
            </p>
            <p>
              The transcription model is downloaded once from Hugging Face on
              first setup; after that, no further network calls are made for
              dictation in this mode.
            </p>
          </>
        }
      />

      <PillarCard
        icon={<CloudIcon />}
        title="No key required"
        tag="Convenient"
        tagTone="ink"
        body={
          <>
            <p>
              Audio streams from this Mac to our service over an encrypted
              connection, gets transcribed, and the text comes back. The audio
              is discarded the moment the response is sent — we do not store
              audio anywhere. We do not store the transcribed text either.
            </p>
            <p>
              The only things we record are what we need for billing: a
              timestamp, the audio duration in seconds, the model used, and
              the resulting charge in cents. No audio, no transcripts — not
              a single bit of dictation content lives on our side.
            </p>
            <p>
              Your sign-in email is associated with your prepaid credits so
              we can debit the right account. Payments are processed by Dodo
              Payments (Merchant of Record); their privacy policy applies to
              payment data.
            </p>
          </>
        }
      />

      <h3 className="text-[10px] font-bold uppercase tracking-[0.11em] text-ink-35 mt-7 mb-2.5">
        Across all modes
      </h3>
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm divide-y divide-border">
        <BlurbRow
          title="No telemetry or analytics SDKs"
          body="The app does not include any third-party analytics, crash reporting, or product-telemetry SDKs. The only network requests it makes are to the engines you've explicitly enabled."
        />
        <BlurbRow
          title="Today's dictations cache, cleared daily"
          body="Recent dictations are kept locally so the History tab can show them — automatically cleared the next day. They never leave this Mac."
        />
        <BlurbRow
          title="Open source roots"
          body="The underlying engine is open source — you can verify exactly what gets sent where for the on-device path."
        />
      </div>
    </div>
  )
}

/* ─── Sub-components ─── */

function PillarCard({
  icon, title, tag, tagTone, body,
}: {
  icon: React.ReactNode
  title: string
  tag: string
  tagTone: 'green' | 'blue' | 'ink'
  body: React.ReactNode
}) {
  const tagClass =
    tagTone === 'green' ? 'bg-green-100 text-green-700'
      : tagTone === 'blue' ? 'bg-blue-100 text-blue-700'
        : 'bg-ink text-white'
  return (
    <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
      <div className="px-5 py-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-cream-mid border border-border flex items-center justify-center text-ink-60 shrink-0">
            {icon}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${tagClass}`}>{tag}</span>
          </div>
        </div>
        <div className="text-[12px] text-ink-60 leading-relaxed space-y-2">
          {body}
        </div>
      </div>
    </div>
  )
}

function BlurbRow({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-5 py-3.5">
      <p className="text-[13px] font-semibold text-ink mb-0.5">{title}</p>
      <p className="text-[12px] text-ink-60 leading-relaxed">{body}</p>
    </div>
  )
}

/* ─── Icons (local — sized to fit the smaller card head) ─── */

function LaptopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </svg>
  )
}

function CloudIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  )
}
