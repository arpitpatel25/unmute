// Managed-build Onboarding override — the twelve-step flow, plus the
// three-screen "what's new" that existing users get instead (decision D4).
//
// WHAT CHANGED IN THIS PASS, AND WHY.
//
// The flow described the notch and the orchestrator in prose and asked the user
// to believe it. Three screens now SHOW the mechanism instead: the pocket
// answering two different tasks with the same key, a link being copied
// mid-sentence, and a screenshot being taken mid-sentence. Those three are the
// features people do not discover on their own, and a paragraph has never once
// taught them.
//
// THE SURFACE IS SELF-CONTAINED. Onboarding is the only screen a user sees
// before they have any model of the app, so it does not borrow the settings
// control vocabulary — it carries its own, scoped under `.ob`, in a single
// <style> block. Nothing here leaks into the rest of the app and nothing in the
// rest of the app can restyle it. `_shared.tsx` is deliberately NOT imported.
//
// COLOUR. Action is ink, because on cream every cool hue reads as a sticker
// stuck on top. Exactly two status hues do real work: amber = waiting on you,
// green = granted/done. The vendor marks (terracotta Claude, green Codex) are
// the documented exception to "colour = status" — a mark names a maker.
//
// NOTHING IS FAKED. Every state on these screens is read from a real API. There
// is no invented mic level meter and no invented agent-detection scan, because
// `OnboardingAPI` cannot answer either question and a demo that lies during
// setup is worse than a screen that says less.
//
// NO STEP TELLS THE USER TO PRESS A KEY IT HAS NOT LOOKED UP. `dictationKey`
// comes from settings, and the orchestrator label is derived from it — those two
// are the ones that move, and both go through `KEY_LABELS`.
//
// Three key names ARE written literally, and all three are correct to be:
//   * the two options of the dictation-key picker ("Fn (Globe)", "Right
//     Option") — a selector has to name what it is selecting;
//   * the macOS Globe/🌐 tip on the "Your keys" step, which is about a System
//     Settings option rather than an unmute trigger, and is relevant either way
//     round: unmute always holds the Fn key, as dictation or as orchestrate.

import { useState, useEffect, useCallback, useRef } from 'react'
import unmuteLogo from '../assets/unmute-logo.png'
import { useAuth } from '../paywall/AuthContext'
import { vendorsOf, showsVendor, type Vendor } from '../remote/detectedAgents'
import { useDetectedVendors } from '../remote/useDetectedVendors'

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
 *  of the type noise — the idiom the `renderer/remote/` override files use. */
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
  paywallGetSubscription?: () => Promise<{ active: boolean; plan: Plan | null } | null>
  paywallCreateSubscription?: (
    plan: Plan,
    interval: 'month' | 'year',
  ) => Promise<{ ok: boolean; checkoutUrl?: string; alreadySubscribed?: boolean; message?: string }>
  paywallOpenExternal?: (url: string) => Promise<boolean>
  remoteGetSetupStatus?: () => Promise<{ complete: boolean }>
  /** Only the agents detected on this Mac (remote:agent-options). */
  remoteAgentOptions?: () => Promise<{ options: Array<{ id: string }> }>
}
function api(): OnboardingAPI {
  return (window as unknown as { electronAPI?: OnboardingAPI }).electronAPI ?? {}
}

/** Human labels for the two triggers a user can choose between. Every *sentence*
 *  that names a trigger reads from here. */
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

/* ─── Vendor marks ───────────────────────────────────────────────────────
 *
 * Colour means status everywhere else on these screens. These two are the
 * documented exception, because a mark identifies a maker, not a state.
 * They are hand-drawn stand-ins; dropping the official artwork in later
 * means replacing these two components and nothing else.
 */

/** The maker a demo card is drawn as. A maker with no agent on this Mac is
 *  never shown: its card borrows a detected maker's mark instead. */
function shownVendor(vendor: Vendor, detected: readonly Vendor[]): Vendor {
  return detected.length === 0 || detected.includes(vendor) ? vendor : detected[0]
}

function ClaudeMark({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" stroke="#D97757" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
      <path d="M12 2.8v18.4M2.8 12h18.4M5.5 5.5l13 13M18.5 5.5l-13 13" />
    </svg>
  )
}
function CodexMark({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#0f9d78" strokeWidth="1.9" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M12 2.6l8.1 4.7v9.4L12 21.4 3.9 16.7V7.3z" />
      <path d="M12 7.1l4.2 2.45v4.9L12 16.9l-4.2-2.45v-4.9z" />
    </svg>
  )
}

/* ─── The scoped stylesheet ──────────────────────────────────────────────
 *
 * Every selector is a descendant of `.ob`. The wordmark's negative margins are
 * not a fudge: unmute-logo.png is 1280×425 with the artwork at 98,88 → 1198,295,
 * so sizing it by `height` alone renders it at 49% of the box and pushes it
 * ~7px right of anything aligned beneath it. These collapse the box onto the
 * ink, which makes `--wm` the image height and the visible mark 0.489 of it.
 */
