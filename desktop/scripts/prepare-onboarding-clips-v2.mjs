#!/usr/bin/env node
// Prepare founder recordings for the Electron presenter without cutting speech.
// Originals in Downloads are read-only. Outputs stay staged until reviewed.
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const downloads = '/Users/zodpatel/Downloads'
const sourceDir = path.join(downloads, 'Unmute onboarding part 2')
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : null
if (!outDir) throw new Error('Usage: node prepare-onboarding-clips-v2.mjs /staging-directory')
const onlyStem = process.argv[3]?.startsWith('--') ? null : process.argv[3]
const captionsOnly = process.argv.includes('--captions-only')
const outputFps = 30
const frame = seconds => Math.round(seconds * outputFps) / outputFps

const jobs = [
  ['welcome-product-v2', 'Introduce Unmute for Mac.mp4', 'introduce-unmute-for-mac-4ird_subtitles.srt'],
  ['privacy-v2', 'Privacy and Dictation Notice.mp4', 'privacy-and-dictation-notice-ehei_subtitles.srt'],
  ['permission-microphone-v2', 'Enabling Microphone Access for Unmute.mp4', 'enabling-microphone-access-for-unmute-0atu_subtitles.srt'],
  ['permission-accessibility-v2', 'Enabling Accessibility for Unmute.mp4', 'enabling-accessibility-for-unmute-7ktl_subtitles.srt'],
  ['function-key-readiness-v2', 'Configuring Mac OS Keyboard Settings for Dictation.mp4', 'configuring-mac-os-keyboard-settings-for-dictation-hxtf_subtitles.srt'],
  ['permission-system-audio-v2', 'Enabling System Audio for Unmute.mp4', 'enabling-system-audio-for-unmute-5m99_subtitles.srt'],
  ['provider-readiness-v2', 'Using Unmute with Your Copilot Plan.mp4', 'using-unmute-with-your-copilot-plan-22eh_subtitles.srt'],
  ['dictation-explain-v2', 'Using Dictation in Apple Notes (1).mp4', 'using-dictation-in-apple-notes-9jad_subtitles.srt'],
  ['capture-clipboard-v2', 'Dictating with Copied Text and Links.mp4', 'dictating-with-copied-text-and-links-9bmm_subtitles.srt'],
  ['capture-screenshot-v2', 'Streamline Your Workflow with Voice Dictation and Screenshots.mp4', 'streamline-your-workflow-with-voice-dictation-and-screenshots-ed58_subtitles.srt'],
  ['orchestrator-explain-v2', 'Trigger AI Tasks Anywhere on Mac.mp4', 'trigger-ai-tasks-anywhere-on-mac-3cqu_subtitles.srt'],
  ['agent-explain-v2', 'Introduction to Unmute Agent.mp4', 'introduction-to-unmute-agent-g72z_subtitles.srt'],
  ['notetaker-explain-v2', 'Unmute AI Note Taker & Agent.mp4', 'unmute-ai-note-taker-agent-e56w_subtitles.srt'],
  ['orientation-v2', 'Introduction to Unmute.mp4', 'introduction-to-unmute-6hi5_subtitles.srt'],
]

const stamp = seconds => {
  const millis = Math.round(seconds * 1000)
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return `${pad(Math.floor(millis / 3600000))}:${pad(Math.floor(millis / 60000) % 60)}:${pad(Math.floor(millis / 1000) % 60)},${pad(millis % 1000, 3)}`
}
const seconds = value => {
  const [hours, minutes, rest] = value.replace(',', '.').split(':')
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest)
}

function correct(text) {
  return text.replace(/\s+/g, ' ').trim()
    .replace(/\bclot(?:\s+code)?\b/gi, 'Claude Code')
    .replace(/\bclaud\b/gi, 'Claude')
    .replace(/\bcodecs?\b/gi, 'Codex')
    .replace(/\bclaude code\b/gi, 'Claude Code')
    .replace(/\bclaude\b/gi, 'Claude')
    .replace(/\bcloud(?= or Codex)\b/gi, 'Claude')
    .replace(/\bANU\b/g, 'Unmute')
    .replace(/\ba mute agent\b/gi, 'Unmute Agent')
    .replace(/\bmac os\b/gi, 'macOS')
    .replace(/\bglobal key\b/gi, 'Globe key')
    .replace(/\bascending state\b/gi, 'sending state')
    .replace(/\bagentic lobe\b/gi, 'agentic loop')
    .replace(/\bapple notes\b/gi, 'Apple Notes')
    .replace(/\bnote taker\b/gi, 'Notetaker')
    .replace(/\bunmute agent\b/gi, 'Unmute Agent')
    .replace(/\bcommand c\b/gi, 'Command+C')
    .replace(/\bright option\b/gi, 'Right Option')
    .replace(/\bright command\b/gi, 'Right Command')
    .replace(/\bleft control\b/gi, 'Left Control')
    .replace(/\bfunction key\b/gi, 'Function key')
    .replace(/\b\s+pr\b/gi, ' PR')
}

