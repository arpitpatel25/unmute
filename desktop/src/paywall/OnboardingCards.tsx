// Onboarding overlay — 3 cards letting the user pick how they want to use unmute.
// Shown in the onboarding flow, AFTER the existing Mic + Accessibility steps.

import { useState } from 'react'

type Choice = 'managed' | 'local'

interface Props {
  onComplete: (choice: Choice) => void
}

export function OnboardingCards({ onComplete }: Props) {
  const [hovered, setHovered] = useState<Choice | null>(null)

  return (
    <div className="max-w-xl">
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-2">
        How do you want to use unmute?
      </h2>
      <p className="text-[13px] text-ink-60 mb-6">
        Pick one. You can change it any time in Settings → Engine.
      </p>

      <div className="flex flex-col gap-3">
        <Card
          title="Managed (recommended for most)"
          tag="Convenience"
          description="Sign in, subscribe, and transcription routes through our cloud. Fast, accurate, zero setup. From $5.99/mo vs $12/mo for WisprFlow."
          accent="ink"
          onHover={() => setHovered('managed')}
          onLeave={() => setHovered(null)}
          onPick={() => onComplete('managed')}
          highlighted={hovered === null || hovered === 'managed'}
        />
        <Card
          title="Local (fully offline)"
          tag="Privacy"
          description="On-device whisper.cpp. Slower, but works offline and your voice never leaves your Mac. ~75MB model download."
          accent="success"
          onHover={() => setHovered('local')}
          onLeave={() => setHovered(null)}
          onPick={() => onComplete('local')}
          highlighted={hovered === null || hovered === 'local'}
        />
      </div>
    </div>
  )
}

function Card({
  title,
  tag,
  description,
  accent,
  onHover,
  onLeave,
  onPick,
  highlighted,
}: {
  title: string
  tag: string
  description: string
  accent: 'ink' | 'warm' | 'success'
  onHover: () => void
  onLeave: () => void
  onPick: () => void
  highlighted: boolean
}) {
  const accentColor = accent === 'ink' ? 'bg-ink' : accent === 'warm' ? 'bg-warm' : 'bg-green-600'
  return (
    <button
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onPick}
      className={`text-left px-5 py-4 rounded-2xl border bg-white transition-all ${
        highlighted ? 'border-ink shadow-md' : 'border-border opacity-60'
      } hover:border-ink`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white ${accentColor}`}>
          {tag}
        </span>
        <span className="text-[14px] font-bold text-ink">{title}</span>
      </div>
      <p className="text-[12px] text-ink-60 leading-relaxed">{description}</p>
    </button>
  )
}