const OB_CSS = `
.ob{
  --paper:#f0ede4; --paper-2:#e9e5da; --paper-3:#ded9cb; --card:#fdfcfa;
  --ink:#181614; --ink-2:rgba(24,22,20,.64); --ink-3:rgba(24,22,20,.42);
  --ink-4:rgba(24,22,20,.22); --line:rgba(24,22,20,.10); --line-2:rgba(24,22,20,.16);
  --act:#181614; --act-2:#2f2a24; --act-soft:rgba(24,22,20,.06);
  --flag:#e08a1e; --flag-soft:rgba(224,138,30,.13); --flag-ink:#9c5f0d;
  --good:#1a7d52; --good-soft:rgba(26,125,82,.10);
  --nt:#0d0d0e; --nt-2:#191a1c; --nt-line:rgba(255,255,255,.11);
  --nt-raised:rgba(255,255,255,.08); --nt-text:rgba(255,255,255,.95);
  --nt-dim:rgba(255,255,255,.55); --nt-faint:rgba(255,255,255,.34);
  --display:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;
  --mono:"SF Mono",Menlo,Monaco,ui-monospace,monospace;
  --r1:8px; --r2:12px; --r3:16px;
  --expo:cubic-bezier(.16,1,.3,1); --calm:cubic-bezier(.32,.72,0,1);
  height:100vh;display:flex;flex-direction:column;position:relative;
  background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:13.5px;
  -webkit-font-smoothing:antialiased;
}
.ob *{box-sizing:border-box;margin:0;padding:0}
.ob .track{position:absolute;top:0;left:0;right:0;height:2px;background:rgba(24,22,20,.08);z-index:9}
.ob .track span{display:block;height:100%;background:var(--act);width:8%;transition:width .72s var(--calm)}
.ob .tbar{height:38px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-end;padding:0 20px}
.ob .stepno{font:500 11px var(--sans);font-variant-numeric:tabular-nums;color:var(--ink-2)}
.ob .stage{flex:1;position:relative;overflow:hidden}
.ob .screen{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:safe center;
  padding:24px 40px 16px;overflow-y:auto;animation:ob-in .2s ease-out both}
/* THE COLUMN IS CENTRED, ITS CONTENTS ARE NOT. The app window is wider than
   the layout needs, so left-aligning against the window gutter stranded a band
   of empty paper down the right. Every direct child is now the same centred
   700px column, which keeps one shared left edge for headings and artwork
   while the margins stay even at any window width. */
.ob .screen > *{width:100%;max-width:760px;margin-left:auto;margin-right:auto}
@keyframes ob-in{from{opacity:0}to{opacity:1}}
.ob .foot{flex-shrink:0;padding:16px 56px 22px;display:flex;align-items:center;gap:12px}
.ob .foot .sp{flex:1}
.ob #ob-back{margin-left:-20px}

/* controls */
.ob .btn{font:600 13.5px var(--sans);display:inline-flex;align-items:center;justify-content:center;gap:8px;
  height:36px;padding:0 16px;border-radius:var(--r1);border:1px solid transparent;cursor:pointer;white-space:nowrap;
  transition:background .2s var(--calm),color .2s,border-color .2s,opacity .2s,transform .1s}
.ob .btn:active{transform:scale(.985)}
.ob .btn-primary{background:var(--act);color:#fff}
.ob .btn-primary:hover{background:var(--act-2)}
.ob .btn-secondary{background:var(--card);color:var(--ink);border-color:var(--line-2)}
.ob .btn-secondary:hover{background:var(--paper-2)}
.ob .btn-quiet{background:none;color:var(--ink-3)}
.ob .btn-quiet:hover{background:rgba(24,22,20,.05);color:var(--ink)}
.ob .btn-sm{height:30px;padding:0 13px;font-size:11.5px;border-radius:var(--r1)}
.ob .btn:disabled{opacity:.35;cursor:not-allowed}
.ob :is(button,input,select,a):focus-visible{outline:2px solid var(--act);outline-offset:3px}
.ob .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r3)}
.ob .rows > .row{display:grid;grid-template-columns:var(--lead,1fr) auto;align-items:center;gap:16px;
  padding:15px 18px;border-bottom:1px solid var(--line)}
.ob .rows > .row:last-child{border-bottom:0}
.ob .rows.lead-key > .row{grid-template-columns:118px 1fr auto}
.ob .rows.lead-tile > .row{grid-template-columns:34px 1fr auto}
.ob .rtitle{font-size:13.5px;font-weight:600}
.ob .rsub{font-size:12px;color:var(--ink-3);margin-top:3px;line-height:1.5}
.ob .key{font:700 12px var(--mono);color:rgba(255,255,255,.94);display:inline-flex;align-items:center;
  justify-content:center;height:32px;padding:0 11px;border-radius:var(--r1);white-space:nowrap;
  background:linear-gradient(180deg,#37332d,#1c1a17);border:1px solid rgba(0,0,0,.5);
  box-shadow:0 2px 0 rgba(0,0,0,.5),0 2px 5px rgba(0,0,0,.2);
  transition:transform .13s var(--calm),box-shadow .13s var(--calm)}
.ob .rows.lead-key .key{justify-self:start;min-width:64px}
.ob .key.down{transform:translateY(2px);box-shadow:0 0 0 rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.3)}
.ob .seg{display:inline-flex;background:var(--paper-3);border-radius:var(--r2);padding:3px;gap:3px}
.ob .seg button{font:500 12.5px var(--sans);padding:7px 15px;border:0;border-radius:var(--r1);background:none;
  color:var(--ink-2);cursor:pointer;transition:background .22s var(--calm),color .2s}
.ob .seg button[aria-pressed="true"]{background:var(--card);color:var(--ink);font-weight:600;
  box-shadow:0 1px 3px rgba(24,22,20,.12)}
.ob .badge{display:inline-flex;align-items:center;gap:5px;font:700 10px var(--sans);letter-spacing:.07em;
  text-transform:uppercase;padding:4px 9px;border-radius:99px;white-space:nowrap}
.ob .badge i{width:5px;height:5px;border-radius:50%;background:currentColor}
.ob .badge-good{background:var(--good-soft);color:var(--good)}
.ob .badge-flag{background:var(--flag-soft);color:var(--flag-ink)}
.ob .badge-mute{background:rgba(24,22,20,.07);color:var(--ink-3)}
.ob .tile{width:34px;height:34px;border-radius:var(--r2);display:grid;place-items:center;flex-shrink:0}
.ob .tile-mute{background:rgba(24,22,20,.06);color:var(--ink-3)}
.ob .tile-good{background:var(--good-soft);color:var(--good)}

/* type */
.ob .d1{font:700 38px var(--display);letter-spacing:-.032em;line-height:1.1}
.ob .d2{font:700 28px var(--display);letter-spacing:-.026em;line-height:1.16}
.ob .lead{font-size:15px;color:var(--ink-2);line-height:1.6}
.ob .p{font-size:13px;color:var(--ink-2);line-height:1.6}
.ob .meta{font-size:11.5px;color:var(--ink-3);line-height:1.5}
.ob .eyebrow{font:700 10.5px var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-4)}
.ob .mono{font-family:var(--mono)}
.ob .stack{display:flex;flex-direction:column}
.ob .rowf{display:flex;align-items:center}
.ob .wordmark{display:block;height:var(--wm,40px);width:auto;
  margin-left:calc(var(--wm,40px) * -0.2307);margin-right:calc(var(--wm,40px) * -0.1906);
  margin-top:calc(var(--wm,40px) * -0.2071);margin-bottom:calc(var(--wm,40px) * -0.3035)}

/* the cover is the one centred screen */
.ob .welcome{width:100%;max-width:520px;margin:0 auto;display:flex;flex-direction:column;
  align-items:center;text-align:center}
.ob .welcome .rule{width:40px;height:2px;background:var(--ink-4);border-radius:2px;margin:24px 0}

/* ── the Mac ── */
.ob .mac{width:594px;padding:0 17px;user-select:none}
.ob .macwrap{--ms:.80;width:calc(594px * var(--ms));height:calc(290px * var(--ms));flex-shrink:0}
.ob .macwrap .mac{transform:scale(var(--ms));transform-origin:top left}
/* the capture screens put the machine and the payload side by side. Stacked,
   they ran 112px past the bottom of a 900x640 window and put the attachment
   card — the entire point of the screen — below the fold. */
.ob .demo{display:flex;align-items:flex-start;gap:18px}
.ob .demo .pane{flex:1;min-width:300px}
.ob .demo .cap{margin-top:10px}
.ob .lid{background:#0e0d0c;border-radius:15px;padding:8px 8px 12px;
  box-shadow:0 22px 44px -18px rgba(24,22,20,.5),inset 0 1px 0 rgba(255,255,255,.1)}
.ob .scr{position:relative;height:262px;border-radius:8px;overflow:hidden;
  background:linear-gradient(165deg,#d8cfbd,#bcb09a 50%,#9e9078)}
.ob .base{height:8px;width:106%;margin-left:-3%;border-radius:0 0 10px 10px;
  background:linear-gradient(180deg,#cdc7ba,#8d877c)}
.ob .mbar{position:absolute;top:0;left:0;right:0;height:20px;background:var(--nt);display:flex;
  align-items:center;padding:0 10px;gap:11px;z-index:3}
.ob .mbar b{font:600 9px var(--sans);color:rgba(255,255,255,.9)}
.ob .mbar span{font:400 9px var(--sans);color:rgba(255,255,255,.55)}
.ob .mbar .r{margin-left:auto;display:flex;gap:9px}
.ob .nlab{font:600 9.5px var(--sans);color:var(--nt-dim);white-space:nowrap}
.ob .fdot{width:6px;height:6px;border-radius:50%;background:var(--flag);flex-shrink:0}
.ob .notch{position:absolute;top:0;left:50%;transform:translateX(-50%);z-index:6;min-width:130px;height:25px;
  padding:0 12px;border-radius:0 0 12px 12px;background:var(--nt);display:flex;align-items:center;
  justify-content:center;gap:7px}
.ob .wave{display:flex;align-items:flex-end;gap:2px;height:11px}
.ob .wave b{width:2px;border-radius:1px;background:var(--flag);height:3px;
  animation:ob-wv .55s ease-in-out infinite alternate}
.ob .wave b:nth-child(2){animation-duration:.42s;--h:10px}
.ob .wave b:nth-child(3){animation-duration:.66s;--h:5px}
.ob .wave b:nth-child(4){animation-duration:.48s;--h:11px}
.ob .wave b:nth-child(5){animation-duration:.58s;--h:6px}
@keyframes ob-wv{from{height:3px}to{height:var(--h,8px)}}
.ob .notch .wave b{background:#fff}

/* THE MASS. The pocket is not a card below the notch — it IS the notch, wider
   and taller. One shape, one colour, one animation. */
.ob .mass{position:absolute;top:0;left:50%;transform:translateX(-50%);z-index:7;background:var(--nt);
  width:148px;border-radius:0 0 13px 13px;overflow:hidden;color:var(--nt-text);text-align:left;
  transition:width .52s var(--expo),border-radius .52s var(--expo),box-shadow .45s var(--calm)}
.ob .mass.open{width:290px;border-radius:0 0 18px 18px;box-shadow:0 24px 44px -14px rgba(0,0,0,.7)}
.ob .massbar{height:25px;display:flex;align-items:center;justify-content:center;gap:7px;padding:0 12px}
.ob .massbody{max-height:0;opacity:0;padding:0 12px;
  transition:max-height .52s var(--expo),opacity .3s var(--calm),padding .4s var(--expo)}
.ob .mass.open .massbody{max-height:160px;opacity:1;padding:2px 12px 9px}
.ob .mass .ph{display:flex;align-items:center;gap:7px;padding-right:46px}
.ob .pdot{width:8px;height:8px;border-radius:50%;background:var(--flag);flex-shrink:0}
.ob .pdot.quiet{background:var(--nt-faint)}
.ob .ptitle{font:600 12.5px var(--sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ob .popen{margin-left:auto;font:500 9.5px var(--sans);color:var(--nt-dim);padding:3px 7px;border-radius:5px;
  background:var(--nt-raised);border:.5px solid var(--nt-line)}
.ob .pask{font:400 11px var(--sans);color:var(--nt-dim);line-height:1.42;margin-top:7px;height:31px;
  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ob .prail{display:flex;align-items:center;gap:7px;margin-top:7px}
.ob .parrow{width:26px;height:20px;border-radius:6px;background:var(--nt-raised);border:.5px solid var(--nt-line);
  color:var(--nt-dim);display:grid;place-items:center;cursor:pointer;flex-shrink:0;
  transition:background .2s,color .2s,transform .15s}
.ob .parrow:hover{background:rgba(255,255,255,.16);color:#fff}
.ob .parrow:active{transform:scale(.9)}
.ob .pdots{flex:1;display:flex;justify-content:center;gap:5px}
.ob .pdots i{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.2);
  transition:background .3s var(--calm),width .3s var(--expo)}
.ob .pdots i.at{background:var(--flag);width:13px;border-radius:99px}
.ob .proute{margin-top:8px;font:400 9.5px var(--mono);color:var(--nt-faint);display:flex;align-items:center;
  gap:6px;height:14px}
.ob .pcorner{position:absolute;top:30px;right:9px;display:flex;gap:5px;opacity:0;transition:opacity .3s .1s}
.ob .mass.open .pcorner{opacity:1}
.ob .pcorner button{width:17px;height:17px;border-radius:50%;background:var(--nt-raised);
  border:.5px solid var(--nt-line);color:var(--nt-dim);display:grid;place-items:center;cursor:pointer}
.ob .face{animation:ob-swap .42s var(--expo)}
@keyframes ob-swap{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}

/* terminals — real ones, that receive things */
.ob .term{position:absolute;border-radius:8px;overflow:hidden;background:#fbf9f5;
  border:1px solid rgba(0,0,0,.15);box-shadow:0 16px 32px -12px rgba(0,0,0,.4);
  transition:box-shadow .5s var(--calm),transform .5s var(--expo),opacity .45s var(--calm),filter .45s}
.ob .term .tt{height:19px;background:#eae7e0;border-bottom:1px solid rgba(0,0,0,.07);display:flex;
  align-items:center;gap:4px;padding:0 8px}
.ob .term .tt i{width:6px;height:6px;border-radius:50%;background:rgba(0,0,0,.15)}
.ob .term .tt b{font:600 8px var(--sans);color:rgba(0,0,0,.44);margin-left:6px}
.ob .term .tb{padding:7px 9px;font:400 8.5px var(--mono);color:#4b473f;line-height:1.9;overflow:hidden}
.ob .term .tb div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:ob-tin .45s var(--expo) both}
@keyframes ob-tin{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
.ob .term .ask{color:#b06d10}
.ob .term .you{color:var(--ink);font-weight:700}
.ob .term .go{color:#1a7d52}
.ob .term.a{left:30px;top:44px;width:280px;height:144px;z-index:1}
.ob .term.b{right:22px;top:104px;width:236px;height:132px;z-index:2}
.ob .term.c{left:140px;top:160px;width:216px;height:86px;z-index:3}
.ob .term.focus{box-shadow:0 22px 44px -12px rgba(0,0,0,.5),0 0 0 2px var(--ink);transform:translateY(-3px);z-index:4}
.ob .term.dim{opacity:.42;filter:saturate(.55)}
.ob .beam{position:absolute;inset:0;width:100%;height:100%;z-index:5;pointer-events:none;opacity:0;
  transition:opacity .3s}
.ob .beam.on{opacity:1}
.ob .beam path{fill:none;stroke:var(--ink);stroke-width:1.7;stroke-dasharray:5 4;
  animation:ob-march 1.1s linear infinite}
@keyframes ob-march{to{stroke-dashoffset:-18}}

/* a document on the fake screen, with text you watch get selected */
.ob .docwin{position:absolute;left:48px;top:46px;right:48px;height:150px;border-radius:8px;background:#fbf9f5;
  border:1px solid rgba(0,0,0,.15);box-shadow:0 16px 32px -12px rgba(0,0,0,.4);overflow:hidden}
.ob .docwin .dh{height:19px;background:#eae7e0;border-bottom:1px solid rgba(0,0,0,.07);display:flex;
  align-items:center;gap:4px;padding:0 8px}
.ob .docwin .dh i{width:6px;height:6px;border-radius:50%;background:rgba(0,0,0,.15)}
.ob .docwin .dh b{font:600 8px var(--sans);color:rgba(0,0,0,.44);margin-left:6px}
.ob .docwin .dc{padding:10px 12px}
.ob .docwin .ln{height:5px;border-radius:3px;background:rgba(0,0,0,.09);margin:8px 0}
.ob .docwin .ln.s{width:56%}
.ob .docwin .ln.m{width:84%}
.ob .docwin .ln.err{background:rgba(224,138,30,.55);width:64%}
.ob .hl{border-radius:2px;padding:1px 3px;font-family:var(--mono);font-size:8.5px;
  transition:background .32s var(--calm),color .32s var(--calm)}
.ob .hl.on{background:var(--ink);color:#fff}
.ob .copychip{position:absolute;font:700 8px var(--sans);letter-spacing:.09em;background:var(--ink);color:#fff;
  padding:3px 7px;border-radius:5px;z-index:7;opacity:0;transform:translateY(5px);
  transition:opacity .28s,transform .38s var(--expo)}
.ob .copychip.on{opacity:1;transform:none}
.ob .sel{position:absolute;border:1.5px dashed var(--ink);background:rgba(24,22,20,.09);border-radius:4px;
  opacity:0;z-index:6;transition:width .55s var(--expo),height .55s var(--expo),opacity .22s}
.ob .sel.on{opacity:1}
.ob .cross{position:absolute;width:15px;height:15px;opacity:0;z-index:7;pointer-events:none;
  transition:transform .6s var(--expo),opacity .2s}
.ob .cross.on{opacity:1}
.ob .cross:before,.ob .cross:after{content:"";position:absolute;background:rgba(0,0,0,.8)}
.ob .cross:before{left:6.75px;top:0;width:1.5px;height:15px}
.ob .cross:after{top:6.75px;left:0;height:1.5px;width:15px}
.ob .flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:8}
.ob .flash.go{animation:ob-fl .45s ease-out}
@keyframes ob-fl{0%{opacity:0}16%{opacity:.9}100%{opacity:0}}

/* the delivered payload */
.ob .pane{background:var(--card);border:1px solid var(--line);border-radius:var(--r3);overflow:hidden}
.ob .pane .ph{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;
  font:700 9.5px var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-2)}
.ob .pane .pb{padding:12px 14px 13px}
.ob .mic{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:99px;background:var(--ink);flex-shrink:0}
.ob .mic .d{width:5px;height:5px;border-radius:50%;background:var(--flag);animation:ob-pl 1.3s ease-in-out infinite}
@keyframes ob-pl{0%,100%{opacity:1}50%{opacity:.3}}
.ob .mic .wave b{background:#fff}
.ob .payload{font:400 12px var(--mono);line-height:1.75;min-height:30px}
.ob .uchip{display:inline-flex;align-items:center;gap:5px;vertical-align:-3px;margin:0 3px;padding:2px 7px;
  border-radius:6px;background:var(--act-soft);border:1px solid var(--line-2);color:var(--ink);
  font:600 10.5px var(--mono);white-space:nowrap;animation:ob-in .4s var(--expo) both}
.ob .attach{margin-top:10px;padding-top:9px;border-top:1px dashed var(--line-2)}
.ob .attach .al{font:700 9.5px var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-4);
  margin-bottom:8px}
.ob .shotcard{display:flex;align-items:center;gap:10px;padding:8px;border-radius:var(--r2);
  background:var(--paper-2);border:1px solid var(--line)}
.ob .shotcard .sh{width:46px;height:30px;border-radius:5px;flex-shrink:0;position:relative;overflow:hidden;
  background:linear-gradient(150deg,var(--paper),var(--paper-3) 55%,#c4bba6)}
.ob .shotcard .sh:after{content:"";position:absolute;left:7px;right:7px;top:12px;height:4px;border-radius:3px;
  background:rgba(224,138,30,.85)}
.ob .shotcard .sn{font-size:11.5px;font-weight:600}
.ob .shotcard .ss{font-size:10.5px;color:var(--ink-3);margin-top:1px}
.ob .reveal{animation:ob-in .5s var(--expo) both}
.ob .cap{display:flex;align-items:center;gap:10px;margin-top:14px}
.ob .cap .txt{font-size:12px;color:var(--ink-3)}

@media (prefers-reduced-motion:reduce){
  .ob *,.ob *::before,.ob *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;
    transition-duration:.01ms!important}
}
`