function parseSrt(raw) {
  return raw.replace(/\r/g, '').trim().split(/\n\s*\n/).map(block => {
    const lines = block.split('\n')
    const timing = lines.findIndex(line => line.includes('-->'))
    if (timing < 0) return null
    const [start, end] = lines[timing].split(/\s*-->\s*/)
    return { start: seconds(start), end: seconds(end), text: correct(lines.slice(timing + 1).join(' ')) }
  }).filter(Boolean)
}

function readableCues(cues) {
  const groups = []
  let current = null
  const flush = () => { if (current) groups.push(current); current = null }
  for (const cue of cues) {
    if (current && (cue.start - current.end > 0.6 || cue.end - current.start > 5 || current.text.length + cue.text.length > 68 || /[.!?]$/.test(current.text))) flush()
    if (!current) current = { ...cue }
    else { current.text += ` ${cue.text}`; current.end = cue.end }
  }
  flush()
  // Preserve every spoken word and its timestamp.
  return groups
}

const assStamp = value => {
  const centiseconds = Math.round(value * 100)
  const pad = n => String(n).padStart(2, '0')
  return `${Math.floor(centiseconds / 360000)}:${pad(Math.floor(centiseconds / 6000) % 60)}:${pad(Math.floor(centiseconds / 100) % 60)}.${pad(centiseconds % 100)}`
}
const assEscape = value => value.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}')
function styledAss(cues) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Avenir Next Demi Bold,44,&H00FFFFFF,&H00FFFFFF,&H70000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,72,72,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  return header + cues.map(cue => `Dialogue: 0,${assStamp(cue.start)},${assStamp(cue.end)},Default,,0,0,0,,${assEscape(cue.text)}`).join('\n') + '\n'
}

await mkdir(outDir, { recursive: true })
for (const [stem, sourceName, captionsName] of jobs) {
  if (onlyStem && stem !== onlyStem) continue
  const source = path.join(sourceDir, sourceName)
  const rawSrt = await readFile(path.join(downloads, captionsName), 'utf8')
  const captionPath = path.join(outDir, `${stem}.srt`)
  const cues = readableCues(parseSrt(rawSrt))
  if (stem === 'privacy-v2') {
    for (const cue of cues) {
      cue.text = cue.text.replace(/\bunmute\b/gi, 'Unmute')
        .replace(/^before we begin/, 'Before we begin')
        .replace('Your Claude Code, your Codex activities, never passes through Unmute.', 'Your Claude Code and Codex activities never pass through Unmute.')
    }
  }
  if (stem === 'function-key-readiness-v2') {
    for (const cue of cues) cue.text = cue.text.replace('You need to set the press Globe key to do nothing.', 'Set “Press Globe key to” to “Do Nothing.”')
  }
  if (stem === 'notetaker-explain-v2') {
    const index = cues.findIndex(cue => cue.text === "and you're not paying for it.")
    if (index >= 0 && cues[index + 1]?.text.startsWith('Additionally, ')) {
      cues[index].text = "and you're not paying for it additionally."
      cues[index].end = 24.1
      cues[index + 1].text = cues[index + 1].text.slice('Additionally, '.length).replace(/^you/, 'You')
      cues[index + 1].start = 24.1
    }
  }
  for (const cue of cues) cue.text = cue.text.trimEnd()
  await writeFile(captionPath, cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n'))
  await writeFile(path.join(outDir, `${stem}.ass`), styledAss(cues))
  if (captionsOnly) continue
  const output = path.join(outDir, `${stem}.mp4`)
  const spokenEnd = cues.at(-1)?.end
  if (!Number.isFinite(spokenEnd)) throw new Error(`Missing caption timing for ${sourceName}`)
  // The raw takes run 1–2 seconds beyond the final line while the founder
  // looks down to stop recording. Keep all of the audio, but hold a natural
  // camera-facing frame through the final syllable and drop only that tail.
  // In the Keyboard Settings take the recording-stop glance begins before
  // the final caption ends, so choose its last direct-to-camera frame sooner.
  const holdLead = stem === 'function-key-readiness-v2' ? 1.05 : 0.4
  const holdAt = frame(Math.max(0, spokenEnd - holdLead))
  const finishAt = frame(spokenEnd + 0.1)
  const picture = stem === 'notetaker-explain-v2'
    ? 'scale=1280:720'
    : 'crop=2844:1600:0:300,scale=1280:720'
  // The video input ends at holdAt so tpad receives EOF; the second input
  // retains the complete spoken audio through finishAt. fps must precede tpad
  // or FFmpeg drops the held frames when it converts 60fps source footage.
  const filter = `[0:v]setpts=PTS-STARTPTS,fps=${outputFps},tpad=stop_mode=clone:stop_duration=${(finishAt - holdAt).toFixed(3)},${picture},ass=${stem}.ass[v];[1:a]atrim=duration=${finishAt},asetpts=PTS-STARTPTS[a]`
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-t', String(holdAt), '-i', source, '-i', source,
    '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
  ], { cwd: outDir, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${sourceName}: ${result.status}`)
  process.stdout.write(`Rendered ${stem}\n`)
}
