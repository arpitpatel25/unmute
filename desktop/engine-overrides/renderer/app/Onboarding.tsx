// Managed-build Onboarding override — the nine-step flow, plus the
// three-screen "what's new" that existing users get instead (decision D4).
//
// WHAT CHANGED AND WHY. The old eight steps described a dictation tool: two
// ways to use your voice, a pricing model the app no longer runs ("pay only for
// what you use"), a skippable Accessibility step that leaves the app inert, and
// a hardcoded key name in the sentences telling the user what to press — wrong
// for everyone who moved dictation to Right Option. None of it mentioned the
// notch, which is where handed-off work actually lives.
//
// EVERY KEY LABEL IS READ LIVE. `dictationKey` comes from settings; the
// orchestrator sits on whichever trigger dictation is not using; instruction is
// Caps Lock. No step prints a key name it has not looked up.

import { useState, useEffect, useCallback } from 'react'
import unmuteLogo from '../assets/unmute-logo.png'
import { useAuth } from '../paywall/AuthContext'
import { SegmentedControl, PermissionRow } from './_shared'

interface OnboardingProps {
  onComplete: () => void
  /** Finish onboarding and land the user on Orchestrator → Agents, instead of
   *  dropping them on History to find agent setup themselves. Optional so the
   *  component still renders standalone. */
  onOpenAgentSetup?: () => void
}

type MicStatus = 'unknown' | 'not-determined' | 'granted' | 'denied' | 'restricted'
type DictationKey = 'fn' | 'right-option'
type Plan = 'dictation' | 'unmute'

/** The renderer types in this project do not declare `window.electronAPI`.
 *  Reaching for it through a cast window is the same runtime access with none
 *  of the type noise — the idiom the other override files use. */
type OnboardingAPI = {
  getMicPermissionStatus?: () => Promise<string>
  requestMicPermission?: () => Promise<boolean>
  openMicSettings?: () => void
  getAccessibilityStatus?: () => Promise<boolean>
  requestAccessibility?: () => Promise<boolean>
  openAccessibilitySettings?: () => void
  openKeyboardSettings?: () => void
  getDictationKey?: () => Promise<string>
  setDictationKey?: (key: DictationKey) => void
  paywallGetInstructionEnabled?: () => Promise<boolean>
  paywallGetSubscription?: () => Promise<{ active: boolean; plan: Plan | null } | null>
  paywallCreateSubscription?: (
    plan: Plan,
    interval: 'month' | 'year',
  ) => Promise<{ ok: boolean; checkoutUrl?: string; alreadySubscribed?: boolean; message?: string }>
  paywallOpenExternal?: (url: string) => Promise<boolean>
  remoteGetSetupStatus?: () => Promise<{ complete: boolean }>
}
function api(): OnboardingAPI {
  return (window as unknown as { electronAPI?: OnboardingAPI }).electronAPI ?? {}
}

/** Human labels for the two triggers a user can choose between. The only place
 *  a key name is written down; every sentence reads from here. */
const KEY_LABELS: Record<DictationKey, string> = {
  fn: 'Fn',
  'right-option': 'Right Opt',
}
/** The orchestrator always sits on whichever trigger dictation is not using. */
function otherKey(key: DictationKey): DictationKey {
  return key === 'fn' ? 'right-option' : 'fn'
}

/** The two real tiers, from `src/paywall/Billing.tsx`. Prices live in cents
 *  there; repeated here as display strings only — this screen never charges,
 *  it opens the same Dodo checkout Billing does. */
const PLANS: { plan: Plan; name: string; price: string; tagline: string; recommended?: boolean }[] = [
  {
    plan: 'dictation',
    name: 'Dictation',
    price: '$4.99/mo',
    tagline: 'Fast, accurate cloud dictation everywhere.',
  },
  {
    plan: 'unmute',
    name: 'Unmute',
    price: '$7.99/mo',
    tagline: 'Dictation plus Orchestrate. The whole thing.',
    recommended: true,
  },
]

