import { test } from 'node:test'
import assert from 'node:assert/strict'
import { receiveBugReport } from './bugReports'
import type { PipelineEnv } from '../../shared/types'

const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key' } as PipelineEnv
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])

function request(image = png, type = 'image/png'): Request {
  const form = new FormData()
  form.set('summary', 'Mic stops after sleep')
  form.set('transcript', 'Please report this bug to Unmute. The mic stops after sleep.')
  form.append('screenshot', new File([image], 'screen.png', { type }))
  return new Request('https://pipeline.example/v1/bug-reports', { method: 'POST', body: form })
}

test('rejects an invalid screenshot before writing anything', async () => {
  const oldFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw new Error('must not write') }) as typeof fetch
  try {
    const response = await receiveBugReport(request(new Uint8Array([1, 2, 3])), env, 'user-1')
    assert.equal(response.status, 400)
    assert.equal(calls, 0)
  } finally { globalThis.fetch = oldFetch }
})

test('stores the exact transcript and a private screenshot under the authenticated user', async () => {
  const oldFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    if (String(url).includes('/rest/v1/bug_reports')) {
      const row = JSON.parse(String(init?.body))
      return Response.json([{ id: row.id }])
    }
    return Response.json({ Key: 'stored' })
  }) as typeof fetch
  try {
    const response = await receiveBugReport(request(), env, 'user-1')
    assert.equal(response.status, 200)
    assert.equal(calls.length, 2)
    assert.match(calls[0]!.url, /\/storage\/v1\/object\/bug-report-screenshots\/user-1\//)
    const row = JSON.parse(String(calls[1]!.init.body))
    assert.equal(row.dictated_text, 'Please report this bug to Unmute. The mic stops after sleep.')
    assert.equal(row.screenshot_paths.length, 1)
  } finally { globalThis.fetch = oldFetch }
})