/* ─── Shared chrome ─────────────────────────────────────────────────────── */

function Shell({ step, total, onBack, onNext, nextLabel, nextDisabled, children }: {
  step: number
  total: number
  /** Absent on the first screen; otherwise steps one back. */
  onBack?: () => void
  onNext: () => void
  nextLabel: string
  /** Set on the permissions step, which is not passable until both are on. */
  nextDisabled?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="ob">
      <style>{OB_CSS}</style>
      <div className="titlebar-drag" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 38, zIndex: 1 }} />
      <div className="track"><span style={{ width: `${((step + 1) / total) * 100}%` }} /></div>
      <div className="tbar">
        <span className="stepno">{String(step + 1).padStart(2, '0')} / {total}</span>
      </div>
      <div className="stage">
        <section className="screen" key={step}>{children}</section>
      </div>
      <div className="foot titlebar-no-drag">
        {onBack
          ? <button id="ob-back" className="btn btn-quiet" onClick={onBack}>Back</button>
          : <span />}
        <span className="sp" />
        <button className="btn btn-primary" onClick={onNext} disabled={nextDisabled}>{nextLabel}</button>
      </div>
    </div>
  )
}

/* ─── Demo 1: the pocket ─────────────────────────────────────────────────
 *
 * THE WHOLE POINT, TWICE. One task, speak, it lands. Move the card, speak the
 * same way, and it lands somewhere else. Delivering once proves nothing — it is
 * consistent with the voice always going to the same place. The second delivery
 * is what shows the card is what decides.
 */

