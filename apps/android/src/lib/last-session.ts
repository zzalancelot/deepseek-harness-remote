import type { RemoteSession } from '../types'

/**
 * Pick the host's most recently active conversation from a session list.
 * Running turns win over idle ones; then newer `updatedAt` wins.
 */
export function resolveLastActiveSession(
  sessions: readonly RemoteSession[],
  archivedSessionIds: readonly string[] = [],
): RemoteSession | undefined {
  const archived = new Set(archivedSessionIds)
  const candidates = sessions.filter(session => !archived.has(session.sessionId))
  if (candidates.length === 0) return undefined
  return candidates.reduce((best, session) => {
    if (session.running !== best.running) return session.running ? session : best
    if (session.updatedAt !== best.updatedAt) return session.updatedAt > best.updatedAt ? session : best
    return session.sessionId < best.sessionId ? session : best
  })
}