export default function Onboarding({ onComplete, onOpenAgentSetup }: OnboardingProps) {
  const [step, setStep] = useState(0)
  const auth = useAuth()

  // ─── Keys, read live from settings ───
  const [dictationKey, setDictationKeyState] = useState<DictationKey>('fn')
  const [instructionEnabled, setInstructionEnabled] = useState(true)
  const dictateLabel = KEY_LABELS[dictationKey]
  const orchestrateLabel = KEY_LABELS[otherKey(dictationKey)]
  const instructLabel = 'Caps Lock'

  function chooseDictationKey(value: string) {
    const key: DictationKey = value === 'right-option' ? 'right-option' : 'fn'
    setDictationKeyState(key)
    api().setDictationKey?.(key)
  }

  // ─── Microphone permission ───
  const [micStatus, setMicStatus] = useState<MicStatus>('unknown')
  const micGranted = micStatus === 'granted'

  const refreshMicStatus = useCallback(async () => {
    try {
      const raw = await api().getMicPermissionStatus?.()
      const status = (raw ?? 'unknown') as MicStatus
      setMicStatus(status)
      return status
    } catch {
      return 'unknown' as MicStatus
    }
  }, [])

  // ─── Accessibility permission ───
  const [accessibilityGranted, setAccessibilityGranted] = useState(false)

  const refreshAccessibilityStatus = useCallback(async () => {
    try {
      const granted = await api().getAccessibilityStatus?.()
      setAccessibilityGranted(!!granted)
      return !!granted
    } catch {
      return false
    }
  }, [])

  async function requestAccessibility() {
    const granted = await api().requestAccessibility?.()
    setAccessibilityGranted(!!granted)
    if (!granted) api().openAccessibilitySettings?.()
  }

  async function requestMicPermission() {
    const granted = await api().requestMicPermission?.()
    if (granted) {
      setMicStatus('granted')
      return
    }
    const status = await refreshMicStatus()
    if (status === 'denied' || status === 'restricted') {
      api().openMicSettings?.()
    }
  }

  // ─── Subscription ───
  const [subscription, setSubscription] = useState<{ active: boolean; plan: Plan | null } | null>(null)
  const [checkoutPlan, setCheckoutPlan] = useState<Plan | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)

  const refreshSubscription = useCallback(async () => {
    try {
      const sub = await api().paywallGetSubscription?.()
      // null = the main process has no token yet. Keep the last-known answer
      // rather than flashing "no plan" at someone who has one.
      if (sub) setSubscription(sub)
    } catch { /* ignore — the plan step degrades to the sales cards */ }
  }, [])

  async function startCheckout(plan: Plan) {
    setCheckoutError(null)
    if (!auth.signedIn) {
      auth.openSignIn()
      return
    }
    setCheckoutPlan(plan)
    try {
      const res = await api().paywallCreateSubscription?.(plan, 'month')
      if (res?.alreadySubscribed) {
        await refreshSubscription()
        return
      }
      if (res?.ok && res.checkoutUrl) {
        await api().paywallOpenExternal?.(res.checkoutUrl)
        return
      }
      setCheckoutError(res?.message ?? 'Checkout could not be opened. You can subscribe later from Account.')
      setCheckoutPlan(null)
    } catch {
      setCheckoutError('Checkout could not be opened. You can subscribe later from Account.')
      setCheckoutPlan(null)
    }
  }

  // ─── Agent setup status ───
  const [agentReady, setAgentReady] = useState<boolean | null>(null)

  const refreshAgentStatus = useCallback(async () => {
    try {
      const status = await api().remoteGetSetupStatus?.()
      if (status) setAgentReady(status.complete)
    } catch { /* ignore — the step still offers "later" */ }
  }, [])

  useEffect(() => {
    api().getDictationKey?.().then((key) => {
      if (key === 'fn' || key === 'right-option') setDictationKeyState(key)
    }).catch(() => {})
    api().paywallGetInstructionEnabled?.()
      .then((on) => setInstructionEnabled(on !== false))
      .catch(() => {})
    refreshMicStatus()
    refreshAccessibilityStatus()
    refreshSubscription()
    refreshAgentStatus()
    // Permissions and checkout both complete OUTSIDE this window — in System
    // Settings and in the browser. Re-reading everything on focus is what makes
    // the screens update by themselves when the user comes back.
    const onFocus = () => {
      refreshMicStatus()
      refreshAccessibilityStatus()
      refreshSubscription()
      refreshAgentStatus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshMicStatus, refreshAccessibilityStatus, refreshSubscription, refreshAgentStatus])

  // While a checkout is open in the browser, poll for the subscription turning
  // active so the step can advance without the user having to click anything.
  useEffect(() => {
    if (!checkoutPlan) return
    const id = window.setInterval(() => { void refreshSubscription() }, 3000)
    return () => window.clearInterval(id)
  }, [checkoutPlan, refreshSubscription])

  useEffect(() => {
    if (subscription?.active) setCheckoutPlan(null)
  }, [subscription])

  function next() {
    if (step < steps.length - 1) setStep(step + 1)
    else onComplete()
  }

  const bothPermissionsGranted = micGranted && accessibilityGranted

  const steps = [
    // ── Step 0: Welcome ──
    <div key="welcome" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <img src={unmuteLogo} alt="unmute" className="w-56 mb-8" />
      <h1 className="font-display text-[22px] font-bold text-ink mb-3 tracking-tight flex items-center justify-center gap-2">
        Speak. It happens.
        <span className="w-[8px] h-[8px] rounded-full bg-accent shrink-0" style={{ animation: 'brand-dot-breathe 3s ease-in-out infinite' }} />
      </h1>
      <p className="text-ink-60 text-[16px] mb-10 max-w-sm leading-relaxed">
        Dictate anywhere on your Mac — and hand real work to a coding agent with
        the same voice.
      </p>
      <button onClick={next} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[16px] hover:bg-accent-hover transition-all duration-200 shadow-md hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]">
        Get started
      </button>
    </div>,

    // ── Step 1: What unmute does — three things, three keys ──
    <div key="what" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <h2 className="font-display text-[22px] font-bold text-ink mb-2 tracking-tight">What unmute does</h2>
      <p className="text-ink-60 text-[14px] mb-8 max-w-sm leading-relaxed">
        Three things, each on its own key.
      </p>
      <div className="flex flex-col gap-3 mb-8 w-full max-w-[400px]">
        <FeatureCard
          keyLabel={dictateLabel}
          title="Dictate"
          description="Tap it, speak, tap again. Raw text lands exactly where your cursor is, in any app."
        />
        <FeatureCard
          keyLabel={instructLabel}
          title="Instruct"
          description="Select text and say what to change — “make this formal”, “turn into bullets”, “translate to Hindi”. unmute rewrites it in place."
          muted={!instructionEnabled}
        />
        <FeatureCard
          keyLabel={orchestrateLabel}
          title="Orchestrate"
          description="Describe a job out loud. A coding agent runs it on your Mac and reports back when it is done."
        />
      </div>
      <button onClick={next} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md">
        Continue
      </button>
    </div>,

    // ── Step 2: The notch ──
    <div key="notch" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <NotchDiagram />
      <h2 className="font-display text-[22px] font-bold text-ink mb-2 tracking-tight">The notch is where work lives</h2>
      <p className="text-ink-60 text-[14px] mb-8 max-w-md leading-relaxed">
        Work you hand off does not live in this window. It lives in the notch —
        the strip at the very top of your screen, around the camera.
      </p>
      <div className="flex flex-col gap-2.5 mb-8 w-full max-w-[420px] text-left">
        <Bullet text="It shows what is running right now, without taking over your screen." />
        <Bullet text="When an agent needs an answer, the notch asks — and you answer out loud." />
        <Bullet text="Click it to expand the full detail; click away and it shrinks back." />
        <Bullet text="While you are speaking, a pill appears at the bottom of the screen so you can see you are being heard." />
      </div>
      <button onClick={next} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md">
        Continue
      </button>
    </div>,

    // ── Step 3: What leaves your Mac ──
    // Copy is fixed (spec §3, decision D3) and traced line by line through the
    // backend. Do not soften it, do not shorten it, do not improvise.
    <div key="privacy" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <div className="w-20 h-20 rounded-2xl bg-success-soft flex items-center justify-center mb-6">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-success">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <polyline points="9 12 11 14 15 10" />
        </svg>
      </div>
      <h2 className="font-display text-[22px] font-bold text-ink mb-2 tracking-tight">What leaves your Mac</h2>
      <p className="text-ink-60 text-[14px] mb-8 max-w-sm leading-relaxed">
        Written plainly, because the honest answer is not “nothing”.
      </p>
      <div className="flex flex-col gap-2.5 mb-8 w-full max-w-[440px] text-left">
        <Bullet
          lead="Dictation audio"
          text=" goes to our transcription service and is discarded the moment the text comes back. We keep a timestamp, a duration and the model name so we can bill you — never the audio, never the text."
        />
        <Bullet
          lead="Orchestrator tasks never reach us."
          text=" The agent runs on your Mac, under your own account, with your own credentials. unmute passes it your words and reads its status back."
        />
        <Bullet
          lead="On-device mode sends nothing at all."
          text=" No account, no network."
        />
        <Bullet
          lead="Diagnostics stay here."
          text=" unmute keeps a local log of how each dictation was served — for seven days, on this Mac, never uploaded. It does not contain what you said."
        />
      </div>
      <button onClick={next} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md">
        Continue
      </button>
    </div>,

    // ── Step 4: Pick a plan ──
    <div key="plan" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <h2 className="font-display text-[22px] font-bold text-ink mb-2 tracking-tight">Pick a plan</h2>
      {subscription?.active ? (
        <>
          <p className="text-ink-60 text-[14px] mb-6 max-w-sm leading-relaxed">
            You are already subscribed. Nothing to do here.
          </p>
          <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-success-soft border border-success/15 mb-8">
            <CheckDot />
            <span className="text-success font-semibold text-[13px]">
              {subscription.plan === 'unmute' ? 'On the Unmute plan' : 'On the Dictation plan'}
            </span>
          </div>
          <button onClick={next} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md">
            Continue
          </button>
        </>
      ) : (
        <>
          <p className="text-ink-60 text-[14px] mb-7 max-w-sm leading-relaxed">
            Cloud transcription is a subscription. Cancel any time from Account.
          </p>
          <div className="flex flex-col gap-3 mb-6 w-full max-w-[420px]">
            {PLANS.map((tier) => (
              <PlanCard
                key={tier.plan}
                name={tier.name}
                price={tier.price}
                tagline={tier.tagline}
                recommended={tier.recommended}
                busy={checkoutPlan === tier.plan}
                signedIn={auth.signedIn}
                onChoose={() => startCheckout(tier.plan)}
              />
            ))}
          </div>
          {checkoutPlan && (
            <p className="text-ink-60 text-[12.5px] mb-4 max-w-[420px] leading-relaxed">
              Finish checkout in your browser, then come back — this screen
              updates itself.
            </p>
          )}
          {checkoutError && (
            <p className="text-[12.5px] text-accent mb-4 max-w-[420px] leading-relaxed">{checkoutError}</p>
          )}
          <button
            onClick={next}
            className="text-[12.5px] text-ink-35 font-medium hover:text-ink-60 transition-colors"
          >
            Continue free on the on-device model
          </button>
          <p className="text-[11px] text-ink-35 mt-2 max-w-[380px] leading-relaxed">
            It runs entirely offline and sends nothing anywhere. It is slower and
            less accurate, and it cannot run agents.
          </p>
        </>
      )}
    </div>,

    // ── Step 5: Two permissions ──
    // Neither is skippable. Without Accessibility the app is inert: it cannot
    // see the trigger key and cannot type at the cursor, so the old escape
    // hatch on this step only ever produced a silently broken install.
    <div key="permissions" className="flex flex-col items-center justify-center text-center animate-fade-up-in w-full">
      <h2 className="font-display text-[22px] font-bold text-ink mb-2 tracking-tight">Two permissions</h2>
      <p className="text-ink-60 text-[14px] mb-7 max-w-sm leading-relaxed">
        Both are required. Without them unmute cannot hear you and cannot type
        for you — it does nothing at all.
      </p>
      <div className="w-full max-w-[460px] mb-7 rounded-2xl border border-border bg-surface-2 overflow-hidden text-left">
        <PermissionRow
          title="Microphone"
          description={
            micStatus === 'denied' || micStatus === 'restricted'
              ? 'Turned off right now. Open System Settings, find unmute under Microphone, switch it on, then come back.'
              : 'Required — unmute needs your microphone to hear what you say. Audio is transcribed and discarded, never recorded.'
          }
          granted={micGranted}
          statusText={micGranted ? 'Granted' : 'Required'}
          primary={micGranted ? null : { label: 'Grant access', onClick: () => { void requestMicPermission() } }}
          secondary={micGranted ? null : { label: 'Open System Settings', onClick: () => api().openMicSettings?.() }}
        />
        <PermissionRow
          title="Accessibility"
          description={
            accessibilityGranted
              ? 'Required — this is how unmute sees your trigger key and pastes text at the cursor.'
              : 'Required — this is how unmute sees your trigger key and pastes text at the cursor. Find unmute in the list and switch it on; you may need to unlock with your password first.'
          }
          granted={accessibilityGranted}
          statusText={accessibilityGranted ? 'Granted' : 'Required'}
          primary={accessibilityGranted ? null : { label: 'Open System Settings', onClick: () => { void requestAccessibility() } }}
          secondary={accessibilityGranted ? null : { label: 'I have enabled it', onClick: () => { void refreshAccessibilityStatus() } }}
          divider
        />
      </div>
      <button
        onClick={next}
        disabled={!bothPermissionsGranted}
        className={`px-10 py-3.5 rounded-full font-display font-semibold text-[14px] transition-all duration-200 ${
          bothPermissionsGranted
            ? 'bg-accent text-white hover:bg-accent-hover shadow-sm hover:shadow-md'
            : 'bg-ink-07 text-ink-35 cursor-not-allowed'
        }`}
      >
        Continue
      </button>
      {!bothPermissionsGranted && (
        <p className="text-[11px] text-ink-35 mt-3">
          This screen updates by itself once both are on.
        </p>
      )}
    </div>,

    // ── Step 6: Your keys ──
    <div key="keys" className="flex flex-col items-center justify-center text-center animate-fade-up-in w-full">
      <h2 className="font-display text-[22px] font-bold text-ink mb-2 tracking-tight">Your keys</h2>
      <p className="text-ink-60 text-[14px] mb-6 max-w-sm leading-relaxed">
        Pick the key you want for dictation. Orchestrate takes the other one.
      </p>

      <div className="mb-6 flex flex-col items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-35">Dictation key</span>
        <SegmentedControl
          options={[
            { value: 'fn', label: 'Fn (Globe)' },
            { value: 'right-option', label: 'Right Option' },
          ]}
          value={dictationKey}
          onChange={chooseDictationKey}
        />
      </div>

      <div className="flex flex-col gap-3 mb-7 w-full max-w-[400px]">
        <ShortcutCard keyLabel={dictateLabel} title="Dictate" description="Speak, and the text lands at your cursor." />
        <ShortcutCard
          keyLabel={instructionEnabled ? instructLabel : 'Off'}
          title="Instruct"
          description={instructionEnabled
            ? 'Select text first, then say what to change.'
            : 'Switched off — you can turn it back on in Settings → Triggers.'}
          accent={instructionEnabled}
        />
        <ShortcutCard keyLabel={orchestrateLabel} title="Orchestrate" description="Describe a job and hand it to your agent." />
      </div>

      <div className="px-5 py-3 rounded-xl bg-warm-soft border border-warm/15 mb-7 max-w-[400px] text-left">
        <p className="text-[12.5px] text-ink-60 leading-relaxed">
          <span className="font-display font-bold text-warm">One macOS tweak:</span>{' '}
          by default the Globe key shows emoji or starts Apple Dictation, and
          unmute is using it for{' '}
          <span className="font-semibold text-ink">
            {dictationKey === 'fn' ? 'dictation' : 'orchestrate'}
          </span>
          . Open <span className="font-semibold text-ink">System Settings → Keyboard</span>{' '}
          and set <span className="font-semibold text-ink">“Press 🌐 key to”</span> →{' '}
          <span className="font-semibold text-ink">Do Nothing</span> to free it.
        </p>
        <button
          onClick={() => api().openKeyboardSettings?.()}
          className="mt-2 px-3 py-1.5 rounded-full border border-warm/25 text-[11px] font-semibold text-warm hover:bg-warm/[0.08] transition-all"
        >
          Open Keyboard Settings
        </button>
      </div>

      <button onClick={next} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md">
        Continue
      </button>
    </div>,

    // ── Step 7: Connect an agent — optional, and deferrable ──
    <div key="agent" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <h2 className="font-display text-[22px] font-bold text-ink mb-2 tracking-tight">Connect an agent</h2>
      <p className="text-ink-60 text-[14px] mb-7 max-w-md leading-relaxed">
        Orchestrate needs a coding agent already installed on your Mac — Claude
        Code or Codex. It runs under your own account with your own credentials;
        unmute is never in the credential path.
      </p>

      {agentReady ? (
        <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-success-soft border border-success/15 mb-7">
          <CheckDot />
          <span className="text-success font-semibold text-[13px]">An agent is connected</span>
        </div>
      ) : (
        <div className="px-4 py-3 rounded-xl bg-ink-07 mb-7 max-w-[420px] text-left">
          <p className="text-[12.5px] text-ink-60 leading-relaxed">
            Setup takes about a minute and is not one-way — you can add a second
            agent months from now, and the same page is always there under
            Orchestrator when a connection needs repairing.
          </p>
        </div>
      )}

      <div className="flex flex-col items-center gap-3">
        {onOpenAgentSetup && !agentReady && (
          <button
            onClick={onOpenAgentSetup}
            className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md"
          >
            Set it up now
          </button>
        )}
        <button
          onClick={next}
          className={agentReady
            ? 'px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md'
            : 'px-8 py-3 rounded-full border border-border text-[13px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all duration-200'}
        >
          {agentReady ? 'Continue' : 'I’ll do this later'}
        </button>
      </div>
    </div>,

    // ── Step 8: Ready ──
    <div key="ready" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <img src={unmuteLogo} alt="unmute" className="w-48 mb-8 animate-success-pop" />
      <h2 className="font-display text-[22px] font-bold text-ink mb-3 tracking-tight">Ready.</h2>
      <p className="text-ink-60 text-[16px] mb-10 max-w-sm leading-relaxed">
        Press <Keycap>{dictateLabel}</Keycap> anywhere to dictate, or{' '}
        <Keycap>{orchestrateLabel}</Keycap> to hand a job to your agent. The
        notch will tell you how it is going.
      </p>
      <button onClick={onComplete} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[16px] hover:bg-accent-hover transition-all duration-200 shadow-md hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]">
        Start using unmute
      </button>
    </div>,
  ]

  return <Shell step={step} total={steps.length}>{steps[step]}</Shell>
}

