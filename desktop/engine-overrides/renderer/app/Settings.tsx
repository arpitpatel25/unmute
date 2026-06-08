// Settings tab — behavior + preferences only.
//
// Account-shaped concerns (Engine, Groq API key, Billing, Usage) and
// macOS permissions (Mic, Accessibility, offline model, Fn-key tip) live
// in their own top-level tabs (Account.tsx, Permissions.tsx). This file
// is intentionally just "how the app behaves" knobs.
//
// All IPC calls + settings keys preserved verbatim from the previous
// monolithic Settings — only the JSX layout changed.

import { useState, useEffect } from 'react'
import {
  SectionHeader,
  Toggle,
  SegmentedControl,
  SegmentedControlDark,
  HeroKey,
  MiniWave,
  SettingRow,
  MicIcon,
  BehaviorIcon,
  AppearanceIcon,
} from './_shared'

interface AudioDevice {
  deviceId: string
  label: string
}

interface SettingsProps {
  onDictationKeyChange?: (key: 'fn' | 'right-option') => void
}

export default function Settings({ onDictationKeyChange }: SettingsProps = {}) {
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [outputMode, setOutputMode] = useState<'paste' | 'clipboard'>('paste')
  const [launchAtLogin, setLaunchAtLogin] = useState(true)
  const [soundFeedback, setSoundFeedback] = useState(true)
  const [autoPunctuation, setAutoPunctuation] = useState(true)
  const [inputLanguage, setInputLanguage] = useState<'en' | 'hinglish'>('en')
  const [widgetPosition, setWidgetPosition] = useState<'center' | 'right'>('center')
  const [dictationKey, setDictationKey] = useState<'fn' | 'right-option'>('fn')
  const [activationMode, setActivationMode] = useState<'tap-toggle' | 'push-to-talk' | 'double-tap-push'>('tap-toggle')
  const [instructionEnabled, setInstructionEnabled] = useState<boolean>(true)

  useEffect(() => {
    loadAudioDevices()
    window.electronAPI.getWidgetPosition().then((v: string) => {
      if (v === 'center' || v === 'right') setWidgetPosition(v)
    })
    window.electronAPI.getSoundFeedback().then((v: boolean) => {
      setSoundFeedback(v)
    })
    window.electronAPI.getInputLanguage().then((v: string) => {
      if (v === 'en' || v === 'hinglish') setInputLanguage(v)
    })
    window.electronAPI.getDictationKey().then((v: string) => {
      if (v === 'fn' || v === 'right-option') setDictationKey(v)
    })
    window.electronAPI.getActivationMode().then((v: string) => {
      if (v === 'tap-toggle' || v === 'push-to-talk' || v === 'double-tap-push') setActivationMode(v)
    })
    // AI format on/off — falls back to true if the IPC isn't present
    // (e.g., running against an older main process during dev).
    window.electronAPI.paywallGetInstructionEnabled?.()
      .then((v: boolean) => setInstructionEnabled(v !== false))
      .catch(() => {})
  }, [])

  async function loadAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const audioInputs = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }))
      setAudioDevices(audioInputs)
      if (audioInputs.length > 0 && !selectedDevice) {
        setSelectedDevice(audioInputs[0].deviceId)
      }
    } catch (err) {
      console.error('Failed to enumerate audio devices:', err)
    }
  }

  function handleWidgetPositionChange(value: string) {
    const pos = value as 'center' | 'right'
    setWidgetPosition(pos)
    window.electronAPI.setWidgetPosition(pos)
  }

  function handleSoundFeedbackChange(value: boolean) {
    setSoundFeedback(value)
    window.electronAPI.setSoundFeedback(value)
  }

  function handleInputLanguageChange(value: string) {
    const lang = value as 'en' | 'hinglish'
    setInputLanguage(lang)
    window.electronAPI.setInputLanguage(lang)
  }

  function handleDictationKeyChange(value: string) {
    const key = value as 'fn' | 'right-option'
    setDictationKey(key)
    window.electronAPI.setDictationKey(key)
    onDictationKeyChange?.(key)
  }

  function handleActivationModeChange(value: string) {
    const mode = value as 'tap-toggle' | 'push-to-talk' | 'double-tap-push'
    setActivationMode(mode)
    window.electronAPI.setActivationMode(mode)
  }

  return (
    <div className="max-w-lg">
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-6">Settings</h2>

      {/* ═══ Dark Hero: Keyboard Shortcuts ═══ */}
      <div className="bg-ink rounded-[20px] mb-3 overflow-hidden shadow-lg relative">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(255,255,255,0.04)_0%,transparent_50%)] pointer-events-none" />
        <div className="px-6 pt-5">
          <div className="text-[9px] font-bold tracking-[0.12em] uppercase text-white/28 mb-1">⌨ Keyboard Shortcuts</div>
          <div className="text-[18px] font-extrabold tracking-tight text-white/90">Your triggers</div>
        </div>
        <div className="p-5 pt-4 flex flex-col gap-2.5">
          {/* Dictation */}
          <div className="px-4 py-3.5 bg-white/[0.055] border border-white/[0.08] rounded-[13px]">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-[13px] font-medium text-white/88 mb-0.5">Dictation trigger</h4>
                <p className="text-[11px] text-white/36">
                  {activationMode === 'tap-toggle' && 'Tap to start, tap again to stop'}
                  {activationMode === 'push-to-talk' && 'Hold to record, release to submit'}
                  {activationMode === 'double-tap-push' && 'Double-tap for hands-free, or hold for push-to-talk'}
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <MiniWave />
                <HeroKey>{dictationKey === 'fn' ? 'Fn' : 'Right Opt'}</HeroKey>
              </div>
            </div>
            {/* Dictation key selector */}
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11px] text-white/44">Dictation key</span>
              <SegmentedControlDark
                options={[
                  { value: 'fn', label: 'Fn (Globe)' },
                  { value: 'right-option', label: 'Right Option' },
                ]}
                value={dictationKey}
                onChange={handleDictationKeyChange}
              />
            </div>
            {/* Activation mode selector */}
            <div className="mt-2.5 flex items-center justify-between">
              <span className="text-[11px] text-white/44">Activation mode</span>
              <SegmentedControlDark
                options={[
                  { value: 'tap-toggle', label: 'Tap toggle' },
                  { value: 'push-to-talk', label: 'Push to talk' },
                  { value: 'double-tap-push', label: 'Dual mode' },
                ]}
                value={activationMode}
                onChange={handleActivationModeChange}
              />
            </div>
          </div>
          {/* Instruction */}
          <div className="flex items-center justify-between px-4 py-3.5 bg-white/[0.055] border border-white/[0.08] rounded-[13px] hover:bg-white/[0.085] transition-colors">
            <div>
              <h4 className="text-[13px] font-medium text-white/88 mb-0.5">AI format (Instruction trigger)</h4>
              <p className="text-[11px] text-white/36">
                {instructionEnabled
                  ? 'Tap to start, tap again to instruct AI'
                  : 'Disabled — Caps Lock works as a normal key'}
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              {instructionEnabled && <MiniWave />}
              {instructionEnabled ? (
                <HeroKey variant="red">Caps Lock</HeroKey>
              ) : (
                <HeroKey>Off</HeroKey>
              )}
              <Toggle
                checked={instructionEnabled}
                onChange={(next) => {
                  setInstructionEnabled(next)
                  window.electronAPI.paywallSetInstructionEnabled?.(next)
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ═══ Audio ═══ */}
      <SectionHeader icon={<MicIcon />} title="Audio" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <SettingRow label="Microphone" description="Select your input device">
          <div className="relative inline-flex items-center">
            <select
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              className="appearance-none bg-cream-mid border border-border-md rounded-full px-3.5 py-2 pr-8 text-[12px] font-medium text-ink outline-none cursor-pointer shadow-sm min-w-[180px]"
            >
              {audioDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <span className="absolute right-3 text-[13px] text-ink-35 pointer-events-none">⌄</span>
          </div>
        </SettingRow>
      </div>

      {/* ═══ Behavior ═══ */}
      <SectionHeader icon={<BehaviorIcon />} title="Behavior" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <SettingRow label="Output mode" description="How output is delivered">
          <SegmentedControl
            options={[
              { value: 'paste', label: 'Paste at cursor' },
              { value: 'clipboard', label: 'Clipboard' },
            ]}
            value={outputMode}
            onChange={(v) => setOutputMode(v as 'paste' | 'clipboard')}
          />
        </SettingRow>
        <SettingRow label="Sound feedback" description="Play sounds on start / stop">
          <Toggle checked={soundFeedback} onChange={handleSoundFeedbackChange} />
        </SettingRow>
        <SettingRow label="Input language" description={inputLanguage === 'hinglish' ? "Hinglish mode — Hindi + English mix, output in Roman script" : "English — standard dictation"}>
          <SegmentedControl
            options={[
              { value: 'en', label: 'English' },
              { value: 'hinglish', label: 'Hinglish' },
            ]}
            value={inputLanguage}
            onChange={handleInputLanguageChange}
          />
        </SettingRow>
        <SettingRow label="Auto-punctuation" description="Add punctuation automatically">
          <Toggle checked={autoPunctuation} onChange={setAutoPunctuation} />
        </SettingRow>
        <SettingRow label="Launch at login" description="Start Unmute when you log in">
          <Toggle checked={launchAtLogin} onChange={setLaunchAtLogin} />
        </SettingRow>
      </div>

      {/* ═══ Appearance ═══ */}
      <SectionHeader icon={<AppearanceIcon />} title="Appearance" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <SettingRow label="Widget position" description="Where the pill appears on screen">
          <SegmentedControl
            options={[
              { value: 'center', label: 'Top center' },
              { value: 'right', label: 'Top right' },
            ]}
            value={widgetPosition}
            onChange={handleWidgetPositionChange}
          />
        </SettingRow>
      </div>

      {/* ═══ Help ═══ */}
      <SectionHeader icon={<BehaviorIcon />} title="Help" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <SettingRow label="Replay onboarding" description="Walk through the welcome and setup steps again">
          <button
            onClick={() => {
              localStorage.removeItem('unmute_onboarding_complete')
              location.reload()
            }}
            className="px-4 py-2 rounded-full border border-border text-[12px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all duration-200"
          >
            Replay
          </button>
        </SettingRow>
      </div>
    </div>
  )
}