type Slot = { name: string; ask: string; vendor: Vendor; demanding: boolean; reply: string; out: string[] }
const SLOTS: Slot[] = [
  { name: 'api-gateway', ask: 'Apply this patch to src/fetch.ts?', vendor: 'claude', demanding: true,
    reply: 'yes, and run the tests', out: ['✓ patch applied', 'running 42 tests…'] },
  { name: 'web-ui', ask: 'Which breakpoint should the sidebar collapse at?', vendor: 'codex', demanding: true,
    reply: 'collapse at 1024, keep the icons', out: ['✓ set to 1024px', 'rebuilding…'] },
  { name: 'docs-site', ask: 'Finished — rewrote the install page.', vendor: 'claude', demanding: false,
    reply: 'ship it', out: ['✓ pushed to main'] },
]
const BASE_LINES: Record<string, { text: string; cls?: string }[]> = {
  'api-gateway': [{ text: '› add retry with backoff' }, { text: 'writing src/fetch.ts…' }, { text: '? apply this patch (y/n)', cls: 'ask' }],
  'web-ui': [{ text: '› collapse the sidebar' }, { text: '? which breakpoint', cls: 'ask' }],
  'docs-site': [{ text: '› rewrite the install page' }, { text: '✓ done in 2m 14s', cls: 'go' }],
}