/* ─── What's new (decision D4) ─────────────────────────────────────────
 *
 * Users who finished the old flow are on version 1. Nine steps would be an
 * insult to someone already using the product daily, and skipping it entirely
 * would leave them never hearing about the two things that actually changed.
 * Three screens, then straight into the app.
 */

export function WhatsNew({ onComplete, onOpenAgentSetup }: OnboardingProps) {
  const [step, setStep] = useState(0)
  const [dictationKey, setDictationKey] = useState<DictationKey>('fn')
  const orchestrateLabel = KEY_LABELS[otherKey(dictationKey)]

  useEffect(() => {
    api().getDictationKey?.().then((key) => {
      if (key === 'fn' || key === 'right-option') setDictationKey(key)
    }).catch(() => {})
  }, [])

  function next() {
    if (step < screens.length - 1) setStep(step + 1)
    else onComplete()
  }

  const screens = [
    <div key="agents" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <h2 className="font-display text-[22px] font-bold text-ink mb-3 tracking-tight">unmute runs coding agents now</h2>
      <p className="text-ink-60 text-[16px] mb-8 max-w-md leading-relaxed">
        Tap <Keycap>{orchestrateLabel}</Keycap> — whichever key dictation is not
        using — and describe a job out loud. A coding agent runs it on your Mac,
        under your own account, and reports back. Dictation and Instruct work
        exactly as they did.
      </p>
      <div className="flex flex-col items-center gap-3">
        <button onClick={next} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md">
          Continue
        </button>
        {onOpenAgentSetup && (
          <button
            onClick={onOpenAgentSetup}
            className="text-[12.5px] text-ink-35 font-medium hover:text-ink-60 transition-colors"
          >
            Take me to agent setup
          </button>
        )}
      </div>
    </div>,

    <div key="notch" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <NotchDiagram />
      <h2 className="font-display text-[22px] font-bold text-ink mb-3 tracking-tight">The notch is where they live</h2>
      <p className="text-ink-60 text-[16px] mb-8 max-w-md leading-relaxed">
        Handed-off work does not appear in this window. It appears in the strip
        at the top of your screen, around the camera — running, waiting on an
        answer, or finished. Click it to expand.
      </p>
      <button onClick={next} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[14px] hover:bg-accent-hover transition-all duration-200 shadow-sm hover:shadow-md">
        Continue
      </button>
    </div>,

    <div key="pricing" className="flex flex-col items-center justify-center text-center animate-fade-up-in">
      <h2 className="font-display text-[22px] font-bold text-ink mb-3 tracking-tight">Pricing is a subscription</h2>
      <p className="text-ink-60 text-[16px] mb-7 max-w-md leading-relaxed">
        Pay-as-you-go credits are gone. Two flat tiers instead — Dictation at
        $4.99/mo, or Unmute at $7.99/mo for dictation plus Orchestrate. Cancel
        any time from Account.
      </p>
      <button onClick={onComplete} className="px-10 py-3.5 rounded-full bg-accent text-white font-display font-semibold text-[16px] hover:bg-accent-hover transition-all duration-200 shadow-md hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]">
        Got it
      </button>
    </div>,
  ]

  return <Shell step={step} total={screens.length}>{screens[step]}</Shell>
}

