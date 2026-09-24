import type { PipelineEnv } from '../../shared/types'
import { insertReturningId } from '../../shared/supabase'

const MAX_REPORT_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const BUCKET = 'bug-report-screenshots'

function validImage(data: Uint8Array, type: string): boolean {
  if (type === 'image/png') return data.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte)
  return type === 'image/jpeg' && data.length >= 4 && data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217
}

function error(message: string, status: number): Response {
  return Response.json({ ok: false, code: 'BAD_REQUEST', message }, { status })
}

export async function receiveBugReport(req: Request, env: PipelineEnv, userId: string): Promise<Response> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) return error('Bug report is too large', 413)
  let form: FormData
  try { form = await req.formData() } catch { return error('Invalid bug report', 400) }
  const summary = form.get('summary')
  const transcript = form.get('transcript')
  const images: unknown[] = form.getAll('screenshot')
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 2000
    || typeof transcript !== 'string' || !transcript.trim() || transcript.length > 65536
    || images.length < 1 || images.length > 4) return error('Bug report requires text and one to four screenshots', 400)
  if (images.some(image => !(image instanceof File) || !['image/png', 'image/jpeg'].includes(image.type) || image.size < 1 || image.size > MAX_IMAGE_BYTES)
    || images.reduce<number>((size, image) => size + (image instanceof File ? image.size : 0), 0) > MAX_REPORT_BYTES) {
    return error('Invalid screenshot', 400)
  }
  const imageData = await Promise.all(images.map(async image => {
    const file = image as File
    return { type: file.type, data: new Uint8Array(await file.arrayBuffer()) }
  }))
  if (imageData.some(image => !validImage(image.data, image.type))) return error('Invalid screenshot', 400)

  const id = crypto.randomUUID()
  const paths: string[] = []
  try {
    for (const [index, image] of imageData.entries()) {
      const path = `${userId}/${id}/${index}.${image.type === 'image/png' ? 'png' : 'jpg'}`
      const uploaded = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': image.type,
          'x-upsert': 'false',
        },
        body: image.data,
      })
      if (!uploaded.ok) throw new Error(`Screenshot upload failed (${uploaded.status})`)
      paths.push(path)
    }
    const saved = await insertReturningId(env, 'bug_reports', {
      id, user_id: userId, summary: summary.trim(), dictated_text: transcript, screenshot_paths: paths,
    })
    if (saved !== id) throw new Error('Report storage failed')
    return Response.json({ ok: true, report_id: id, screenshot_count: paths.length })
  } catch (cause) {
    await Promise.all(paths.map(path => fetch(`${env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'DELETE',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    }).catch(() => undefined)))
    console.error('[bug-report] submission failed:', cause)
    return Response.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Bug report could not be saved' }, { status: 503 })
  }
}
