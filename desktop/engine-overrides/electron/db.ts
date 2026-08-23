// Managed-build db.ts override.
//
// Adds an `engine` column to the sessions table so the History view can
// chip each row with which path actually ran (Cloud / Your key / Offline).
// The chip is purely informational; the column is nullable so legacy rows
// from pre-upgrade installs render without a chip.
//
// The engine value is set by the paywall layer's session-end hook just
// before saveSession runs — see paywall/main-extensions.ts → popLastEngine().

import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
// popLastEngine is the handoff point: sessionManager (or paywall-route on
// the managed path) calls setLastEngine(...) when transcription returns,
// and saveSession reads + clears it here. Single-flight assumption holds
// because dictation is push-to-talk — one in-flight at a time.
import { popLastEngine } from './paywall/main-extensions'
import { createNotetakerLogger } from './notetaker/notetakerLog'

const notetakerLog = createNotetakerLogger('db')

let db: Database.Database
let cleanupTimer: ReturnType<typeof setInterval> | null = null

export type EngineTag = 'cloud' | 'byok' | 'local'

export interface DBSession {
  id: string
  created_at: number
  flow_type: string
  dictation_transcript: string | null
  instruction_transcript: string | null
  selected_text: string | null
  selected_text_role: string | null
  output: string | null
  audio_file_path: string | null
  status: string
  error_message: string | null
  engine: EngineTag | null
}

// Meetings are a separate retention lane from sessions: rows and transcripts
// are kept forever (no TTL, no row cap). Only the audio files backing a
// meeting are swept 24h after it ends — see sweepExpiredMeetingAudio().
export interface DBMeeting {
  id: string
  title: string
  started_at: number
  ended_at: number
  duration_ms: number
  status: 'recording' | 'transcribing' | 'ready' | 'failed'
  transcript_path: string | null
  audio_mic_path: string | null
  audio_system_path: string | null
}