/* ─── Shared chrome ─── */

function Shell({ step, total, children }: { step: number; total: number; children: React.ReactNode }) {
  return (
    <div className="h-screen bg-cream flex flex-col">
      {/* Titlebar drag region */}
      <div className="titlebar-drag absolute top-0 left-0 right-0 h-8" />

      {/* Progress bar */}
      <div className="flex gap-1.5 px-10 pt-10">
        {Array.from({ length: total }, (_, i) => (
          <div key={i} className="h-[3px] flex-1 rounded-full overflow-hidden bg-ink-07">
            <div className={`h-full rounded-full transition-all duration-500 ease-out ${i <= step ? 'bg-accent w-full' : 'w-0'}`} />
          </div>
        ))}
      </div>

      {/* Step counter */}
      <div className="px-10 mt-4">
        <span className="text-[11px] text-ink-35 font-medium">
          {step + 1} of {total}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center px-10 overflow-y-auto py-6">
        {children}
      </div>
    </div>
  )
}

function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex px-2 py-1 rounded-lg bg-gradient-to-b from-[#2E2A25] to-ink text-[12.5px] font-bold text-white/90 border border-black/50 shadow-[0_2px_0_rgba(0,0,0,0.55),0_1px_3px_rgba(0,0,0,0.25)]">
      {children}
    </kbd>
  )
}

