import { locateSession, requireMainSession, type LocatedSession } from './locate'
import type { ContinuationSource } from '../capabilities/handoff'

export async function validateContinuationSources(sources: readonly ContinuationSource[] | undefined,
  locate: (sessionId: string) => Promise<LocatedSession | null> = locateSession, context?: string): Promise<void> {
  if (context?.trim() && (!Array.isArray(sources) || !sources.length)) throw new Error('Transcript context requires exact sourceSessions')
  if (sources === undefined) return
  if (!Array.isArray(sources) || sources.length > 12) throw new Error('Invalid continuation sources')
  for (const source of sources) {
    if (!source || typeof source.sessionId !== 'string') throw new Error('Invalid continuation source')
    const located = await locate(source.sessionId)
    if (!located) throw new Error('Continuation source is not on this machine')
    requireMainSession(located)
    if (located.harness !== source.provider) throw new Error('Continuation source provider does not match')
  }
}
