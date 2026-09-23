const POPULATED_TTL_MS = 10 * 60_000
const EMPTY_RETRY_MS = 30_000

export function shouldRefreshModelCatalog(state: {
  count: number
  loading: boolean
  attemptedAt: number
  now: number
}): boolean {
  if (state.loading) return false
  const ttl = state.count > 0 ? POPULATED_TTL_MS : EMPTY_RETRY_MS
  return state.now - state.attemptedAt >= ttl
}