function CheckDot() {
  return (
    <div className="w-5 h-5 rounded-full bg-success flex items-center justify-center shrink-0">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>
  )
}

/** A small picture of the top of a screen with the notch mass filled in — the
 *  surface has to be recognisable before the words about it mean anything. */
function NotchDiagram() {
  return (
    <div className="w-[220px] mb-6">
      <div className="rounded-t-xl border border-b-0 border-border bg-surface-2 h-[74px] relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 h-[22px] w-[112px] rounded-b-[11px] bg-ink flex items-center justify-center gap-1.5">
          <span className="w-[5px] h-[5px] rounded-full bg-accent" />
          <span className="text-[10px] font-semibold text-white/80">running</span>
        </div>
      </div>
      <div className="h-[6px] rounded-b-xl bg-cream-dark border border-t-0 border-border" />
    </div>
  )
}

function FeatureCard({ keyLabel, title, description, muted }: {
  keyLabel: string
  title: string
  description: string
  muted?: boolean
}) {
  return (
    <div className={`flex items-start gap-4 p-4 rounded-2xl border border-border bg-surface-2 text-left ${muted ? 'opacity-60' : ''}`}>
      <div className="min-w-[62px] h-11 px-2 rounded-xl bg-accent/[0.06] flex items-center justify-center shrink-0">
        <span className="text-accent font-mono text-[13px] font-bold whitespace-nowrap">{keyLabel}</span>
      </div>
      <div>
        <p className="text-[14px] font-semibold text-ink">{title}</p>
        <p className="text-[12.5px] text-ink-60 mt-0.5 leading-relaxed">{description}</p>
      </div>
    </div>
  )
}

