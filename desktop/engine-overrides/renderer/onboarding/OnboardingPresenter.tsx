import { useEffect, useReducer, useRef, useState } from 'react'
import { UIIcon } from '../app/UIIcon'

import { clipUrl } from './clips'
import { advancePresenterDrag, beginPresenterDrag, canSkipAction, clipEndActionFor, didPresenterDrag, processingEscapeDelayMs, successButtonForAction, type PresenterDragState } from './presenterActions'
import { emptyPresenter, reducePresenter, shownProviders, type PresenterCard, type PresenterMessage } from './presenterState'
import './presenter.css'

type PresenterAction =
  | { type: 'continue' | 'skip-section' | 'dismiss' | 'continue-anyway' | 'retry' | 'open-settings' | 'replay-clip' | 'complete-orientation' | 'open-sign-in' }
  | { type: 'choose-provider' | 'install-provider' | 'authenticate-provider' | 'retry-provider'; provider: 'claude' | 'codex' }

type PresenterApi = {
  onboardingOnPresenterCommand?(callback: (message: PresenterMessage) => void): () => void
  onboardingPresenterAction?(action: PresenterAction): void
  onboardingMovePresenter?(deltaX: number, deltaY: number): void
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
  if (status.state === 'outdated') return <button type="button" title={status.detail} onClick={() => send({ type: 'install-provider', provider })}>Update {label}</button>
  if (status.state === 'auth-required') return <button type="button" onClick={() => send({ type: 'authenticate-provider', provider })}>Sign in to {label}</button>
  return <button type="button" onClick={() => send({ type: 'retry-provider', provider })}>Check {label} again</button>
}

function CompanionCard({ action, card, reviewing, phase, escapeReady }: { action: string; card: NonNullable<PresenterCard>; reviewing: boolean; phase?: 'ready' | 'listening' | 'processing'; escapeReady: boolean }) {
  const send = (action: PresenterAction) => api().onboardingPresenterAction?.(action)
  const successButton = successButtonForAction(action)
  return <section className={`ob-presenter__card ob-presenter__card--${card.kind}`} aria-label={card.title ?? 'Next action'}>
    {card.title && <h1>{card.title}</h1>}
    {card.phrase && <blockquote>{card.phrase}</blockquote>}
    {card.detail && <p>{card.detail}</p>}
    {!reviewing && card.kind === 'provider' && <div className="ob-presenter__choices">
      {shownProviders(card.providers).map((provider) => <ProviderButton key={provider} provider={provider} card={card} />)}
    </div>}
    {!reviewing && (card.kind === 'permission' || card.kind === 'repair') &&
      <button className="ob-presenter__primary" type="button" onClick={() => send({ type: card.kind === 'repair' ? 'open-settings' : 'continue' })}>
        {card.kind === 'repair' ? 'Open Keyboard Settings' : 'Continue'}
      </button>}
    {!reviewing && card.kind === 'speak' && phase === 'processing' && <div className="ob-presenter__escape">
      {escapeReady && <button type="button" onClick={() => send({ type: 'retry' })}>Try again</button>}
      <button className="ob-presenter__primary" type="button" onClick={() => send({ type: 'skip-section' })}>Skip and continue</button>
    </div>}
    {!reviewing && card.kind === 'success' && <button className="ob-presenter__primary" type="button" onClick={() => send({ type: successButton.type })}>
      {successButton.label}
    </button>}
  </section>
}