export function initDB(): void {
  const dbPath = path.join(app.getPath('userData'), 'unmute.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      flow_type TEXT NOT NULL,
      dictation_transcript TEXT,
      instruction_transcript TEXT,
      selected_text TEXT,
      selected_text_role TEXT,
      output TEXT,
      audio_file_path TEXT,
      status TEXT DEFAULT 'done',
      error_message TEXT,
      engine TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
  `)

  // Migration for existing installs that already had the sessions table
  // without the engine column. sqlite errors if the column already exists,
  // which we catch + ignore — there's no IF NOT EXISTS for ADD COLUMN
  // until sqlite 3.35 and we're not guaranteed that.
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN engine TEXT')
  } catch { /* already there */ }

  // better-take storage: when a dictation pasted a local draft and the cloud
  // transcript arrived late (≤30s), we keep the cloud text here. Not shown
  // in History yet — deliberately storage-only (2026-07-15 plan).
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN better_transcript TEXT')
  } catch { /* already there */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      date TEXT NOT NULL,
      model TEXT NOT NULL,
      stt_seconds REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, model)
    );
  `)

  // Unlike sessions, meetings are never unconditionally swept: no TTL, no
  // row cap. Only their audio files are time-expired, via
  // sweepExpiredMeetingAudio() below — the DB row and transcript persist.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      transcript_path TEXT,
      audio_mic_path TEXT,
      audio_system_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at DESC);
  `)

  cleanupSessions()
  sweepExpiredMeetingAudio()
  // A write-triggered cleanup is not a hard retention guarantee for someone
  // who leaves the app open overnight. Reap on a short, unref'd cadence too.
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = setInterval(() => { cleanupSessions(); sweepExpiredMeetingAudio() }, 60 * 60 * 1000)
  cleanupTimer.unref?.()
}

export interface UsageRow {
  date: string
  model: string
  stt_seconds: number
  input_tokens: number
  output_tokens: number
}

export function addUsage(date: string, model: string, delta: {
  sttSeconds?: number
  inputTokens?: number
  outputTokens?: number
}): void {
  const stmt = db.prepare(`
    INSERT INTO usage_daily (date, model, stt_seconds, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, model) DO UPDATE SET
      stt_seconds = stt_seconds + excluded.stt_seconds,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens
  `)
  stmt.run(
    date,
    model,
    delta.sttSeconds || 0,
    delta.inputTokens || 0,
    delta.outputTokens || 0,
  )
}

export function getUsageRows(): UsageRow[] {
  return db.prepare('SELECT * FROM usage_daily').all() as UsageRow[]
}

export function clearUsage(): void {
  db.prepare('DELETE FROM usage_daily').run()
  console.log('[db] Usage stats cleared')
}

export function saveSession(session: {
  sessionId: string
  flowType: string
  dictationTranscript: string | null
  instructionTranscript: string | null
  selectedText: string | null
  selectedTextRole: string | null
  output: string | null
  audioFilePath?: string | null
  status: string
  errorMessage: string | null
  createdAt: number
}): void {
  // Drain whatever the paywall layer recorded for the most recent STT call.
  // popLastEngine clears it so the next dictation starts from null again.
  const engine = popLastEngine()

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      id, created_at, flow_type, dictation_transcript, instruction_transcript,
      selected_text, selected_text_role, output, audio_file_path, status, error_message, engine
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    session.sessionId,
    session.createdAt,
    session.flowType,
    session.dictationTranscript,
    session.instructionTranscript,
    session.selectedText,
    session.selectedTextRole,
    session.output,
    session.audioFilePath || null,
    session.status,
    session.errorMessage,
    engine,
  )

  cleanupSessions()
}

export function getSessions(limit = 50): Record<string, unknown>[] {
  cleanupSessions()
  const rows = db.prepare(
    'SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as DBSession[]

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    flowType: row.flow_type,
    dictationTranscript: row.dictation_transcript,
    instructionTranscript: row.instruction_transcript,
    selectedText: row.selected_text,
    selectedTextRole: row.selected_text_role,
    output: row.output,
    audioFilePath: row.audio_file_path,
    status: row.status,
    errorMessage: row.error_message,
    engine: row.engine,
  }))
}

export function getSession(id: string): DBSession | undefined {
  return db.prepare(
    'SELECT * FROM sessions WHERE id = ?'
  ).get(id) as DBSession | undefined
}

export function updateSessionResult(sessionId: string, updates: {
  dictationTranscript: string | null
  output: string | null
  status: string
  errorMessage: string | null
  flowType?: string
}): void {
  // Retries don't have a known engine — leave existing engine value alone.
  const stmt = db.prepare(`
    UPDATE sessions SET
      dictation_transcript = ?,
      output = ?,
      status = ?,
      error_message = ?,
      flow_type = COALESCE(?, flow_type)
    WHERE id = ?
  `)
  stmt.run(
    updates.dictationTranscript,
    updates.output,
    updates.status,
    updates.errorMessage,
    updates.flowType || null,
    sessionId
  )
}

export function updateBetterTranscript(sessionId: string, text: string): void {
  try {
    db.prepare('UPDATE sessions SET better_transcript = ? WHERE id = ?').run(text, sessionId)
  } catch (e) {
    console.warn('[db] updateBetterTranscript failed:', e instanceof Error ? e.message : e)
  }
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function insertMeeting(meeting: DBMeeting): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO meetings (
      id, title, started_at, ended_at, duration_ms, status, transcript_path, audio_mic_path, audio_system_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    meeting.id,
    meeting.title,
    meeting.started_at,
    meeting.ended_at,
    meeting.duration_ms,
    meeting.status,
    meeting.transcript_path,
    meeting.audio_mic_path,
    meeting.audio_system_path,
  )
  notetakerLog.child({ meetingId: meeting.id }).event('db-row-written', {
    title: meeting.title,
    status: meeting.status,
    durationMs: meeting.duration_ms,
    hasTranscript: !!meeting.transcript_path,
    hasMicAudio: !!meeting.audio_mic_path,
    hasSystemAudio: !!meeting.audio_system_path,
  })
}

// Deliberately does NOT call any cleanup/sweep function first — unlike
// getSessions(), meetings are never unconditionally swept on read. Audio
// expiry is time-driven (sweepExpiredMeetingAudio, wired into initDB's
// startup + hourly timer), not read-driven.
export function getMeetings(limit = 200): DBMeeting[] {
  return db.prepare('SELECT * FROM meetings ORDER BY started_at DESC LIMIT ?').all(limit) as DBMeeting[]
}

export function getMeeting(id: string): DBMeeting | null {
  return (db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as DBMeeting | undefined) ?? null
}

export function updateMeetingTitle(id: string, title: string): void {
  db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title, id)
}

export function deleteMeeting(id: string): void {
  const meeting = getMeeting(id)
  if (!meeting) {
    notetakerLog.child({ meetingId: id }).warn('deleteMeeting called for an id with no row — nothing to delete')
    return
  }
  const meetingsDir = path.join(app.getPath('userData'), 'meetings', id)
  try {
    fs.rmSync(meetingsDir, { recursive: true, force: true })
  } catch { /* already gone */ }
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
  notetakerLog.child({ meetingId: id }).event('meeting-deleted', { title: meeting.title })
}

// Meeting rows and transcripts are kept forever; only the audio backing a
// meeting expires, 24h after the meeting ended. Not exported — called only
// from initDB()'s startup + hourly-timer wiring, matching cleanupSessions()'s
// own non-exported convention.
function sweepExpiredMeetingAudio(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  // Not gated on audio_*_path being non-null: a session that crashed or was
  // quit mid-meeting never reaches persistSession(), so its row keeps the
  // start()-time placeholder's NULL paths even though its WavAppender wrote
  // real PCM to the meeting's fixed audio-mic.wav/audio-system.wav files
  // (see notetakerInit.ts's makeChunkHandler). Sweeping every row past the
  // cutoff regardless of path columns, and always attempting the fixed
  // filenames in addition to any DB-recorded paths, means that orphaned
  // audio is reclaimed on the same 24h schedule as normal audio instead of
  // living forever. The placeholder row seeds ended_at to the session's
  // start time (not 0), so a crashed meeting's cutoff still fires correctly.
  const expired = db.prepare(
    'SELECT id, audio_mic_path, audio_system_path FROM meetings WHERE ended_at < ?'
  ).all(cutoff) as { id: string; audio_mic_path: string | null; audio_system_path: string | null }[]

  if (expired.length > 0) {
    notetakerLog.event('audio-sweep-started', { cutoff, candidateCount: expired.length })
  }
  for (const row of expired) {
    const meetingDir = path.join(app.getPath('userData'), 'meetings', row.id)
    const candidates = new Set(
      [row.audio_mic_path, row.audio_system_path, 'audio-mic.wav', 'audio-system.wav'].filter(
        (p): p is string => !!p
      )
    )
    let unlinked = 0
    for (const relPath of candidates) {
      try {
        fs.unlinkSync(path.join(meetingDir, relPath))
        unlinked++
      } catch { /* already gone, or never existed for this meeting */ }
    }
    if (row.audio_mic_path || row.audio_system_path) {
      db.prepare('UPDATE meetings SET audio_mic_path = NULL, audio_system_path = NULL WHERE id = ?').run(row.id)
    }
    notetakerLog.child({ meetingId: row.id }).event('audio-swept', {
      filesUnlinked: unlinked,
      hadNullPaths: !row.audio_mic_path && !row.audio_system_path, // true = a crash/quit-orphaned meeting
    })
  }
}

function cleanupSessions(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoff)
  // Audio is part of a dictation, not an exception to its retention policy.
  // The engine's five-session cap is still useful under 24h, but cannot retain
  // a quiet user's recording for days.
  const audioDir = path.join(app.getPath('userData'), 'audio')
  try {
    for (const name of fs.readdirSync(audioDir)) {
      const file = path.join(audioDir, name)
      if (fs.statSync(file).isFile() && fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
    }
  } catch { /* audio has not been created yet, or is being cleared */ }

  const count = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c
  if (count > 100) {
    db.prepare(`
      DELETE FROM sessions WHERE id IN (
        SELECT id FROM sessions ORDER BY created_at ASC LIMIT ?
      )
    `).run(count - 100)
  }
}

export function clearAllSessions(): void {
  db.prepare('DELETE FROM sessions').run()
  console.log('[db] All sessions cleared')
}

export function closeDB(): void {
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = null
  if (db) db.close()
}
