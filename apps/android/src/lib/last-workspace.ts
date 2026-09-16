import type { WorkspaceView } from '../types'

/**
 * Prefer the last active workspace when it still exists; otherwise the first
 * DSH workspace, then any remaining workspace.
 */
export function resolveHomeWorkspace(
  workspaces: WorkspaceView[],
  lastActiveWorkspaceId: string | undefined,
): WorkspaceView | undefined {
  if (lastActiveWorkspaceId) {
    const matched = workspaces.find(workspace => workspace.workspaceId === lastActiveWorkspaceId)
    if (matched) return matched
  }
  return workspaces.find(workspace => (workspace.backend ?? 'dsh') !== 'codex') ?? workspaces[0]
}

export function workspaceIdForSession(workspaces: WorkspaceView[], sessionId: string): string | undefined {
  return workspaces.find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
}
