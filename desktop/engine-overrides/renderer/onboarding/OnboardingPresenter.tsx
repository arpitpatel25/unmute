import { useEffect, useReducer, useRef, useState } from 'react'

import unmuteLogo from '../assets/unmute-logo.png'
import { clipUrl } from './clips'
import { canSkipAction, clipEndActionFor, successButtonForAction } from './presenterActions'
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

function CompanionCard({ action, card, reviewing, phase }: { action: string; card: NonNullable<PresenterCard>; reviewing: boolean; phase?: 'ready' | 'listening' | 'processing' }) {
  const send = (action: PresenterAction) => api().onboardingPresenterAction?.(action)
  const successButton = successButtonForAction(action)
  return <section className={`ob-presenter__card ob-presenter__card--${card.kind}`} aria-label={card.title ?? 'Next action'}>
    {card.title && <h1>{card.title}</h1>}
    {card.phrase && <blockquote>{card.phrase}</blockquote>}
    {card.detail && <p>{card.detail}</p>}
    {!reviewing && card.kind === 'provider' && <div className="ob-presenter__choices">
      <ProviderButton provider="claude" card={card} />
      <ProviderButton provider="codex" card={card} />
    </div>}
    {!reviewing && (card.kind === 'permission' || card.kind === 'repair') &&
      <button className="ob-presenter__primary" type="button" onClick={() => send({ type: card.kind === 'repair' ? 'open-settings' : 'continue' })}>
        {card.kind === 'repair' ? 'Open Keyboard Settings' : 'Continue'}
      </button>}
    {!reviewing && card.kind === 'speak' && canSkipAction(action, phase) &&
      <button className="ob-presenter__primary" type="button" onClick={() => send({ type: 'continue' })}>Continue</button>}
    {!reviewing && card.kind === 'success' && <button className="ob-presenter__primary" type="button" onClick={() => send({ type: successButton.type })}>
      {successButton.label}
    </button>}
  </section>
}

export function OnboardingPresenter() {
  const [state, dispatch] = useReducer(reducePresenter, undefined, emptyPresenter)
  const [paused, setPaused] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const videoUrl = clipUrl(state.clipId)
  const hasVideo = !state.videoUnavailable && Boolean(videoUrl)
  const totalSteps = Math.max(1, state.totalSteps)
  const step = Math.max(1, state.step)

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

  const finishClip = () => {
    if (state.reviewing) return
    const action = clipEndActionFor(state.action)
    if (action) api().onboardingPresenterAction?.({ type: action })
  }

  const videoKey = `${state.clipId}:${state.reviewing ? 'review' : 'live'}`

  return <main className="ob-presenter" data-action={state.action}>
    <section className="ob-presenter__glass">
      <header className="ob-presenter__identity">
        <img src={unmuteLogo} alt="Unmute" />
        <div className="ob-presenter__progress" role="progressbar" aria-label={`Onboarding step ${step} of ${totalSteps}`} aria-valuemin={1} aria-valuemax={totalSteps} aria-valuenow={step}>
          {Array.from({ length: totalSteps }, (_, index) => <span
            key={index}
            className={index + 1 < step ? 'is-past' : index + 1 === step ? 'is-current' : ''}
          />)}
        </div>
        <span className="ob-presenter__step">{step}/{totalSteps}</span>
      </header>
      <div
        className="ob-presenter__film"
        role="button"
        tabIndex={0}
        aria-label={paused ? 'Play onboarding video' : 'Pause onboarding video'}
        aria-pressed={paused}
        onClick={togglePlayback}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePlayback() }
        }}
      >
        {hasVideo
          ? <video
              ref={videoRef}
              key={videoKey}
              src={videoUrl}
              aria-label={state.caption}
              autoPlay
              playsInline
              preload="auto"
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
              onEnded={finishClip}
              onError={() => dispatch({ type: 'video-unavailable' })}
            />
          : <div className="ob-presenter__standin">
              <span className="ob-presenter__logo-plate"><img src={unmuteLogo} alt="" /></span>
              <div className="ob-presenter__filmshade" />
              <div className="ob-presenter__caption" aria-live="polite">{state.caption || 'Preparing your introduction…'}</div>
            </div>}
      </div>
      <footer className="ob-presenter__controls">
        <button type="button" disabled={!state.history.length || state.historyIndex === 0} onClick={() => dispatch({ type: 'back' })}>Back</button>
        <button type="button" onClick={togglePlayback}>{paused ? 'Play' : 'Pause'}</button>
        <button type="button" onClick={replay}>Replay</button>
        {state.reviewing && <button type="button" onClick={() => dispatch({ type: 'forward' })}>Forward</button>}
        <span className="ob-presenter__status">{state.reviewing ? 'Reviewing' : hasVideo ? 'Captions included' : 'Script mode'}</span>
      </footer>
    </section>
    {state.card && <CompanionCard action={state.action} card={state.card} reviewing={state.reviewing} phase={state.phase} />}
  </main>
}