export function OnboardingPresenter() {
  const [state, dispatch] = useReducer(reducePresenter, undefined, emptyPresenter)
  const [paused, setPaused] = useState(false)
  const [escapeReady, setEscapeReady] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const dragRef = useRef<{ pointerId: number; state: PresenterDragState } | null>(null)
  const suppressClickRef = useRef(false)
  const videoUrl = clipUrl(state.clipId)
  const hasVideo = !state.videoUnavailable && Boolean(videoUrl)
  const totalSteps = Math.max(1, state.totalSteps)
  const step = Math.max(1, state.step)

  useEffect(() => api().onboardingOnPresenterCommand?.(dispatch), [])

  useEffect(() => {
    setEscapeReady(false)
    if (state.reviewing) return
    const delay = processingEscapeDelayMs(state.action, state.phase)
    if (delay === null) return
    const timeout = window.setTimeout(() => setEscapeReady(true), delay)
    return () => window.clearTimeout(timeout)
  }, [state.action, state.phase, state.reviewing])

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

  return <main
    className="ob-presenter"
    data-action={state.action}
    onPointerDown={event => {
      if (event.button !== 0) return
      suppressClickRef.current = false
      dragRef.current = { pointerId: event.pointerId, state: beginPresenterDrag(event.screenX, event.screenY) }
    }}
    onPointerMove={event => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const next = advancePresenterDrag(drag.state, event.screenX, event.screenY)
      drag.state = next.state
      if (!next.delta) return
      // Capturing on mouse-down retargets even ordinary button/video clicks
      // to <main>. Capture only once this gesture actually becomes a drag.
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      event.preventDefault()
      api().onboardingMovePresenter?.(next.delta.x, next.delta.y)
    }}
    onPointerUp={event => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      suppressClickRef.current = didPresenterDrag(drag.state)
      dragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }}
    onPointerCancel={() => { dragRef.current = null }}
    onPointerLeave={() => {
      if (!didPresenterDrag(dragRef.current?.state)) dragRef.current = null
    }}
    onClickCapture={event => {
      if (!suppressClickRef.current) return
      suppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
    }}
  >
    <section className="ob-presenter__glass">
      <header className="ob-presenter__identity">
        <div className="ob-presenter__progress" role="progressbar" aria-label={`Onboarding step ${step} of ${totalSteps}`} aria-valuemin={1} aria-valuemax={totalSteps} aria-valuenow={step}>
          {Array.from({ length: totalSteps }, (_, index) => <span
            key={index}
            className={index + 1 < step ? 'is-past' : index + 1 === step ? 'is-current' : ''}
          />)}
        </div>
        <span className="ob-presenter__step">{step}/{totalSteps}</span>
        <button className="ob-presenter__close" type="button" aria-label="Close onboarding" title="Close onboarding" onClick={() => api().onboardingPresenterAction?.({ type: 'dismiss' })}><UIIcon name="close" size={13} /></button>
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
              <div className="ob-presenter__filmshade" />
              <div className="ob-presenter__caption" aria-live="polite">{state.caption || 'Preparing your introduction…'}</div>
            </div>}
      </div>
      <footer className="ob-presenter__controls">
        <button type="button" title="Previous step" disabled={!state.history.length || state.historyIndex === 0} onClick={() => dispatch({ type: 'back' })}><UIIcon name="back" size={12} />Back</button>
        <button type="button" aria-label={paused ? 'Play video' : 'Pause video'} title={paused ? 'Play video' : 'Pause video'} onClick={togglePlayback}><UIIcon name={paused ? 'play' : 'pause'} size={14} /></button>
        <button type="button" aria-label="Replay video" title="Replay video" onClick={replay}><UIIcon name="replay" size={14} /></button>
        {state.reviewing && <button type="button" onClick={() => dispatch({ type: 'forward' })}>Next<UIIcon name="chevron" size={12} /></button>}
        {!state.reviewing && state.phase !== 'processing' && canSkipAction(state.action, state.phase) &&
          <button className="ob-presenter__skip" type="button" onClick={() => api().onboardingPresenterAction?.({ type: 'skip-section' })}>Skip section</button>}
      </footer>
    </section>
    {state.card && <CompanionCard action={state.action} card={state.card} reviewing={state.reviewing} phase={state.phase} escapeReady={escapeReady} />}
  </main>
}