function Bullet({ lead, text }: { lead?: string; text: string }) {
  return (
    <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-surface-2 border border-border">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success shrink-0 mt-0.5">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span className="text-[12.5px] text-ink-60 leading-relaxed">
        {lead && <span className="font-semibold text-ink">{lead}</span>}
        {text}
      </span>
    </div>
  )
}

function PlanCard({ name, price, tagline, recommended, busy, signedIn, onChoose }: {
  name: string
  price: string
  tagline: string
  recommended?: boolean
  busy: boolean
  signedIn: boolean
  onChoose: () => void
}) {
  return (
    <div className={`flex items-center gap-4 p-4 rounded-2xl border text-left ${recommended ? 'border-accent/40 bg-accent/[0.04]' : 'border-border bg-surface-2'}`}>
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-semibold text-ink flex items-center gap-2">
          {name}
          {recommended && (
            <span className="px-1.5 py-[1px] rounded-full bg-accent/12 text-[10px] font-bold tracking-wider uppercase text-accent">
              Recommended
            </span>
          )}
        </p>
        <p className="text-[12.5px] text-ink-60 mt-0.5 leading-relaxed">{tagline}</p>
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <span className="text-[13px] font-bold text-ink tabular-nums">{price}</span>
        <button
          onClick={onChoose}
          disabled={busy}
          className={`px-3.5 py-1.5 rounded-full text-[11px] font-semibold transition-all ${
            busy
              ? 'bg-ink-07 text-ink-35 cursor-wait'
              : 'bg-ink text-white hover:opacity-90'
          }`}
        >
          {busy ? 'Waiting…' : signedIn ? 'Choose' : 'Sign in'}
        </button>
      </div>
    </div>
  )
}

function ShortcutCard({ keyLabel, title, description, accent }: {
  keyLabel: string
  title: string
  description: string
  accent?: boolean
}) {
  return (
    <div className="flex items-center gap-4 p-4 rounded-2xl border border-border bg-surface-2 text-left">
      <div className={`min-w-[62px] h-12 px-2 rounded-xl flex items-center justify-center shrink-0 shadow-sm ${accent ? 'bg-accent' : 'bg-cream-mid border border-border'}`}>
        <span className={`font-mono text-[13px] font-bold whitespace-nowrap ${accent ? 'text-white' : 'text-ink'}`}>{keyLabel}</span>
      </div>
      <div>
        <p className="text-[14px] font-semibold text-ink">{title}</p>
        <p className="text-[12.5px] text-ink-35 mt-0.5">{description}</p>
      </div>
    </div>
  )
}
