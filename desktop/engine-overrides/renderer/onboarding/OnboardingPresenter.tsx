import { useEffect, useReducer, useRef, useState } from 'react'

import { clipUrl } from './clips'
import { emptyPresenter, reducePresenter, type PresenterCard, type PresenterMessage } from './presenterState'
import './presenter.css'

type PresenterAction =
  | { type: 'continue' | 'retry' | 'open-settings' | 'replay-clip' }
  | { type: 'choose-provider'; provider: 'claude' | 'codex' }

type PresenterApi = {
  onboardingOnPresenterCommand?(callback: (message: PresenterMessage) => void): () => void
  onboardingPresenterAction?(action: PresenterAction): void
}

function api(): PresenterApi {
  return (window as unknown as { electronAPI?: PresenterApi }).electronAPI ?? {}
}

function UnmuteGlyph() {
  return <span className="ob-presenter__glyph" aria-hidden="true">un</span>
}

function CompanionCard({ card }: { card: NonNullable<PresenterCard> }) {
  const send = (action: PresenterAction) => api().onboardingPresenterAction?.(action)
  return <section className={`ob-presenter__card ob-presenter__card--${card.kind}`} aria-label={card.title ?? 'Next action'}>
    {card.title && <h1>{card.title}</h1>}
    {card.phrase && <blockquote>{card.phrase}</blockquote>}
    {card.detail && <p>{card.detail}</p>}
    {card.kind === 'provider' && <div className="ob-presenter__choices">
      <button type="button" onClick={() => send({ type: 'choose-provider', provider: 'claude' })}>Claude Code</button>
      <button type="button" onClick={() => send({ type: 'choose-provider', provider: 'codex' })}>Codex</button>
    </div>}
    {(card.kind === 'permission' || card.kind === 'repair') &&
      <button className="ob-presenter__primary" type="button" onClick={() => send({ type: card.kind === 'repair' ? 'retry' : 'continue' })}>
        {card.kind === 'repair' ? 'Try again' : 'Continue'}
      </button>}
  </section>
}

export function OnboardingPresenter() {
  const [state, dispatch] = useReducer(reducePresenter, undefined, emptyPresenter)
  const [paused, setPaused] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => api().onboardingOnPresenterCommand?.(dispatch), [])

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const replay = () => {
    const video = videoRef.current
    if (video) { video.currentTime = 0; void video.play() }
    api().onboardingPresenterAction?.({ type: 'replay-clip' })
  }

  return <main className="ob-presenter" data-action={state.action}>
    <section className="ob-presenter__glass">
      <header className="ob-presenter__identity"><UnmuteGlyph /><span>Unmute</span></header>
      <div className="ob-presenter__film">
        {!state.videoUnavailable && state.clipId
          ? <video
              ref={videoRef}
              key={state.clipId}
              src={clipUrl(state.clipId)}
              autoPlay
              playsInline
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
              onError={() => dispatch({ type: 'video-unavailable' })}
            />
          : <div className="ob-presenter__standin"><UnmuteGlyph /><span>Founder video will appear here</span></div>}
        <div className="ob-presenter__filmshade" />
        <div className="ob-presenter__caption" aria-live="polite">{state.caption || 'Preparing your introduction…'}</div>
      </div>
      <footer className="ob-presenter__controls">
        <button type="button" onClick={togglePlayback}>{paused ? 'Play' : 'Pause'}</button>
        <button type="button" onClick={replay}>Replay</button>
        <span className="ob-presenter__status">{state.videoUnavailable ? 'Script mode' : 'Captions on'}</span>
      </footer>
    </section>
    {state.card && <CompanionCard card={state.card} />}
  </main>
}
