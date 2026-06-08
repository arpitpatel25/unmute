// Account tab — identity, provider config, money, usage.
//
// Restructured out of the old single-page Settings.tsx. Contains EXACTLY
// the same sections as before (Engine, Groq API Key, Usage, Billing) —
// just rendered in their own top-level tab. All IPC calls, settings keys,
// and downstream behavior unchanged.

import { useEffect, useState } from 'react'
import type { UsageSummary } from '../shared/types'
import { EngineSettings } from '../paywall/EngineSettings'
import { Billing } from '../paywall/Billing'
import { useAuth } from '../paywall/AuthContext'
import {
  SectionHeader,
  SegmentedControl,
  UsageDetail,
  KeyIcon,
  UsageIcon,
  BehaviorIcon,
  fmtUsd,
  fmtCount,
  fmtDuration,
} from './_shared'

export default function Account() {
  const auth = useAuth()

  // Groq API key (BYO-key)
  const [groqKeyInput, setGroqKeyInput] = useState('')
  const [groqKeyMasked, setGroqKeyMasked] = useState<string | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null)

  // Groq usage (local estimated cost)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [usageWindow, setUsageWindow] = useState<'today' | 'month' | 'allTime'>('today')
  const [usageResetting, setUsageResetting] = useState(false)

  useEffect(() => {
    window.electronAPI.getGroqKeyStatus().then((s) => {
      setGroqKeyMasked(s.hasKey ? s.masked : null)
    })
    window.electronAPI.getUsage().then(setUsage).catch(() => {})
  }, [])

  async function handleSaveKey() {
    const key = groqKeyInput.trim()
    if (!key || keyBusy) return
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      const test = await window.electronAPI.testGroqKey(key)
      if (!test.ok) {
        setKeyMsg({ text: test.error || 'Invalid key', type: 'err' })
        return
      }
      const res = await window.electronAPI.setGroqKey(key)
      if (res.success) {
        setGroqKeyMasked(res.masked ?? null)
        setGroqKeyInput('')
        setKeyMsg({ text: 'Key saved securely.', type: 'ok' })
      } else {
        setKeyMsg({ text: res.error || 'Failed to save key', type: 'err' })
      }
    } catch {
      setKeyMsg({ text: 'Something went wrong', type: 'err' })
    } finally {
      setKeyBusy(false)
    }
  }

  function handleRemoveKey() {
    window.electronAPI.clearGroqKey()
    setGroqKeyMasked(null)
    setGroqKeyInput('')
    setKeyMsg(null)
  }

  async function handleResetUsage() {
    if (usageResetting) return
    setUsageResetting(true)
    try {
      const fresh = await window.electronAPI.resetUsage()
      setUsage(fresh)
    } catch {
      /* best-effort */
    } finally {
      setUsageResetting(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-6">Account</h2>

      {/* ═══ Profile ═══ */}
      <SectionHeader icon={<BehaviorIcon />} title="Profile" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <div className="px-5 py-4 flex items-center justify-between">
          {auth.signedIn ? (
            <>
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-full bg-ink text-white flex items-center justify-center text-[12px] font-semibold shrink-0">
                  {(auth.user?.email?.[0] ?? 'U').toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink truncate">
                    {auth.user?.email ?? 'Signed in'}
                  </p>
                  <p className="text-[11px] text-ink-35">Signed in to managed cloud</p>
                </div>
              </div>
              <button
                onClick={() => auth.signOut()}
                className="px-3 py-1.5 rounded-full border border-border text-[11px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all shrink-0"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <div>
                <p className="text-[13px] font-medium text-ink">Not signed in</p>
                <p className="text-[11px] text-ink-35 mt-0.5">
                  Sign in to use managed cloud and top up credits.
                </p>
              </div>
              <button
                onClick={() => auth.openSignIn()}
                className="px-4 py-2 rounded-full bg-ink text-white text-[12px] font-semibold hover:opacity-90 transition-opacity shrink-0"
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>

      {/* ═══ Engine ═══ */}
      <SectionHeader icon={<BehaviorIcon />} title="Engine" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <EngineSettings />
      </div>

      {/* ═══ Groq API Key ═══ */}
      <SectionHeader icon={<KeyIcon />} title="Groq API Key" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <div className="px-5 py-4">
          {groqKeyMasked ? (
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-[7px] h-[7px] rounded-full bg-green-500" />
                <span className="text-[13px] font-medium text-ink">Connected</span>
                <span className="text-[12px] text-ink-35 font-mono">{groqKeyMasked}</span>
              </div>
              <button
                onClick={handleRemoveKey}
                className="text-[12px] font-medium text-ink-60 hover:text-red-500 transition-colors px-2 py-1"
              >
                Remove
              </button>
            </div>
          ) : (
            <p className="text-[12px] text-ink-60 mb-3">
              unmute uses your own Groq key — it stays on this Mac, encrypted in the Keychain.
            </p>
          )}

          <div className="flex items-center gap-2">
            <input
              type="password"
              value={groqKeyInput}
              onChange={(e) => setGroqKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveKey() }}
              placeholder={groqKeyMasked ? 'Paste a new key to replace' : 'gsk_...'}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 bg-cream-mid border border-border-md rounded-[10px] px-3.5 py-2 text-[12px] font-mono text-ink outline-none focus:border-ink/30 transition-colors"
            />
            <button
              onClick={handleSaveKey}
              disabled={!groqKeyInput.trim() || keyBusy}
              className="px-4 py-2 rounded-[10px] text-[12px] font-semibold bg-ink text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity whitespace-nowrap"
            >
              {keyBusy ? 'Checking…' : 'Save'}
            </button>
          </div>

          <div className="flex items-center justify-between mt-2.5">
            <button
              onClick={() => window.electronAPI.openExternal('https://console.groq.com/keys')}
              className="text-[11px] text-ink-35 hover:text-ink transition-colors underline underline-offset-2"
            >
              Get a free API key →
            </button>
            {keyMsg && (
              <span className={`text-[11px] font-medium ${keyMsg.type === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
                {keyMsg.text}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ═══ Billing ═══ */}
      <SectionHeader icon={<BehaviorIcon />} title="Billing" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <Billing />
      </div>

      {/* ═══ Usage ═══ */}
      <SectionHeader icon={<UsageIcon />} title="Usage" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <div className="px-5 py-4">
          {/* Window selector */}
          <div className="flex justify-center mb-4">
            <SegmentedControl
              options={[
                { value: 'today', label: 'Today' },
                { value: 'month', label: 'This month' },
                { value: 'allTime', label: 'All time' },
              ]}
              value={usageWindow}
              onChange={(v) => setUsageWindow(v as 'today' | 'month' | 'allTime')}
            />
          </div>

          {/* Selected-window estimated cost */}
          <div className="text-center mb-4">
            <p className="text-[34px] font-bold text-ink tabular-nums tracking-tight leading-none">
              {fmtUsd(usage?.[usageWindow].cost)}
            </p>
            <p className="text-[10px] font-medium text-ink-35 uppercase tracking-[0.1em] mt-1.5">
              Estimated spend
            </p>
          </div>

          {/* Breakdown */}
          <div className="grid grid-cols-2 gap-2.5">
            <UsageDetail
              label="Total tokens"
              value={fmtCount(usage ? usage[usageWindow].inputTokens + usage[usageWindow].outputTokens : undefined)}
            />
            <UsageDetail label="Duration" value={fmtDuration(usage?.[usageWindow].sttSeconds)} />
            <UsageDetail label="Input tokens" value={fmtCount(usage?.[usageWindow].inputTokens)} />
            <UsageDetail label="Output tokens" value={fmtCount(usage?.[usageWindow].outputTokens)} />
          </div>

          <div className="flex items-center justify-between mt-4">
            <p className="text-[11px] text-ink-35 leading-snug pr-3">
              Estimated from Groq pricing — actual charges may differ. Local
              transcription and other providers aren't counted.
            </p>
            <button
              onClick={handleResetUsage}
              disabled={usageResetting}
              className="text-[11px] font-medium text-ink-60 hover:text-red-500 transition-colors px-2 py-1 whitespace-nowrap disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