function PocketDemo({ orchestrateLabel, vendors }: { orchestrateLabel: string; vendors: readonly Vendor[] }) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const [hot, setHot] = useState(false)
  const [caption, setCaption] = useState('Tap the notch to open it.')
  const [lines, setLines] = useState(BASE_LINES)
  const [beam, setBeam] = useState<string | null>(null)
  const scrRef = useRef<HTMLDivElement | null>(null)
  const massRef = useRef<HTMLDivElement | null>(null)
  const timers = useRef<number[]>([])

  const clear = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = [] }
  const run = useCallback((steps: [number, () => void][]) => {
    clear()
    let t = 0
    for (const [d, fn] of steps) { t += d; timers.current.push(window.setTimeout(fn, t)) }
  }, [])

  const push = (name: string, text: string, cls?: string) =>
    setLines((prev) => ({ ...prev, [name]: [...prev[name], { text, cls }].slice(-5) }))

  // PACE. Every beat here is a sentence the viewer has to read before the next
  // one lands, so the timings are reading time, not animation time. The loop
  // restarts through a ref rather than a self-reference so the closure cannot
  // go stale when the key label changes underneath it.
  const playRef = useRef<() => void>(() => {})
  const play = useCallback(() => {
    setLines(BASE_LINES); setOpen(false); setAt(0); setHot(false); setBeam(null)
    setCaption('Tap the notch to open it.')
    run([
      [1000, () => { setOpen(true); setCaption('The card is on api-gateway — everything else dims.') }],
      [1500, () => { setCaption(`Hold ${orchestrateLabel} and talk to it.`) }],
      [1000, () => { setHot(true); setBeam('api-gateway'); setCaption(`Holding ${orchestrateLabel} — routing into api-gateway.`) }],
      [1450, () => push('api-gateway', '› yes, and run the tests', 'you')],
      [900, () => { setHot(false); setBeam(null) }],
      [900, () => { push('api-gateway', '✓ patch applied', 'go'); setCaption('It landed in api-gateway.') }],
      [1000, () => push('api-gateway', 'running 42 tests…')],
      [1700, () => { setAt(1); setCaption('Now step the card to web-ui — same key, different task.') }],
      [1500, () => { setHot(true); setBeam('web-ui'); setCaption(`Holding ${orchestrateLabel} — routing into web-ui.`) }],
      [1450, () => push('web-ui', '› collapse at 1024, keep the icons', 'you')],
      [900, () => { setHot(false); setBeam(null) }],
      [900, () => { push('web-ui', '✓ set to 1024px', 'go'); setCaption('Same key — it landed in web-ui instead.') }],
      [2000, () => { setOpen(false); setCaption('Esc closes it — your voice goes back to normal routing.') }],
      [2200, () => playRef.current()],
    ])
  }, [orchestrateLabel, run])
  playRef.current = play

  useEffect(() => { play(); return clear }, [play])

  const slot = SLOTS[at]
  const move = (d: number) => {
    clear(); setAt((n) => (n + d + SLOTS.length) % SLOTS.length)
    setCaption('That card is where your voice goes.')
  }

  // the beam is drawn in the screen's own coordinate space, which transforms
  // cannot disturb because offsetLeft/offsetTop are pre-transform
  let path = ''
  const scr = scrRef.current
  const mass = massRef.current
  if (beam && scr && mass) {
    const t = scr.querySelector<HTMLElement>(`[data-term="${beam}"]`)
    if (t) {
      const x1 = scr.clientWidth / 2, y1 = mass.offsetTop + mass.offsetHeight
      const x2 = t.offsetLeft + t.offsetWidth / 2, y2 = t.offsetTop
      const my = (y1 + y2) / 2
      path = `M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`
    }
  }

  return (
    <div className="stack" style={{ alignItems: 'flex-start' }}>
      <div className="mac">
        <div className="lid"><div className="scr" ref={scrRef}>
          <div className="mbar"><b>Terminal</b><span>File</span><span>Edit</span>
            <div className="r"><span>Wi-Fi</span><span>9:41</span></div></div>

          <div className={`mass${open ? ' open' : ''}`} ref={massRef} onClick={() => { clear(); setOpen(true) }}>
            <div className="massbar"><span className="fdot" /><span className="nlab">2 waiting on you</span></div>
            <div className="massbody">
              <div className="pcorner">
                <button title="Open the dashboard">
                  <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1.5" /><rect x="9" y="1" width="6" height="6" rx="1.5" /><rect x="1" y="9" width="6" height="6" rx="1.5" /><rect x="9" y="9" width="6" height="6" rx="1.5" /></svg>
                </button>
                <button title="Close — your voice goes back to normal routing"
                  onClick={(e) => { e.stopPropagation(); clear(); setOpen(false); setBeam(null); setHot(false); setCaption('Closed — your voice is back to normal routing.') }}>
                  <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
                </button>
              </div>
              <div className="face" key={at}>
                <div className="ph">
                  <span className={`pdot${slot.demanding ? '' : ' quiet'}`} />
                  {shownVendor(slot.vendor, vendors) === 'claude' ? <ClaudeMark size={11} /> : <CodexMark size={11} />}
                  <span className="ptitle">{slot.name}</span>
                  <button className="popen">Open</button>
                </div>
                <p className="pask">{slot.ask}</p>
              </div>
              <div className="prail">
                <button className="parrow" onClick={(e) => { e.stopPropagation(); move(-1) }}>
                  <svg width="7" height="7" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6.5 1L1.5 6l5 5" /></svg>
                </button>
                <div className="pdots">{SLOTS.map((_, i) => <i key={i} className={i === at ? 'at' : ''} />)}</div>
                <button className="parrow" onClick={(e) => { e.stopPropagation(); move(1) }}>
                  <svg width="7" height="7" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1.5 1l5 5-5 5" /></svg>
                </button>
              </div>
              <div className="proute">
                {hot
                  ? <><svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="rgba(255,255,255,.75)" strokeWidth="1.8" strokeLinecap="round"><path d="M8 2a2.5 2.5 0 0 1 0 5M8 7v6M5 13h6" /></svg>
                      <span className="wave"><b /><b /><b /><b /><b /></span></>
                  : <span>{orchestrateLabel} goes to {slot.name}</span>}
              </div>
            </div>
          </div>

          {(['docs-site', 'api-gateway', 'web-ui'] as const).map((name, i) => (
            <div
              key={name}
              data-term={name}
              className={`term ${['c', 'a', 'b'][i]}${open && slot.name === name ? ' focus' : ''}${open && slot.name !== name ? ' dim' : ''}`}
            >
              <div className="tt"><i /><i /><i /><b>{name} — {name === 'web-ui' ? 'codex' : 'claude'}</b></div>
              <div className="tb">
                {lines[name].map((l, n) => <div key={`${l.text}-${n}`} className={l.cls}>{l.text}</div>)}
              </div>
            </div>
          ))}

          <svg className={`beam${path ? ' on' : ''}`} viewBox={`0 0 ${scr?.clientWidth ?? 0} ${scr?.clientHeight ?? 0}`} preserveAspectRatio="none">
            {path && <path d={path} />}
          </svg>
        </div></div>
        <div className="base" />
      </div>

      <div className="cap" style={{ width: 594 }}>
        <kbd className={`key${hot ? ' down' : ''}`} style={{ minWidth: 104 }}>{orchestrateLabel}</kbd>
        <span className="txt">{caption}</span>
        <button className="btn btn-quiet btn-sm" style={{ marginLeft: 'auto' }} onClick={play}>Replay</button>
      </div>
    </div>
  )
}

/* ─── Demo 2 & 3: what rides along with your voice ───────────────────────
 *
 * The two screens are deliberately a matched pair, because the contrast is the
 * lesson: a link BECOMES PART OF the sentence at the point you copied it, and
 * an image never does — it is filed the instant it is taken and delivered after
 * the text. Both are what `insertRender.ts` actually does.
 */

const LINK_CAPS = ['Listening…', 'Listening…', 'Selecting the link', '⌘C — copied', 'Spliced in where you copied it']

function LinkDemo() {
  const [phase, setPhase] = useState(0)
  const timers = useRef<number[]>([])
  const playRef = useRef<() => void>(() => {})
  const play = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []
    setPhase(0)
    // reading time, not animation time — the highlight landing on the URL is
    // the whole explanation and it needs a beat to be noticed
    const steps = [850, 1150, 700, 950]
    let t = 0
    steps.forEach((d, i) => { t += d; timers.current.push(window.setTimeout(() => setPhase(i + 1), t)) })
    timers.current.push(window.setTimeout(() => playRef.current(), t + 2400))
  }, [])
  playRef.current = play
  useEffect(() => { play(); return () => { timers.current.forEach((t) => window.clearTimeout(t)) } }, [play])

  return (
    <div className="demo">
      <div>
        <div className="macwrap"><div className="mac"><div className="lid"><div className="scr">
          <div className="mbar"><b>Linear</b><span>File</span><span>Edit</span>
            <div className="r"><span>Wi-Fi</span><span>9:41</span></div></div>
          <div className="notch"><span className="fdot" /><span className="wave"><b /><b /><b /><b /><b /></span></div>
          <div className="docwin">
            <div className="dh"><i /><i /><i /><b>UN-214 — sidebar collapse</b></div>
            <div className="dc">
              <div className="ln m" /><div className="ln s" />
              <div style={{ margin: '10px 0' }}>
                <span className={`hl${phase >= 2 && phase < 4 ? ' on' : ''}`}>linear.app/unmute/issue/UN-214</span>
              </div>
              <div className="ln m" /><div className="ln s" />
            </div>
          </div>
          <div className={`copychip${phase === 3 ? ' on' : ''}`} style={{ left: 196, top: 128 }}>⌘C</div>
        </div></div><div className="base" /></div></div>
        <div className="cap">
          <kbd className="key">⌘C</kbd>
          <span className="txt">{LINK_CAPS[phase]}</span>
          <button className="btn btn-quiet btn-sm" style={{ marginLeft: 'auto' }} onClick={play}>Replay</button>
        </div>
      </div>

      <div className="pane">
        <div className="ph">
          <span className="mic"><span className="d" /><span className="wave"><b /><b /><b /><b /><b /></span></span>
          What the task receives
        </div>
        <div className="pb"><div className="payload">
          {phase >= 1 && 'the spec is at'}
          {phase >= 3 && <span className="uchip">linear.app/unmute/issue/UN-214</span>}
          {phase >= 4 && ' — follow the acceptance criteria'}
        </div></div>
      </div>
    </div>
  )
}

const SHOT_CAPS = ['Listening…', 'Listening…', 'Dragging the region', 'Captured', 'Filed as an attachment', 'The sentence carries on']

