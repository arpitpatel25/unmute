import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BugReportSubmission } from './capabilities/bug-report'
import type { InteractionAttachmentHandles } from './memory/attachments'
import { isExplicitBugReportRequest } from './bug-report'

declare const __PIPELINE_URL__: string

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES_BYTES = 14 * 1024 * 1024
export interface PreparedBugReport {
  transcript: string
  summary: string
  screenshots: Array<{ type: 'image/png' | 'image/jpeg'; base64: string }>
}

async function currentScreen(): Promise<Uint8Array> {
  const path = join(tmpdir(), `unmute-bug-report-${randomUUID()}.png`)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/sbin/screencapture', ['-x', '-m', path], { timeout: 15_000 }, error => error ? reject(error) : resolve())
    })
    return await fs.readFile(path)
  } finally {
    await fs.rm(path, { force: true }).catch(() => undefined)
  }
}

export async function prepareBugReport(
  report: BugReportSubmission,
  handles: InteractionAttachmentHandles,
): Promise<PreparedBugReport> {
  const screenshots: Array<{ data: Uint8Array; type: 'image/png' | 'image/jpeg' }> = []
  let totalBytes = 0
  try {
    const data = await currentScreen()
    if (data.length > 0 && data.length <= MAX_IMAGE_BYTES) {
      screenshots.push({ data, type: 'image/png' })
      totalBytes += data.length
    }
  } catch { /* An attached screenshot can still carry the report. */ }
  for (const handle of report.attachmentHandles) {
    if (screenshots.length === 3) break
    try {
      const source = handles.resolve(report.principal, handle, 'capture')
      const type = source.mimeType
      if (type !== 'image/png' && type !== 'image/jpeg') continue
      const data = await fs.readFile(source.path)
      if (data.length > 0 && data.length <= MAX_IMAGE_BYTES && totalBytes + data.length <= MAX_IMAGES_BYTES) {
        screenshots.push({ data, type })
        totalBytes += data.length
      }
    } catch { /* The current screen can still carry the report. */ }
  }
  if (!screenshots.length) throw new Error('Could not capture a screenshot for the bug report.')
  return {
    transcript: report.transcript,
    summary: report.summary,
    screenshots: screenshots.map(({ data, type }) => ({ type, base64: Buffer.from(data).toString('base64') })),
  }
}

export async function uploadBugReport(report: PreparedBugReport, token: string | null): Promise<{ id: string; screenshotCount: number }> {
  if (!token) throw new Error('Sign in to Unmute before sending a bug report.')
  if (!isExplicitBugReportRequest(report.transcript) || !report.summary || report.summary.length > 2000
    || report.screenshots.length < 1 || report.screenshots.length > 4) throw new Error('Bug report input is invalid.')
  const form = new FormData()
  form.set('summary', report.summary)
  form.set('transcript', report.transcript)
  report.screenshots.forEach(({ base64, type }, index) => {
    const data = Buffer.from(base64, 'base64')
    if (data.length < 1 || data.length > MAX_IMAGE_BYTES || (type !== 'image/png' && type !== 'image/jpeg')) throw new Error('Bug report screenshot is invalid.')
    form.append('screenshot', new Blob([Uint8Array.from(data)], { type }), `screenshot-${index}.${type === 'image/png' ? 'png' : 'jpg'}`)
  })
  const response = await fetch(`${__PIPELINE_URL__}/v1/bug-reports`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => null) as { ok?: boolean; report_id?: string; screenshot_count?: number; message?: string } | null
  if (!response.ok || !body?.ok || !body.report_id) {
    throw new Error(response.status === 401 ? 'Sign in to Unmute before sending a bug report.' : body?.message || 'Bug report could not be sent.')
  }
  return { id: body.report_id, screenshotCount: body.screenshot_count ?? report.screenshots.length }
}

export async function submitBugReport(report: BugReportSubmission, handles: InteractionAttachmentHandles, token: string | null) {
  return uploadBugReport(await prepareBugReport(report, handles), token)
}
