import type { PipelineEnv } from '../../shared/types'

const BUCKET = 'bug-report-screenshots'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SCREENSHOT_PATH = new RegExp(`^${UUID}/${UUID}/[0-3]\\.(png|jpg)$`, 'i')

interface BugReportRow {
  id: string
  user_id: string
  summary: string
  dictated_text: string
  screenshot_paths: string[]
  created_at: string
}

interface SignedScreenshot {
  path: string
  signedURL?: string
  error?: string | null
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function isAuthorized(request: Request, password: string): boolean {
  const header = request.headers.get('Authorization') ?? ''
  if (!header.startsWith('Basic ') || header.length > 512) return false
  // Compare the encoded credential without exiting early on a matching prefix.
  const actual = new TextEncoder().encode(header.slice(6))
  const expected = new TextEncoder().encode(btoa(`admin:${password}`))
  let difference = actual.length ^ expected.length
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    difference |= (actual[i] ?? 0) ^ (expected[i] ?? 0)
  }
  return difference === 0
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; img-src https://hvmpwsxktojligwejmlf.supabase.co; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function showBugReports(request: Request, env: PipelineEnv): Promise<Response> {
  if (!env.BUG_REPORT_ADMIN_PASSWORD) return new Response('Admin viewer is not configured', { status: 503 })
  if (!isAuthorized(request, env.BUG_REPORT_ADMIN_PASSWORD)) {
    return new Response('Admin sign-in required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Unmute bug reports", charset="UTF-8"', 'Cache-Control': 'no-store' },
    })
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  }
  const reportsResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/bug_reports?select=id,user_id,summary,dictated_text,screenshot_paths,created_at&order=created_at.desc&limit=50`, { headers })
  if (!reportsResponse.ok) return htmlResponse('<h1>Could not load bug reports</h1>', 502)
  const reports = await reportsResponse.json<BugReportRow[]>()
  const paths = [...new Set(reports.flatMap(report => report.screenshot_paths.filter(path => SCREENSHOT_PATH.test(path))))]
  const signedUrls = new Map<string, string>()
  if (paths.length) {
    const signedResponse = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/${BUCKET}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, expiresIn: 300 }),
    })
    if (!signedResponse.ok) return htmlResponse('<h1>Could not load report screenshots</h1>', 502)
    const signed = await signedResponse.json<SignedScreenshot[]>()
    for (const item of signed) {
      if (paths.includes(item.path) && item.signedURL && !item.error && item.signedURL.startsWith('/object/sign/')) {
        signedUrls.set(item.path, `${env.SUPABASE_URL}/storage/v1${item.signedURL}`)
      }
    }
  }

  const cards = reports.map(report => {
    const images = report.screenshot_paths.map((path, index) => {
      const url = signedUrls.get(path)
      return url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="Screenshot ${index + 1} for report ${escapeHtml(report.id)}" loading="lazy"></a>`
        : '<span class="missing">Screenshot unavailable</span>'
    }).join('')
    const time = new Date(report.created_at)
    return `<article><div class="meta"><time>${escapeHtml(Number.isNaN(time.getTime()) ? report.created_at : time.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}</time><span>${escapeHtml(report.id)}</span></div><h2>${escapeHtml(report.summary)}</h2><p class="user">User ${escapeHtml(report.user_id)}</p><p class="transcript">${escapeHtml(report.dictated_text)}</p><div class="images">${images}</div></article>`
  }).join('')

  return htmlResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unmute bug reports</title><style>
    *{box-sizing:border-box}body{margin:0;background:#0d0e12;color:#f4f4f5;font:15px/1.5 system-ui,-apple-system,sans-serif}main{max-width:1050px;margin:0 auto;padding:40px 24px 80px}header{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:30px}h1{font-size:30px;letter-spacing:-.04em;margin:0}header p,.user,.meta{color:#a1a1aa}header p{margin:4px 0 0}article{background:#191a21;border:1px solid #30313b;border-radius:16px;padding:24px;margin:18px 0}.meta{display:flex;justify-content:space-between;gap:12px;font-size:12px;overflow-wrap:anywhere}h2{font-size:19px;margin:16px 0 4px}.user{font-size:12px;margin:0}.transcript{white-space:pre-wrap;overflow-wrap:anywhere;background:#101116;border-radius:10px;padding:16px;margin:18px 0}.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.images a{display:block;background:#101116;border-radius:10px;overflow:hidden}.images img{display:block;width:100%;height:230px;object-fit:contain}.missing{color:#fbbf24}a.refresh{color:#d6bcfa;text-decoration:none;white-space:nowrap}a.refresh:hover{text-decoration:underline}
  </style></head><body><main><header><div><h1>Bug reports</h1><p>${reports.length} most recent reports · screenshots available for five minutes</p></div><a class="refresh" href="/admin/bug-reports">Refresh</a></header>${cards || '<p>No reports yet.</p>'}</main></body></html>`)
}
