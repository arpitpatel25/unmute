import { useEffect, useReducer, useRef, useState } from 'react'

import unmuteLogo from '../assets/unmute-logo.png'
import { clipUrl } from './clips'
import { emptyPresenter, reducePresenter, type PresenterCard, type PresenterMessage } from './presenterState'
import './presenter.css'

type PresenterAction =
  | { type: 'continue' | 'retry' | 'open-settings' | 'replay-clip' | 'complete-orientation' | 'open-sign-in' }
  | { type: 'choose-provider' | 'install-provider' | 'authenticate-provider' | 'retry-provider'; provider: 'claude' | 'codex' }

type PresenterApi = {
  onboardingOnPresenterCommand?(callback: (message: PresenterMessage) => void): () => void
  onboardingPresenterAction?(action: PresenterAction): void
}

function api(): PresenterApi {
  return (window as unknown as { electronAPI?: PresenterApi }).electronAPI ?? {}
}

function ProviderButton({ provider, card }: { provider: 'claude' | 'codex'; card: NonNullable<PresenterCard> }) {
  const label = provider === 'claude' ? 'Claude Code' : 'Codex'
  const status = card.providers?.[provider] ?? { state: 'checking' as const }
  const send = (action: PresenterAction) => api().onboardingPresenterAction?.(action)
  if (status.state === 'checking') return <button type="button" disabled>Checking {label}…</button>
  if (status.state === 'installing') return <button type="button" disabled>Setting up {label}…</button>
  if (status.state === 'ready') return <button type="button" onClick={() => send({ type: 'choose-provider', provider })}>Use {label}</button>
  if (status.state === 'missing') return <button type="button" onClick={() => send({ type: 'install-provider', provider })}>Set up {label}</button>
  if (status.state === 'auth-required') return <button type="button" onClick={() => send({ type: 'authenticate-provider', provider })}>Sign in to {label}</button>
  return <button type="button" onClick={() => send({ type: 'retry-provider', provider })}>Check {label} again</button>
}

function CompanionCard({ card }: { card: NonNullable<PresenterCard> }) {
  const send = (action: PresenterAction) => api().onboardingPresenterAction?.(action)
  return <section className={`ob-presenter__card ob-presenter__card--${card.kind}`} aria-label={card.title ?? 'Next action'}>
    {card.title && <h1>{card.title}</h1>}
    {card.phrase && <blockquote>{card.phrase}</blockquote>}
    {card.detail && <p>{card.detail}</p>}
    {card.kind === 'provider' && <div className="ob-presenter__choices">
      <ProviderButton provider="claude" card={card} />
      <ProviderButton provider="codex" card={card} />
    </div>}
    {(card.kind === 'permission' || card.kind === 'repair') &&
      <button className="ob-presenter__primary" type="button" onClick={() => send({ type: card.kind === 'repair' ? 'open-settings' : 'continue' })}>
        {card.kind === 'repair' ? 'Open Keyboard Settings' : 'Continue'}
      </button>}
    {card.kind === 'success' && <button className="ob-presenter__primary" type="button" onClick={() => send({ type: card.title === 'One last step' ? 'open-sign-in' : 'complete-orientation' })}>
      {card.title === 'One last step' ? 'Sign in' : 'Explore Unmute'}
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
      <header className="ob-presenter__identity"><img src={unmuteLogo} alt="Unmute" /></header>
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
          : <div className="ob-presenter__standin"><span className="ob-presenter__logo-plate"><img src={unmuteLogo} alt="" /></span><span>Founder video will appear here</span></div>}
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
