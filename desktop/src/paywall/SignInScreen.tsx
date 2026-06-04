// Sign-in screen — shown only when the user explicitly picks Managed mode
// (or clicks "Sign in" from the Engine settings).
//
// NEVER shown at app startup. The app is fully usable without an account
// (BYOK + Local). The user can always back out via the top-left chevron.

import { useState, useCallback } from 'react'
import { getSupabase } from './supabase-client'

interface Props {
  onSuccess: () => void
  onCancel: () => void
}

export function SignInScreen({ onSuccess, onCancel }: Props) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'info' | 'error' | 'success' } | null>(null)
  const [showPaste, setShowPaste] = useState(false)
  const [pasteUrl, setPasteUrl] = useState('')

  const sendMagicLink = useCallback(async () => {
    if (!email.trim() || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const supa = getSupabase()
      const { error } = await supa.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: 'unmute://auth/callback' },
      })
      if (error) {
        setMessage({ text: error.message, type: 'error' })
      } else {
        setMessage({
          text: `Magic link sent to ${email.trim()}. Open it on this Mac to finish signing in.`,
          type: 'success',
        })
      }
    } catch {
      setMessage({ text: 'Something went wrong. Try again.', type: 'error' })
    } finally {
      setBusy(false)
    }
  }, [email, busy])

  const signInWithGoogle = useCallback(async () => {
    setBusy(true)
    setMessage(null)
    try {
      const supa = getSupabase()
      const { data, error } = await supa.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: 'unmute://auth/callback', skipBrowserRedirect: true },
      })
      if (error || !data.url) {
        setMessage({ text: error?.message ?? 'Failed to start Google sign-in', type: 'error' })
        setBusy(false)
        return
      }
      await window.electronAPI.paywallOpenExternal(data.url)
      setMessage({
        text: 'Continue in your browser. We\'ll bring you back here when you\'re done.',
        type: 'info',
      })
    } catch {
      setMessage({ text: 'Something went wrong. Try again.', type: 'error' })
      setBusy(false)
    }
  }, [])

  // The parent handles success via supabase-js auth-state-change. This prop
  // is kept for API parity in case we want explicit success flow later.
  void onSuccess

  return (
    <div className="relative min-h-screen bg-cream">
      {/* Titlebar drag region */}
      <div className="titlebar-drag absolute top-0 left-0 right-0 h-8 z-10" />

      {/* Back button — always clickable, never disabled */}
      <button
        onClick={onCancel}
        className="titlebar-no-drag absolute top-3 left-3 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-border text-[12px] font-semibold text-ink hover:bg-cream-mid transition-colors shadow-sm"
        aria-label="Back"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="7.5,3 4.5,6 7.5,9" />
        </svg>
        Back
      </button>

      <div className="flex flex-col items-center justify-center min-h-screen px-8">
        <div className="max-w-sm w-full">
          <h1 className="font-display text-[28px] font-bold text-ink tracking-tight mb-2">Sign in</h1>
          <p className="text-[13px] text-ink-60 mb-8">
            To use unmute's managed cloud, sign in once. You can still use BYOK or Local mode without an account.
          </p>

          <button
            onClick={signInWithGoogle}
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl bg-white text-ink font-semibold text-[13px] mb-3 border border-border disabled:opacity-50 hover:bg-cream-mid transition-colors flex items-center justify-center gap-2.5"
          >
            <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
              <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853" />
              <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05" />
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
            </svg>
            Sign in with Google
          </button>

          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-border" />
            <span className="text-[10px] text-ink-35 font-bold uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl border border-border bg-white text-[13px] mb-3 focus:outline-none focus:border-ink"
            onKeyDown={(e) => e.key === 'Enter' && sendMagicLink()}
          />
          <button
            onClick={sendMagicLink}
            disabled={busy || !email.trim()}
            className="w-full px-4 py-3 rounded-xl border border-border text-ink font-semibold text-[13px] disabled:opacity-50 hover:bg-cream-mid transition-colors"
          >
            Send magic link
          </button>

          {message && (
            <div
              className={`mt-4 text-[12px] px-3 py-2 rounded-lg ${
                message.type === 'error'
                  ? 'bg-red-50 text-red-700'
                  : message.type === 'success'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-cream-mid text-ink-60'
              }`}
            >
              {message.text}
            </div>
          )}

          {/* Paste URL fallback — for when macOS deep-link is wedged */}
          <button
            onClick={() => setShowPaste((s) => !s)}
            className="mt-5 text-[11px] text-ink-35 hover:text-ink-60 transition-colors underline"
          >
            {showPaste ? 'Hide' : "Magic link didn't open the app? Paste the URL"}
          </button>
          {showPaste && (
            <div className="mt-2">
              <input
                type="text"
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                placeholder="unmute://auth/callback#access_token=..."
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-[11px] font-mono focus:outline-none focus:border-ink"
              />
              <button
                onClick={async () => {
                  const u = pasteUrl.trim()
                  if (!u) return
                  const ok = await window.electronAPI.paywallPasteAuthUrl?.(u)
                  setMessage(ok
                    ? { text: 'URL accepted — signing in…', type: 'success' }
                    : { text: 'Not a valid auth URL', type: 'error' })
                  if (ok) setPasteUrl('')
                }}
                className="mt-2 w-full px-3 py-2 rounded-lg bg-ink text-white text-[11px] font-semibold hover:opacity-90 transition-opacity"
              >
                Submit URL
              </button>
              <p className="mt-2 text-[10px] text-ink-35 leading-relaxed">
                In your email, <strong>right-click</strong> the "Sign in" link → <strong>Copy link</strong> → paste here.
              </p>
            </div>
          )}

          <p className="mt-6 text-[11px] text-ink-35 text-center">
            You can always change engines in <span className="font-semibold">Settings → Engine</span>.
          </p>
        </div>
      </div>
    </div>
  )
}