function ShotDemo() {
  const [phase, setPhase] = useState(0)
  const timers = useRef<number[]>([])
  const playRef = useRef<() => void>(() => {})
  const play = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []
    setPhase(0)
    // the drag has to be watchable, and the attachment appearing BEFORE the
    // sentence resumes is the point of the screen — neither survives a rush
    const steps = [850, 1250, 850, 550, 950]
    let t = 0
    steps.forEach((d, i) => { t += d; timers.current.push(window.setTimeout(() => setPhase(i + 1), t)) })
    timers.current.push(window.setTimeout(() => playRef.current(), t + 2400))
  }, [])
  playRef.current = play
  useEffect(() => { play(); return () => { timers.current.forEach((t) => window.clearTimeout(t)) } }, [play])

  const dragging = phase >= 2 && phase < 4
  return (
    <div className="demo">
      <div>
        <div className="macwrap"><div className="mac"><div className="lid"><div className="scr">
          <div className="mbar"><b>Safari</b><span>File</span><span>Edit</span>
            <div className="r"><span>Wi-Fi</span><span>9:41</span></div></div>
          <div className="notch"><span className="fdot" /><span className="wave"><b /><b /><b /><b /><b /></span></div>
          <div className="docwin">
            <div className="dh"><i /><i /><i /><b>checkout — error state</b></div>
            <div className="dc"><div className="ln m" /><div className="ln s" /><div className="ln err" /><div className="ln m" /><div className="ln s" /></div>
          </div>
          <div className={`sel${dragging ? ' on' : ''}`}
            style={{ left: 60, top: 96, width: dragging ? 200 : 0, height: dragging ? 60 : 0 }} />
          <div className={`cross${dragging ? ' on' : ''}`}
            style={{ transform: dragging ? 'translate(260px,156px)' : 'translate(60px,96px)' }} />
          <div className={`flash${phase === 3 ? ' go' : ''}`} />
        </div></div><div className="base" /></div></div>
        <div className="cap">
          <kbd className="key">⇧⌘4</kbd>
          <span className="txt">{SHOT_CAPS[phase]}</span>
          <button className="btn btn-quiet btn-sm" style={{ marginLeft: 'auto' }} onClick={play}>Replay</button>
        </div>
      </div>

      <div className="pane">
        <div className="ph">
          <span className="mic"><span className="d" /><span className="wave"><b /><b /><b /><b /><b /></span></span>
          What the task receives
        </div>
        <div className="pb">
          <div className="payload">
            {phase >= 1 && 'the error state looks wrong here'}
            {phase >= 5 && ' make the copy match the toast style'}
          </div>
          {phase >= 4 && (
            <div className="attach reveal">
              <div className="al">Attachments · 1</div>
              <div className="shotcard"><span className="sh" />
                <div><p className="sn">Screenshot 9.41.02.png</p>
                  <p className="ss">delivered after the text, not inside it</p></div></div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Small parts ───────────────────────────────────────────────────────── */

function Check() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function Fact({ lead, text }: { lead: string; text: string }) {
  return (
    <div className="row">
      <div className="tile tile-good"><Check /></div>
      <div><p className="rtitle">{lead}</p><p className="rsub">{text}</p></div>
      <span />
    </div>
  )
}

function StaticMac() {
  return (
    <div className="mac">
      <div className="lid"><div className="scr">
        <div className="mbar"><b>Terminal</b><span>File</span><span>Edit</span>
          <div className="r"><span>Wi-Fi</span><span>9:41</span></div></div>
        <div className="notch"><span className="fdot" /><span className="nlab">2 waiting on you</span></div>
        <div className="term c"><div className="tt"><i /><i /><i /><b>docs-site — claude</b></div>
          <div className="tb"><div>› rewrite the install page</div><div className="go">✓ done in 2m 14s</div></div></div>
        <div className="term a"><div className="tt"><i /><i /><i /><b>api-gateway — claude</b></div>
          <div className="tb"><div>› add retry with backoff</div><div>writing src/fetch.ts…</div><div className="ask">? apply this patch (y/n)</div></div></div>
        <div className="term b"><div className="tt"><i /><i /><i /><b>web-ui — codex</b></div>
          <div className="tb"><div>› collapse the sidebar</div><div className="ask">? which breakpoint</div></div></div>
      </div></div>
      <div className="base" />
    </div>
  )
}

/* ─── The flow ──────────────────────────────────────────────────────────── */

export default function Onboarding({ onComplete, onOpenAgentSetup }: OnboardingProps) {
  const [step, setStep] = useState(0)
  const auth = useAuth()

  // ─── Keys, read live from settings ───
  const [dictationKey, setDictationKeyState] = useState<DictationKey>('fn')
  const dictateLabel = KEY_LABELS[dictationKey]
  const orchestrateLabel = KEY_LABELS[otherKey(dictationKey)]

  function chooseDictationKey(value: DictationKey) {
    setDictationKeyState(value)
    api().setDictationKey?.(value)
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
  // The makers with an agent on this Mac. Nothing about a maker that is not
  // installed is shown; empty (unknown, or none installed) keeps both, since
  // then the screens are telling the user what they could install.
  const [agentVendors, setAgentVendors] = useState<Vendor[]>([])

  const refreshAgentStatus = useCallback(async () => {
    try {
      const status = await api().remoteGetSetupStatus?.()
      if (status) setAgentReady(status.complete)
    } catch { /* ignore — the step still offers "later" */ }
    try {
      const picker = await api().remoteAgentOptions?.()
      if (picker) setAgentVendors(vendorsOf(picker.options.map((o) => o.id)))
    } catch { /* ignore — unknown keeps both makers */ }
  }, [])

  useEffect(() => {
    api().getDictationKey?.().then((key) => {
      if (key === 'fn' || key === 'right-option') setDictationKeyState(key)
    }).catch(() => {})
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

  const bothPermissionsGranted = micGranted && accessibilityGranted

  const screens: { key: string; node: React.ReactNode; nextLabel?: string; blocked?: boolean }[] = [
    // ── 0: Welcome ──
    {
      key: 'welcome',
      nextLabel: 'Get started',
      node: (
        <div className="welcome">
          <img className="wordmark" src={unmuteLogo} alt="unmute" style={{ ['--wm' as string]: '74px', ['--i' as string]: 0 }} />
          <p className="meta" style={{ marginTop: 14, ['--i' as string]: 0 }}>Typing sucks. Just unmute.</p>
          <div className="rule" style={{ ['--i' as string]: 1 }} />
          <h1 className="d1" style={{ ['--i' as string]: 2 }}>Stop typing.<br />Just talk.</h1>
          <p className="lead" style={{ marginTop: 14, ['--i' as string]: 3 }}>
            unmute turns your voice into text anywhere on your Mac — a message, a
            document, a search box. Hold a key, say it, let go.
          </p>
        </div>
      ),
    },

    // ── 1: Three things, three keys ──
    {
      key: 'what',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">The idea</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Two ways to talk</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 540 }}>
              Use Dictation for the app under your cursor, or speak directly to a session.
            </p>
          </div>
          <div className="card rows lead-key" style={{ marginTop: 20, ['--i' as string]: 1 }}>
            <div className="row"><kbd className="key">{dictateLabel}</kbd>
              <div><p className="rtitle">Dictate</p>
                <p className="rsub">Tap it, speak, tap again. Raw text lands exactly where your cursor is, in any app.</p></div>
              <span /></div>
            <div className="row"><kbd className="key">{orchestrateLabel}</kbd>
              <div><p className="rtitle">Orchestrate</p>
                <p className="rsub">Describe a job out loud. A coding agent runs it on your Mac and reports back when it is done.</p></div>
              <span /></div>
          </div>
        </>
      ),
    },

    // ── 2: The notch ──
    {
      key: 'notch',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">The notch</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Work you hand off lives up there</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 600 }}>
              Not in this window. It lives in the strip at the very top of your screen,
              around the camera — and the notch widens the moment one of them needs you.
            </p>
          </div>
          <div style={{ marginTop: 16, ['--i' as string]: 1 }}><StaticMac /></div>
        </>
      ),
    },

    // ── 3: The pocket ──
    {
      key: 'pocket',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">The pocket</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Tap the notch. Answer without leaving.</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 640 }}>
              One task on the card at a time. Step through with ‹ › until the one you mean
              is showing, then hold {orchestrateLabel} and talk to it.
            </p>
          </div>
          <div style={{ marginTop: 14, ['--i' as string]: 1 }}><PocketDemo orchestrateLabel={orchestrateLabel} vendors={agentVendors} /></div>
        </>
      ),
    },

    // ── 4: A link, mid-sentence ──
    {
      key: 'link',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">While you talk · 1 of 2</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Copy a link mid-sentence</h2>
            <p className="lead" style={{ marginTop: 8, maxWidth: 580 }}>
              A link or a file path reads as part of the sentence, so it is spliced in
              exactly where you copied it.
            </p>
          </div>
          <div style={{ marginTop: 12, ['--i' as string]: 1 }}><LinkDemo /></div>
        </>
      ),
    },

    // ── 5: A screenshot, mid-sentence ──
    {
      key: 'shot',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">While you talk · 2 of 2</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Screenshot mid-sentence</h2>
            <p className="lead" style={{ marginTop: 8, maxWidth: 580 }}>
              An image never joins the sentence. It is filed the moment you take it, and
              arrives <strong>after</strong> your text.
            </p>
          </div>
          <div style={{ marginTop: 12, ['--i' as string]: 1 }}><ShotDemo /></div>
        </>
      ),
    },

    // ── 6: What leaves your Mac ──
    // Copy is fixed (spec §3, decision D3) and traced line by line through the
    // backend. Do not soften it, do not shorten it, do not improvise.
    {
      key: 'privacy',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">Privacy</span>
            <h2 className="d2" style={{ marginTop: 8 }}>What leaves your Mac</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 540 }}>
              Written plainly, because the honest answer is not “nothing”.
            </p>
          </div>
          <div className="card rows lead-tile" style={{ marginTop: 20, ['--i' as string]: 1 }}>
            <Fact lead="Dictation audio" text="goes to our transcription service and is discarded the moment the text comes back. We keep a timestamp, a duration and the model name so we can bill you — never the audio, never the text." />
            <Fact lead="Orchestrator tasks never reach us." text="The agent runs on your Mac, under your own account, with your own credentials. unmute passes it your words and reads its status back." />
            <Fact lead="On-device mode sends nothing at all." text="No account, no network." />
            <Fact lead="Diagnostics stay here." text="unmute keeps a local log of how each dictation was served — for seven days, on this Mac, never uploaded. It does not contain what you said." />
          </div>
        </>
      ),
    },

    // ── 7: Pick a plan ──
    {
      key: 'plan',
      node: subscription?.active ? (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">Plan</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Pick a plan</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 540 }}>
              You are already subscribed. Nothing to do here.
            </p>
          </div>
          <div className="card rows" style={{ marginTop: 20, ['--i' as string]: 1 }}>
            <div className="row">
              <div><p className="rtitle">{subscription.plan === 'unmute' ? 'On the Unmute plan' : 'On the Dictation plan'}</p>
                <p className="rsub">Change or cancel it any time from Account.</p></div>
              <span className="badge badge-good"><i />Active</span>
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">Plan</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Pick a plan</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 540 }}>
              Cloud transcription is a subscription. Cancel any time from Account.
            </p>
          </div>
          <div className="card rows" style={{ marginTop: 20, ['--i' as string]: 1 }}>
            {PLANS.map((tier) => (
              <div className="row" key={tier.plan}>
                <div><p className="rtitle">{tier.name}</p><p className="rsub">{tier.tagline}</p></div>
                {tier.recommended
                  ? <span className="badge badge-mute">Recommended</span>
                  : <span />}
                <div className="rowf" style={{ gap: 14 }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{tier.price}</span>
                  <button
                    className={tier.recommended ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                    disabled={checkoutPlan === tier.plan}
                    onClick={() => startCheckout(tier.plan)}
                  >
                    {checkoutPlan === tier.plan ? 'Waiting…' : auth.signedIn ? 'Choose' : 'Sign in'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {checkoutPlan && (
            <p className="meta" style={{ marginTop: 12, maxWidth: 460, ['--i' as string]: 2 }}>
              Finish checkout in your browser, then come back — this screen updates itself.
            </p>
          )}
          {checkoutError && (
            <p className="meta" style={{ marginTop: 12, maxWidth: 460, color: 'var(--flag-ink)', ['--i' as string]: 2 }}>{checkoutError}</p>
          )}
          <p className="meta" style={{ marginTop: 14, maxWidth: 460, ['--i' as string]: 3 }}>
            Continuing without a plan leaves you on the on-device model. It runs entirely
            offline and sends nothing anywhere. It is slower and less accurate, and it
            cannot run agents.
          </p>
        </>
      ),
    },

    // ── 8: Two permissions ──
    // Neither is skippable. Without Accessibility the app is inert: it cannot
    // see the trigger key and cannot type at the cursor, so an escape hatch on
    // this step only ever produced a silently broken install.
    {
      key: 'permissions',
      blocked: !bothPermissionsGranted,
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">Setup</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Two permissions</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 560 }}>
              Both are required. Without them unmute cannot hear you and cannot type for
              you — it does nothing at all.
            </p>
          </div>
          <div className="card rows lead-tile" style={{ marginTop: 20, ['--i' as string]: 1 }}>
            <div className="row">
              <div className={micGranted ? 'tile tile-good' : 'tile tile-mute'}>
                {micGranted ? <Check /> : (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                    <path d="M8 2a2.5 2.5 0 0 1 0 5M5.5 2a5 5 0 0 0 0 5M8 7v6M5 13h6" />
                  </svg>
                )}
              </div>
              <div>
                <p className="rtitle">Microphone</p>
                <p className="rsub">
                  {micStatus === 'denied' || micStatus === 'restricted'
                    ? 'Turned off right now. Open System Settings, find unmute under Microphone, switch it on, then come back.'
                    : 'Required — unmute needs your microphone to hear what you say. Audio is transcribed and discarded, never recorded.'}
                </p>
              </div>
              {micGranted
                ? <span className="badge badge-good"><i />Granted</span>
                : (
                  <div className="rowf" style={{ gap: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => api().openMicSettings?.()}>System Settings</button>
                    <button className="btn btn-primary btn-sm" onClick={() => { void requestMicPermission() }}>Grant access</button>
                  </div>
                )}
            </div>

            <div className="row">
              <div className={accessibilityGranted ? 'tile tile-good' : 'tile tile-mute'}>
                {accessibilityGranted ? <Check /> : (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                    <rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M5 6.5h1.5M5 9.5h6M8.5 6.5H11" />
                  </svg>
                )}
              </div>
              <div>
                <p className="rtitle">Accessibility</p>
                <p className="rsub">
                  {accessibilityGranted
                    ? 'Required — this is how unmute sees your trigger key and pastes text at the cursor.'
                    : 'Required — this is how unmute sees your trigger key and pastes text at the cursor. Find unmute in the list and switch it on; you may need to unlock with your password first.'}
                </p>
              </div>
              {accessibilityGranted
                ? <span className="badge badge-good"><i />Granted</span>
                : (
                  <div className="rowf" style={{ gap: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => { void refreshAccessibilityStatus() }}>I have enabled it</button>
                    <button className="btn btn-primary btn-sm" onClick={() => { void requestAccessibility() }}>Open System Settings</button>
                  </div>
                )}
            </div>
          </div>
          {!bothPermissionsGranted && (
            <p className="meta" style={{ marginTop: 14, ['--i' as string]: 2 }}>
              This screen updates by itself once both are on.
            </p>
          )}
        </>
      ),
    },

    // ── 9: Your keys ──
    {
      key: 'keys',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">Setup</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Choose your dictation key</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 540 }}>
              Sessions use the other key.
            </p>
          </div>
          <div style={{ marginTop: 18, ['--i' as string]: 1 }}>
            <div className="seg">
              <button aria-pressed={dictationKey === 'fn'} onClick={() => chooseDictationKey('fn')}>Fn (Globe)</button>
              <button aria-pressed={dictationKey === 'right-option'} onClick={() => chooseDictationKey('right-option')}>Right Option</button>
            </div>
          </div>
          <div className="card rows lead-key" style={{ marginTop: 16, ['--i' as string]: 2 }}>
            <div className="row"><kbd className="key">{dictateLabel}</kbd>
              <div><p className="rtitle">Dictate</p><p className="rsub">Speak, and the text lands at your cursor.</p></div><span /></div>
            <div className="row"><kbd className="key">{orchestrateLabel}</kbd>
              <div><p className="rtitle">Orchestrate</p><p className="rsub">Describe a job and hand it to your agent.</p></div><span /></div>
          </div>
          <div className="card" style={{ marginTop: 14, padding: '14px 18px', ['--i' as string]: 3 }}>
            <div className="rowf" style={{ gap: 16 }}>
              <p className="p" style={{ flex: 1 }}>
                <strong>One macOS tweak:</strong> the Globe key shows emoji by default, and
                unmute is using it for <strong>{dictationKey === 'fn' ? 'dictation' : 'orchestrate'}</strong>.
                Set <strong>“Press 🌐 key to” → Do Nothing</strong> in Keyboard settings.
              </p>
              <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }}
                onClick={() => api().openKeyboardSettings?.()}>Open Keyboard Settings</button>
            </div>
          </div>
        </>
      ),
    },

    // ── 10: Connect an agent — optional, and deferrable ──
    {
      key: 'agent',
      nextLabel: agentReady ? 'Continue' : 'I’ll do this later',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">Setup</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Connect an agent</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 600 }}>
              {agentVendors.length === 0
                ? 'Orchestrate needs a coding agent already installed on your Mac — Claude Code or Codex.'
                : 'Orchestrate runs on the coding agent already installed on your Mac.'}
              {' '}It runs under your own account with your own credentials; unmute is
              never in the credential path.
            </p>
          </div>
          <div className="card rows lead-tile" style={{ marginTop: 20, ['--i' as string]: 1 }}>
            {showsVendor(agentVendors, 'claude') && (
              <div className="row">
                <div className="tile tile-mute"><ClaudeMark size={14} /></div>
                <div><p className="rtitle">Claude Code</p><p className="rsub">The CLI, running in your own terminal</p></div>
                <span />
              </div>
            )}
            {showsVendor(agentVendors, 'codex') && (
              <div className="row">
                <div className="tile tile-mute"><CodexMark size={14} /></div>
                <div><p className="rtitle">Codex</p><p className="rsub">Your account, your credentials</p></div>
                <span />
              </div>
            )}
          </div>
          {agentReady ? (
            <div className="rowf" style={{ gap: 10, marginTop: 16, ['--i' as string]: 2 }}>
              <span className="badge badge-good"><i />An agent is connected</span>
            </div>
          ) : (
            <>
              <p className="meta" style={{ marginTop: 14, maxWidth: 600, ['--i' as string]: 2 }}>
                Setup takes about a minute and is not one-way — you can add a second agent
                months from now, and the same page is always there under Orchestrator when
                a connection needs repairing.
              </p>
              {onOpenAgentSetup && (
                <div style={{ marginTop: 14, ['--i' as string]: 3 }}>
                  <button className="btn btn-secondary" onClick={onOpenAgentSetup}>Set it up now</button>
                </div>
              )}
            </>
          )}
        </>
      ),
    },

    // ── 11: Ready ──
    {
      key: 'ready',
      nextLabel: 'Start using unmute',
      node: (
        <div className="stack" style={{ alignItems: 'flex-start', gap: 18 }}>
          <div className="tile tile-good" style={{ width: 48, height: 48, borderRadius: 16, ['--i' as string]: 0 }}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 className="d1" style={{ ['--i' as string]: 1 }}>You’re set.</h2>
          <p className="lead" style={{ maxWidth: 460, ['--i' as string]: 2 }}>
            Hold your key and start talking. Tap the notch whenever something is waiting on you.
          </p>
          <div className="card rows lead-key" style={{ width: 520, ['--i' as string]: 3 }}>
            <div className="row"><kbd className="key">{dictateLabel}</kbd>
              <div><p className="rtitle">Dictate anywhere</p></div>
              <span className="badge badge-good">Ready</span></div>
            <div className="row"><kbd className="key">{orchestrateLabel}</kbd>
              <div><p className="rtitle">Speak into the pocket</p></div>
              <span className="badge badge-good">Ready</span></div>
          </div>
        </div>
      ),
    },
  ]

  const current = screens[step]

  return (
    <Shell
      step={step}
      total={screens.length}
      onBack={step > 0 ? () => setStep(step - 1) : undefined}
      onNext={() => { if (step < screens.length - 1) setStep(step + 1); else onComplete() }}
      nextLabel={current.nextLabel ?? 'Continue'}
      nextDisabled={current.blocked}
    >
      {current.node}
    </Shell>
  )
}

/* ─── What's new (decision D4) ─────────────────────────────────────────
 *
 * Users who finished the old flow are on version 1. Twelve steps would be an
 * insult to someone already using the product daily, and skipping it entirely
 * would leave them never hearing about the things that actually changed.
 * Three screens, then straight into the app.
 */

export function WhatsNew({ onComplete, onOpenAgentSetup }: OnboardingProps) {
  const agentVendors = useDetectedVendors()
  const [step, setStep] = useState(0)
  const [dictationKey, setDictationKey] = useState<DictationKey>('fn')
  const orchestrateLabel = KEY_LABELS[otherKey(dictationKey)]

  useEffect(() => {
    api().getDictationKey?.().then((key) => {
      if (key === 'fn' || key === 'right-option') setDictationKey(key)
    }).catch(() => {})
  }, [])

  const screens: { key: string; node: React.ReactNode; nextLabel?: string }[] = [
    {
      key: 'agents',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">What’s new</span>
            <h2 className="d2" style={{ marginTop: 8 }}>unmute runs coding agents now</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 600 }}>
              Tap {orchestrateLabel} — whichever key dictation is not using — and describe a
              job out loud. A coding agent runs it on your Mac, under your own account, and
              reports back. Dictation works exactly as it did.
            </p>
          </div>
          {onOpenAgentSetup && (
            <div style={{ marginTop: 16, ['--i' as string]: 1 }}>
              <button className="btn btn-secondary" onClick={onOpenAgentSetup}>Take me to agent setup</button>
            </div>
          )}
        </>
      ),
    },
    {
      key: 'pocket',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">What’s new</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Tap the notch. Answer without leaving.</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 640 }}>
              Handed-off work lives in the strip at the top of your screen. Tap it, step
              through with ‹ › until the task you mean is on the card, hold {orchestrateLabel},
              and your words land in that terminal.
            </p>
          </div>
          <div style={{ marginTop: 14, ['--i' as string]: 1 }}><PocketDemo orchestrateLabel={orchestrateLabel} vendors={agentVendors} /></div>
        </>
      ),
    },
    {
      key: 'pricing',
      nextLabel: 'Got it',
      node: (
        <>
          <div style={{ ['--i' as string]: 0 }}>
            <span className="eyebrow">What’s new</span>
            <h2 className="d2" style={{ marginTop: 8 }}>Pricing is a subscription</h2>
            <p className="lead" style={{ marginTop: 12, maxWidth: 600 }}>
              Pay-as-you-go credits are gone. Two flat tiers instead — Dictation at $4.99/mo,
              or Unmute at $7.99/mo for dictation plus Orchestrate. Cancel any time from Account.
            </p>
          </div>
        </>
      ),
    },
  ]

  const current = screens[step]

  return (
    <Shell
      step={step}
      total={screens.length}
      onBack={step > 0 ? () => setStep(step - 1) : undefined}
      onNext={() => { if (step < screens.length - 1) setStep(step + 1); else onComplete() }}
      nextLabel={current.nextLabel ?? 'Continue'}
    >
      {current.node}
    </Shell>
  )
}
