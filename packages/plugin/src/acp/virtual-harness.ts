import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AgentAcpClient } from '@dsh-remote/client-core'
import type { AcpSessionModels } from '@dsh-remote/protocol'
import { ACP_TOOL_CALL_ENDPOINTS, ACP_TOOL_STREAM_ENDPOINTS } from '@dsh-remote/protocol'
import { collectSessionTokenUsage } from '../session-token-usage.js'
import type { RemoteTypertGatewayTarget, TypertGatewayRequest, TypertRpcResult } from '../typert-gateway-contract.js'
import type { AcpImage } from './image-content.js'
import { acpImageContent, acpImageLimits, parseAcpImage } from './image-content.js'
import type { AcpModelSelection, AcpVirtualWorkspaceView } from './virtual-catalog.js'
import { createAcpWorkspaceView, modelCatalog, nativeWorkspace, recreateWorkspaceFromId } from './virtual-catalog.js'
import type {
  AcpClientLike,
  AcpSessionState,
  FollowState,
  JsonRecord,
  NativeEvent,
  PendingApproval,
} from './virtual-contract.js'
import {
  array,
  AsyncValueQueue,
  business,
  carrierArgs,
  extractPromptText,
  extractSessionId,
  fail,
  failFrom,
  failure,
  isRecord,
  nativeAcpId,
  optionalInteger,
  optionalPositiveInteger,
  record,
  requestArg,
  requiredString,
  sessionPrefix,
  string,
  success,
} from './virtual-contract.js'
import { AcpEventCarrier } from './virtual-event-carrier.js'
import { AcpLiveProjection } from './virtual-live.js'

/**
 * Browser-safe, in-memory Harness projection for the independent Agent ACP domain. Projects
 * cwd workspaces and ACP sessions onto the native DSH Workspace / Session /
 * Composer surface without writing DSH SessionStore.
 */
export class AcpVirtualHarness implements RemoteTypertGatewayTarget {
  private readonly live: AcpLiveProjection
  private readonly events: AcpEventCarrier

  readonly api: ApiProxy

  private readonly workspaceById = new Map<string, AcpVirtualWorkspaceView>()
  private readonly sessions = new Map<string, AcpSessionState>()
  private readonly workspaceStreams = new Set<AsyncValueQueue>()
  private readonly controlStreams = new Set<AsyncValueQueue>()
  private readonly eventStreams = new Map<string, AsyncValueQueue>()
  private readonly rcMuxStreams = new Set<AsyncValueQueue>()
  private readonly rcHostStreams = new Set<AsyncValueQueue>()
  private readonly follows = new Set<FollowState>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingHistory = new Map<string, Promise<void>>()
  private selectedWorkspaceId?: string
  private readonly selectedModels = new Map<string, AcpModelSelection>()
  private lastProjectionSeq = 0
  private readonly imageAttachments = new Map<string, { sessionId: string; attachment: unknown; data: string }>()
  private closed = false

  constructor(
    private readonly client: AcpClientLike,
    private readonly host: { deviceId: string; name: string },
    readonly backend: "cursor" | "antigravity" | "pi" | "opencode" = "cursor",
    /**
     * Host gateway used for endpoints this virtual Harness does not project
     * (settings, plugins, models, credentials, …). A real Harness workspace
     * serves them from the Host; without this fallback the native Client would
     * see `method-not-found` for every global surface and can fail its render.
     */
    private readonly hostCarrier?: RemoteTypertGatewayTarget,
  ) {
    const owner = this
    this.live = new AcpLiveProjection({
      ensureSessionRegistered: (...args) => owner.ensureSessionRegistered(...args),
      get sessions() { return owner.sessions },
      hydrateSession: (...args) => owner.hydrateSession(...args),
      historyPage: (...args) => owner.historyPage(...args),
      get follows() { return owner.follows },
      get backend() { return owner.backend },
      modelSelectionProjection: (...args) => owner.modelSelectionProjection(...args),
      get client() { return owner.client },
      emitRemoteEvent: (...args) => owner.events.emitRemoteEvent(...args),
      get selectedModels() { return owner.selectedModels },
      publishProjection: (...args) => owner.events.publishProjection(...args),
      nextProjectionSeq: (...args) => owner.nextProjectionSeq(...args),
      refreshSessionTitle: (...args) => owner.refreshSessionTitle(...args),
      get pendingApprovals() { return owner.pendingApprovals },
      emitApproval: (...args) => owner.events.emitApproval(...args),
      modelSelection: (...args) => owner.modelSelection(...args),
      broadcastRcMux: (...args) => owner.events.broadcastRcMux(...args),
    })
    this.events = new AcpEventCarrier({
      get workspaceStreams() { return owner.workspaceStreams },
      visibleWorkspaces: (...args) => owner.visibleWorkspaces(...args),
      get controlStreams() { return owner.controlStreams },
      get eventStreams() { return owner.eventStreams },
      get selectedWorkspaceId() { return owner.selectedWorkspaceId },
      get workspaceById() { return owner.workspaceById },
      backendLabel: (...args) => owner.backendLabel(...args),
      get pendingApprovals() { return owner.pendingApprovals },
      get client() { return owner.client },
      dispatch: (...args) => owner.dispatch(...args),
      get rcMuxStreams() { return owner.rcMuxStreams },
      get sessions() { return owner.sessions },
      get rcHostStreams() { return owner.rcHostStreams },
      nextProjectionSeq: (...args) => owner.nextProjectionSeq(...args),
    })

    this.api = this.events.createApiProxy()
  }

  static remote(
    core: ConstructorParameters<typeof AgentAcpClient>[0],
    host: { deviceId: string; name: string },
    backend: "cursor" | "antigravity" | "pi" | "opencode" = "cursor",
    capabilities: readonly string[] = [],
    hostCarrier?: RemoteTypertGatewayTarget,
  ): AcpVirtualHarness {
    return new AcpVirtualHarness(new AgentAcpClient(core, capabilities), host, backend, hostCarrier)
  }

  async workspaces(): Promise<AcpVirtualWorkspaceView[]> {
    return [...this.workspaceById.values()]
  }

  private backendLabel(): string {
    return this.backend === "pi" ? "PI" : this.backend === "opencode" ? "OpenCode" : this.backend === "antigravity" ? "Antigravity" : "Cursor"
  }

  async selectWorkspace(workspaceId: string): Promise<AcpVirtualWorkspaceView> {
    const workspace = this.workspaceById.get(workspaceId) ?? recreateWorkspaceFromId(workspaceId, this.backend)
    if (workspace === undefined) throw new Error(`The selected ${this.backendLabel()} workspace is no longer available.`)
    this.workspaceById.set(workspace.workspaceId, workspace)
    this.selectedWorkspaceId = workspace.workspaceId
    await this.discoverAndAttachSessions(workspace)
    if (workspace.sessionIds.length === 0) {
      await this.ensureInitialSession(workspace)
    }
    this.publishWorkspaceBaseline()
    return this.workspaceById.get(workspace.workspaceId) ?? workspace
  }

  async selectOrCreateWorkspace(path: string): Promise<AcpVirtualWorkspaceView> {
    const trimmed = path.trim()
    if (trimmed.length === 0) throw new Error(`A ${this.backendLabel()} working directory is required.`)
    const existing = [...this.workspaceById.values()].find(item => item.path === trimmed)
    const workspace = existing ?? createAcpWorkspaceView(trimmed, this.backend)
    this.workspaceById.set(workspace.workspaceId, workspace)
    this.selectedWorkspaceId = workspace.workspaceId
    await this.discoverAndAttachSessions(workspace)
    if (workspace.sessionIds.length === 0) {
      await this.ensureInitialSession(workspace)
    }
    this.publishWorkspaceBaseline()
    return this.workspaceById.get(workspace.workspaceId) ?? workspace
  }

  async preferredSessionId(): Promise<string | undefined> {
    const selected = this.selectedWorkspaceId === undefined
      ? undefined
      : this.workspaceById.get(this.selectedWorkspaceId)
    const sessionIds = selected?.sessionIds ?? []
    let bestSessionId: string | undefined
    let bestUpdatedAt = -1
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId)
      if (session !== undefined && !session.running && !session.blank && session.updatedAt > bestUpdatedAt) {
        bestUpdatedAt = session.updatedAt
        bestSessionId = sessionId
      }
    }
    if (bestSessionId !== undefined) return bestSessionId
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId)
      if (session !== undefined && !session.running) return sessionId
    }
    return sessionIds[0] ?? sessionIds.at(-1)
  }

  async invoke(request: TypertGatewayRequest): Promise<unknown> {
    const result = await this.dispatch(
      `${request.namespace}/${request.method}`,
      { args: request.args },
      request.signal ?? new AbortController().signal,
    )
    if (result.ok) return result.value
    throw Object.assign(new Error(result.error.message), {
      isDSHRemoteError: true as const,
      code: result.error.code,
      details: result.error.details,
    })
  }

  async dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<TypertRpcResult> {
    try {
      const args = carrierArgs(payload)
      if (ACP_TOOL_CALL_ENDPOINTS.some(item => item === endpoint)) {
        if (!this.client.workspaceToolCall) return business(failure('method-not-found', 'The Host does not support ACP workspace tools.'))
        const sessionId = requiredString(args.workspaceFileScopeId ?? args.agentId ?? args.sessionId, 'sessionId')
        return business(await this.client.workspaceToolCall(nativeAcpId(sessionId, this.backend), this.backend, endpoint as typeof ACP_TOOL_CALL_ENDPOINTS[number], args, signal))
      }
      switch (endpoint) {
        case '$events/result': return business(await this.events.answerRemoteEvent(args, signal))
        case 'workspace/list': return business(success({
          items: this.visibleWorkspaces().map(nativeWorkspace),
          archivedSessionIds: [],
          pinnedSessionIds: [],
        }))
        case 'workspace/create': return business(await this.createWorkspace(requestArg(args)))
        case 'workspace/rename': return business(await this.renameWorkspace(requestArg(args)))
        case 'workspace/delete': return business(failure('workspace-read-only', `${this.backendLabel()} virtual Workspaces cannot be deleted from Desktop yet.`))
        case 'workspace/insertBefore': return business({
          workspaceIds: this.visibleWorkspaces().map(item => item.workspaceId),
        })
        case 'workspace/insertSessionBefore': return business(await this.workspaceForSession(requestArg(args)))
        case 'workspace/archiveSession': return business(await this.archiveSession(requestArg(args)))
        case 'session/list': return business(success({ items: await this.handleSessionList() }))
        case 'session/search': return business(success({ items: [], hasMore: false }))
        case 'session/create': return business(await this.createSession(requestArg(args), signal))
        case 'session/fork': return business(failure('bad-request', `${this.backendLabel()} Remote does not support session fork yet.`))
        case 'session/history': return business(await this.sessionHistory(requestArg(args)))
        case 'session/page': return business(await this.sessionPage(requestArg(args)))
        case 'session/usage': return business(await this.sessionUsage(requestArg(args)))
        case 'session/prompt': return business(await this.prompt(requestArg(args), signal))
        case 'session/cancel': return business(await this.cancel(requestArg(args), signal))
        case 'session/rename': return business(await this.renameSession(requestArg(args)))
        case 'session/updateQueue': return business(failure('queue-item-not-found', `${this.backendLabel()} does not expose a DSH inbox queue.`))
        case 'session/attachment': return business(await this.attachment(requestArg(args)))
        case 'session/modelCatalog': {
          const sessionId = await this.preferredSessionId()
          if (this.backend === 'cursor' || !sessionId) return business(success(modelCatalog(this.backend)))
          const models = await this.hostSessionModels(sessionId)
          return business(success({ default: models.current, routableProviders: models.routable ? [models.current.provider] : [], groups: models.groups, failures: models.failures }))
        }
        case 'session/models': {
          const rawId = extractSessionId(requestArg(args))
          nativeAcpId(rawId, this.backend)
          if (this.backend !== 'cursor') return business(success(await this.hostSessionModels(rawId)))
          const catalog = modelCatalog(this.backend)
          return business(success({
            current: this.modelSelection(rawId),
            routable: true,
            groups: catalog.groups,
            failures: [],
          }))
        }
        case 'session/selectModel': return business(await this.selectModel(requestArg(args)))
        case 'session/canOpenWorkspacePath': return business(this.selectedWorkspaceId !== undefined)
        case 'session/openWorkspacePath': return business(failure('bad-request', `Opening Host paths is unavailable in ${this.backendLabel()} mode.`))
        case 'host/describe': return business(success(this.describeHost()))
        case 'host/listDirectory':
        case 'directoryPicker/list': return business(await this.listDirectory(requestArg(args), signal))
        case 'skills/list': return business(success({ items: [] }))
        case 'commands/list': return business([])
        case 'commands/execute': return business(undefined)
        default:
          return this.hostCarrier === undefined
            ? fail('method-not-found', `${this.backendLabel()} virtual Harness does not implement ${endpoint}.`)
            : await this.hostCarrier.dispatch(endpoint, payload, signal)
      }
    } catch (error) {
      return failFrom(error)
    }
  }

  async open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    const args = carrierArgs(payload)
    if (ACP_TOOL_STREAM_ENDPOINTS.some(item => item === endpoint)) {
      const sessionId = requiredString(args.workspaceFileScopeId ?? args.agentId ?? args.sessionId, 'sessionId')
      const queue = new AsyncValueQueue(signal)
      const stream = await this.client.openStream(nativeAcpId(sessionId, this.backend), frame => {
        if (frame.frame.method === 'dsh/workspaceTool') queue.push(record(frame.frame.params).value)
      }, () => queue.close(), signal, { backend: this.backend, endpoint: endpoint as typeof ACP_TOOL_STREAM_ENDPOINTS[number], args })
      return queue.iterate(() => { void stream.close().catch(() => undefined) })
    }
    if (endpoint === 'workspace/follow') return this.events.workspaceFollow(signal)
    if (endpoint === 'session/control') return this.events.sessionControl(signal)
    if (endpoint === 'session/follow') return this.live.sessionFollow(requestArg(args), signal)
    if (endpoint === '$events') return this.events.remoteEvents(signal)
    if (endpoint === 'job/list' || endpoint === 'job/follow') return this.events.emptyJobStream(endpoint, signal)
    if (this.hostCarrier !== undefined) return this.hostCarrier.open(endpoint, payload, signal)
    throw Object.assign(new Error(`${this.backendLabel()} virtual Harness does not implement stream ${endpoint}.`), {
      isDSHRemoteError: true as const,
      code: 'method-not-found',
      details: {},
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const stream of this.workspaceStreams) stream.close()
    for (const stream of this.controlStreams) stream.close()
    for (const stream of this.eventStreams.values()) stream.close()
    for (const stream of this.rcMuxStreams) stream.close()
    for (const stream of this.rcHostStreams) stream.close()
    this.workspaceStreams.clear()
    this.controlStreams.clear()
    this.eventStreams.clear()
    this.rcMuxStreams.clear()
    this.rcHostStreams.clear()
    const follows = [...this.follows]
    this.follows.clear()
    for (const follow of follows) {
      follow.queue.close()
      await follow.close?.().catch(() => undefined)
    }
    this.pendingApprovals.clear()
    this.imageAttachments.clear()
  }

  private visibleWorkspaces(): AcpVirtualWorkspaceView[] {
    if (this.selectedWorkspaceId === undefined) return [...this.workspaceById.values()]
    const selected = this.workspaceById.get(this.selectedWorkspaceId)
    if (selected === undefined) return [...this.workspaceById.values()]
    return [
      selected,
      ...[...this.workspaceById.values()].filter(item => item.workspaceId !== selected.workspaceId),
    ]
  }

  private async createWorkspace(request: JsonRecord): Promise<unknown> {
    const path = string(request.path)?.trim()
    if (path === undefined || path.length === 0) return failure('bad-request', 'A Cursor working directory is required.')
    const workspace = await this.selectOrCreateWorkspace(path)
    this.publishWorkspaceBaseline()
    return success({ workspace: nativeWorkspace(workspace), created: true })
  }

  private async renameWorkspace(request: JsonRecord): Promise<unknown> {
    const workspaceId = requiredString(request.workspaceId, 'workspaceId')
    const title = string(request.title)?.trim()
    const workspace = this.workspaceById.get(workspaceId)
    if (workspace === undefined) return failure('workspace-not-found', 'The Cursor virtual Workspace was not found.')
    if (title === undefined || title.length === 0) return failure('bad-request', 'A Workspace name is required.')
    const next = { ...workspace, title, updatedAt: new Date().toISOString() }
    this.workspaceById.set(workspaceId, next)
    this.publishWorkspaceBaseline()
    return success({ workspace: nativeWorkspace(next) })
  }

  private async workspaceForSession(request: JsonRecord): Promise<unknown> {
    const sessionId = string(request.sessionId)
    const workspace = [...this.workspaceById.values()].find(item => sessionId !== undefined && item.sessionIds.includes(sessionId))
    return workspace === undefined
      ? failure('workspace-not-found', 'The Cursor virtual Workspace was not found.')
      : success({ workspace: nativeWorkspace(workspace) })
  }

  private async archiveSession(request: JsonRecord): Promise<unknown> {
    const sessionId = extractSessionId(request)
    this.sessions.delete(sessionId)
    for (const [workspaceId, workspace] of this.workspaceById) {
      if (!workspace.sessionIds.includes(sessionId)) continue
      const sessionIds = workspace.sessionIds.filter(id => id !== sessionId)
      this.workspaceById.set(workspaceId, {
        ...workspace,
        sessionIds,
        sessionCount: sessionIds.length,
        updatedAt: new Date().toISOString(),
      })
    }
    this.events.emitRemoteEvent('api-session/removed', [sessionId])
    this.publishWorkspaceBaseline()
    return success({ archivedSessionIds: [sessionId] })
  }

  private async createSession(request: JsonRecord, signal: AbortSignal): Promise<unknown> {
    const workspaceId = string(request.workspaceId) ?? this.selectedWorkspaceId
    const workspace = workspaceId === undefined ? undefined : this.workspaceById.get(workspaceId)
    const cwd = string(request.cwd) ?? workspace?.path
    if (cwd === undefined) return failure('workspace-not-found', 'The Cursor virtual Workspace was not found.')
    const requestedSessionId = string(request.sessionId)
    const reusable = requestedSessionId === undefined ? undefined : this.sessions.get(requestedSessionId)
    if (reusable !== undefined && reusable.cwd === cwd && reusable.blank && !reusable.running) {
      return success({ sessionId: reusable.sessionId })
    }
    const created = await this.client.createSession(cwd, 'agent', this.backend, signal)
    if (this.backend !== 'cursor' && this.sessions.has(`${sessionPrefix(this.backend)}${created.sessionId}`)) {
      return failure('session-already-exists', 'The backend returned an existing conversation for a new Session.')
    }
    const session = this.registerSession(created.sessionId, cwd, workspace?.title)
    this.attachSessionToWorkspace(cwd, session.sessionId)
    this.publishWorkspaceBaseline()
    const seq = this.nextProjectionSeq()
    this.events.emitRemoteEvent('api-session/added', [this.sessionSummary(session, seq)])
    this.events.publishProjection(session.sessionId, 'title', session.title ?? this.backendLabel(), seq)
    return success({ sessionId: session.sessionId })
  }

  private ensureSessionRegistered(sessionId: string): AcpSessionState | undefined {
    let session = this.sessions.get(sessionId)
    if (session !== undefined) return session
    if (this.backend !== 'cursor' && sessionId.startsWith(sessionPrefix(this.backend))) {
      const acpSessionId = sessionId.slice(sessionPrefix(this.backend).length)
      const workspace = this.selectedWorkspaceId !== undefined ? this.workspaceById.get(this.selectedWorkspaceId) : undefined
      const cwd = workspace?.path ?? '/'
      session = this.registerSession(acpSessionId, cwd, this.backendLabel(), Date.now(), Date.now(), false)
      if (workspace && !workspace.sessionIds.includes(sessionId)) {
        workspace.sessionIds.unshift(sessionId)
        workspace.sessionCount = workspace.sessionIds.length
        this.publishWorkspaceBaseline()
      }
      return session
    }
    return undefined
  }

  private async prompt(request: JsonRecord, signal: AbortSignal): Promise<unknown> {
    const sessionId = extractSessionId(request)
    const session = this.ensureSessionRegistered(sessionId) ?? this.sessions.get(sessionId)
    if (session === undefined) return failure('session-not-found', 'The Session was not found.')
    await this.hydrateSession(session)
    const text = extractPromptText(array(request.content))
    let images: AcpImage[]
    try {
      images = array(request.content).filter(part => record(part).type === 'image').map(parseAcpImage)
      if (images.length > 4 || (images.length > 0 && this.backend !== 'antigravity') || array(request.content).some(part => !['text', 'image'].includes(String(record(part).type)))) throw new Error('Unsupported ACP content.')
    } catch { return failure('attachment-error', 'Invalid or unsupported image attachment.') }
    if (text === undefined && images.length === 0) return failure('attachment-error', 'A prompt or image is required.')
    const imageBlocks = images.map(image => acpImageContent(image, `agy-image:${crypto.randomUUID()}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.slice(6)}`))
    this.cacheImageAttachments(sessionId, imageBlocks)
    const requestId = typeof request.requestId === 'string' && request.requestId.length > 0
      ? request.requestId
      : undefined
    await this.live.ensureFollow(session)
    const follow = [...this.follows].find(f => f.sessionId === sessionId)
    if (follow !== undefined) {
      follow.turn += 1
      follow.stepOpen = true
      this.live.pushEvent(follow, 'turn/start', { turn: follow.turn })
      this.live.pushEvent(follow, 'step/start', { turn: follow.turn, step: 1 })
      this.live.pushEvent(follow, 'user/message', {
        id: `user:${Date.now()}`,
        role: 'user',
        content: [...(text ? [{ type: 'text', text }] : []), ...imageBlocks],
        source: requestId ? { kind: 'user', rpcId: requestId } : { kind: 'user' },
      })
    }
    session.blank = false
    session.running = true
    session.updatedAt = Date.now()
    this.events.emitRemoteEvent('api-session/status', [sessionId, true])
    await this.client.prompt(session.acpSessionId, text ?? '', signal, images, this.backend)
    return success({ accepted: true })
  }

  private async cancel(request: JsonRecord, signal: AbortSignal): Promise<unknown> {
    const sessionId = extractSessionId(request)
    const session = this.ensureSessionRegistered(sessionId) ?? this.sessions.get(sessionId)
    if (session === undefined) return failure('session-not-found', 'The Session was not found.')
    await this.client.cancel(session.acpSessionId, signal)
    session.running = false
    for (const follow of this.follows) {
      if (follow.sessionId === sessionId) {
        this.live.closeFollowAfterRemoteStreamClosed(follow, { kind: 'aborted', reason: { kind: 'user' } })
      }
    }
    this.events.emitRemoteEvent('api-session/status', [sessionId, false])
    return success({ accepted: true })
  }

  private async renameSession(request: JsonRecord): Promise<unknown> {
    const sessionId = extractSessionId(request)
    const title = string(request.title)?.trim()
    const session = this.ensureSessionRegistered(sessionId) ?? this.sessions.get(sessionId)
    if (session === undefined) return failure('session-not-found', 'The Session was not found.')
    if (title === undefined) return failure('bad-request', 'A Session title is required.')
    session.title = title
    session.titleOverridden = true
    session.updatedAt = Date.now()
    this.events.publishProjection(sessionId, 'title', title)
    return success({ sessionId })
  }

  private cacheImageAttachments(sessionId: string, content: unknown[]): void {
    for (const value of content) {
      const block = record(value)
      const attachment = record(block.attachment)
      if (block.type === 'image' && typeof attachment.attachmentId === 'string' && typeof block.data === 'string') {
        this.imageAttachments.set(attachment.attachmentId, { sessionId, attachment, data: block.data })
      }
    }
  }

  private async attachment(request: JsonRecord): Promise<unknown> {
    const sessionId = extractSessionId(request)
    const attachmentId = string(request.attachmentId)
    const session = this.ensureSessionRegistered(sessionId)
    if (this.backend !== 'antigravity' || session === undefined || !attachmentId?.startsWith('agy-image:')) return failure('attachment-error', 'The image is not referenced by this AGY Session.')
    await this.hydrateSession(session)
    const cached = this.imageAttachments.get(attachmentId)
    return cached?.sessionId === sessionId ? success({ attachment: cached.attachment, data: cached.data }) : failure('attachment-error', 'The AGY image is unavailable or expired.')
  }

  private async hydrateSession(session: AcpSessionState): Promise<void> {
    if (this.backend === 'cursor' || session.blank || session.events.length > 0) return
    if (this.backend !== 'pi') return this.hydrateSessionOnce(session)
    const pending = this.pendingHistory.get(session.sessionId)
    if (pending) return pending
    const read = this.hydrateSessionOnce(session)
    this.pendingHistory.set(session.sessionId, read)
    try { await read } finally { if (this.pendingHistory.get(session.sessionId) === read) this.pendingHistory.delete(session.sessionId) }
  }

  private async hydrateSessionOnce(session: AcpSessionState): Promise<void> {
    let events: unknown[] = []
    if (this.client.loadSessionHistory !== undefined) {
      try {
        events = await this.client.loadSessionHistory(session.sessionId, this.backend)
      } catch (error) {
        // A failed PI read is not a successful empty baseline; do not continue
        // a restored conversation until its authoritative history is available.
        if (this.backend === 'pi') throw error
        // Preserve legacy AGY history availability behavior.
      }
    }
    if (events.length > 0) {
      session.events = events as unknown as Array<{ type: 'event'; event: NativeEvent }>
      session.blank = false
      session.updatedAt = Date.now()
      for (const event of session.events) this.cacheImageAttachments(session.sessionId, array(record(event.event.data).content ?? record(record(event.event.data).message).content))
    }
  }

  private async sessionHistory(request: JsonRecord): Promise<unknown> {
    const sessionId = extractSessionId(request)
    const session = this.ensureSessionRegistered(sessionId) ?? this.sessions.get(sessionId)
    if (session === undefined) return failure('session-not-found', 'The Session was not found.')
    await this.hydrateSession(session)
    const page = this.historyPage(session, {
      beforeSeq: optionalInteger(request.beforeSeq),
      limit: optionalPositiveInteger(request.maxMessages) ?? 50,
    })
    return success({
      ...page,
      events: page.records.map(entry => ({ event: entry.event })),
      projections: {
        asOfSeq: page.cursor,
        values: {
          title: session.title ?? (this.backend === "pi" ? "PI" : this.backend === "opencode" ? "OpenCode" : this.backend === "antigravity" ? "Antigravity" : "Cursor"),
          sessionListMetadata: { blank: session.blank && session.events.length === 0, lastPromptAt: null },
          modelSelection: this.modelSelectionProjection(sessionId),
          imageLimits: acpImageLimits(this.backend),
        },
      },
    })
  }

  private async sessionPage(request: JsonRecord): Promise<unknown> {
    const sessionId = extractSessionId(request)
    const session = this.ensureSessionRegistered(sessionId) ?? this.sessions.get(sessionId)
    if (session === undefined) return failure('session-not-found', 'The Session was not found.')
    await this.hydrateSession(session)
    const page = this.historyPage(session, {
      beforeSeq: optionalInteger(request.beforeSeq),
      throughSeq: optionalInteger(request.throughSeq),
      limit: optionalPositiveInteger(request.limit) ?? optionalPositiveInteger(request.maxMessages) ?? 50,
    })
    return success({ records: page.records, hasMore: page.hasMore })
  }

  private async sessionUsage(request: JsonRecord): Promise<unknown> {
    const sessionId = extractSessionId(request)
    const session = this.ensureSessionRegistered(sessionId) ?? this.sessions.get(sessionId)
    if (session === undefined) return failure('session-not-found', 'The Session was not found.')
    await this.hydrateSession(session)
    const usage = await collectSessionTokenUsage(sessionId, async () => ({
      records: session.events,
      hasMore: false,
    }), AbortSignal.timeout(60_000))
    return success(usage)
  }

  private historyPage(
    session: AcpSessionState,
    options: { beforeSeq?: number; throughSeq?: number; limit?: number } = {},
  ) {
    const lastSessionSeq = session.events.at(-1)?.event.seq ?? -1
    const throughSeq = Math.min(options.throughSeq ?? lastSessionSeq, lastSessionSeq)
    const endSeq = Math.min(throughSeq, options.beforeSeq === undefined ? throughSeq : options.beforeSeq - 1)
    const window = endSeq < 0 ? [] : session.events.filter(entry => entry.event.seq <= endSeq)
    const limit = options.limit ?? 50
    const records = window.slice(Math.max(0, window.length - limit))
    const cursor = records.at(-1)?.event.seq ?? -1
    return {
      header: {
        version: 3,
        id: session.sessionId,
        createdAt: session.createdAt,
        cwd: session.cwd,
        isSeeded: false,
      },
      cursor,
      nextTurn: Math.max(0, ...session.events.map(entry => isRecord(entry.event.data) && typeof entry.event.data.turn === 'number' ? entry.event.data.turn : 0)) + 1,
      records,
      hasMore: window.length > records.length,
      ...(session.running ? { activeTurnId: 'cursor-live' } : {}),
      assistantStream: { revision: 0 },
    }
  }

  private describeHost(): JsonRecord {
    const workspace = this.selectedWorkspaceId === undefined
      ? undefined
      : this.workspaceById.get(this.selectedWorkspaceId)
    const name = this.backendLabel()
    return {
      version: `${name} Remote`,
      cwd: workspace?.path ?? '',
      home: workspace?.path ?? '',
      provider: name,
      model: modelCatalog(this.backend).default.model,
      attachedSessions: this.sessions.size,
      canOpenPath: workspace !== undefined,
    }
  }

  private async listDirectory(request: JsonRecord, signal: AbortSignal): Promise<unknown> {
    const workspace = this.selectedWorkspaceId === undefined
      ? undefined
      : this.workspaceById.get(this.selectedWorkspaceId)
    if (workspace === undefined) return failure('workspace-not-found', `The ${this.backendLabel()} virtual Workspace was not found.`)
    const path = string(request.path) ?? workspace.path
    return success(await this.client.listDirectory(path, signal))
  }

  private registerSession(
    acpSessionId: string,
    cwd: string,
    title?: string,
    createdAt: number = Date.now(),
    updatedAt: number = Date.now(),
    blank: boolean = true,
  ): AcpSessionState {
    const session: AcpSessionState = {
      sessionId: `${sessionPrefix(this.backend)}${acpSessionId}`,
      acpSessionId,
      cwd,
      ...(title === undefined ? {} : { title }),
      blank,
      running: false,
      createdAt,
      updatedAt,
      events: [],
    }
    this.sessions.set(session.sessionId, session)
    return session
  }

  private applyDiscoveredTitle(session: AcpSessionState, title: string): void {
    const next = title.trim()
    if (this.closed || session.titleOverridden || !next || next === 'Untitled Session' || next === session.title) return
    session.title = next
    this.events.publishProjection(session.sessionId, 'title', next)
  }

  private async refreshSessionTitle(session: AcpSessionState): Promise<void> {
    if (this.backend === 'cursor' || this.closed || session.titleOverridden || this.client.listSessions === undefined) return
    try {
      const items = await this.client.listSessions(session.cwd, this.backend, 30)
      const current = items.find(item => item.conversationId === session.acpSessionId)
      if (current !== undefined && this.sessions.get(session.sessionId) === session) this.applyDiscoveredTitle(session, current.title)
    } catch {
      // Title discovery must not delay or fail an already completed turn.
    }
  }

  private async discoverAndAttachSessions(workspace: AcpVirtualWorkspaceView): Promise<void> {
    if (this.backend === 'cursor') return
    try {
      let discovered: Array<{ conversationId: string; title: string; createdAt: number; updatedAt: number }> = []
      if (this.client.listSessions !== undefined) {
        try {
          discovered = await this.client.listSessions(workspace.path, this.backend, 30)
        } catch (error) {
          if (this.backend === 'pi') throw error
          // Preserve legacy AGY catalog availability behavior.
        }
      }
      for (const item of discovered) {
        const sessionId = `${sessionPrefix(this.backend)}${item.conversationId}`
        if (!this.sessions.has(sessionId)) {
          this.registerSession(item.conversationId, workspace.path, item.title, item.createdAt, item.updatedAt, false)
        }
        const existing = this.sessions.get(sessionId)
        if (existing !== undefined) this.applyDiscoveredTitle(existing, item.title)
        if (!workspace.sessionIds.includes(sessionId)) {
          workspace.sessionIds.push(sessionId)
        }
      }
      workspace.sessionCount = workspace.sessionIds.length
      workspace.updatedAt = new Date().toISOString()
    } catch (error) {
      if (this.backend === 'pi') throw error
      // Preserve legacy AGY catalog availability behavior.
    }
  }

  private attachSessionToWorkspace(cwd: string, sessionId: string): void {
    const workspace = [...this.workspaceById.values()].find(item => item.path === cwd)
      ?? createAcpWorkspaceView(cwd, this.backend)
    const sessionIds = [sessionId, ...workspace.sessionIds.filter(id => id !== sessionId)]
    const next = {
      ...workspace,
      sessionIds,
      sessionCount: sessionIds.length,
      updatedAt: new Date().toISOString(),
    }
    this.workspaceById.set(next.workspaceId, next)
    if (this.selectedWorkspaceId === undefined) this.selectedWorkspaceId = next.workspaceId
  }

  private async ensureInitialSession(workspace: AcpVirtualWorkspaceView): Promise<AcpSessionState> {
    const cwd = workspace.path
    const created = await this.client.createSession(cwd, 'agent', this.backend)
    const sessionId = created.sessionId
    const title = this.backend === 'antigravity' ? 'Antigravity' : this.backend === 'opencode' ? 'OpenCode' : workspace.title
    const session = this.registerSession(sessionId, cwd, title)
    this.attachSessionToWorkspace(cwd, session.sessionId)
    this.events.emitRemoteEvent('api-session/added', [this.sessionSummary(session, 0)])
    this.publishWorkspaceBaseline()
    return session
  }

  private async handleSessionList(): Promise<unknown[]> {
    for (const workspace of this.workspaceById.values()) {
      await this.discoverAndAttachSessions(workspace)
      if (workspace.sessionIds.length === 0) {
        await this.ensureInitialSession(workspace)
      }
    }
    return this.sessionSummaries()
  }

  private sessionSummaries(): unknown[] {
    const selected = this.selectedWorkspaceId === undefined
      ? undefined
      : this.workspaceById.get(this.selectedWorkspaceId)
    const allowed = new Set(selected?.sessionIds ?? [...this.sessions.keys()])
    return [...this.sessions.values()]
      .filter(session => allowed.has(session.sessionId))
      .map(session => this.sessionSummary(session, 0))
  }

  private sessionSummary(session: AcpSessionState, asOfSeq: number): JsonRecord {
    return {
      sessionId: session.sessionId,
      agentAvailable: true,
      running: session.running,
      blank: session.blank,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      projections: {
        kind: 'sequenced',
        asOfSeq,
        values: {
          title: session.title ?? (this.backend === "pi" ? "PI" : this.backend === "opencode" ? "OpenCode" : this.backend === "antigravity" ? "Antigravity" : "Cursor"),
          sessionListMetadata: { blank: session.blank, lastPromptAt: null },
          modelSelection: this.modelSelectionProjection(session.sessionId),
          imageLimits: acpImageLimits(this.backend),
        },
      },
    }
  }

  private modelSelection(sessionId: string): AcpModelSelection {
    return this.selectedModels.get(sessionId) ?? modelCatalog(this.backend).default
  }

  private modelSelectionProjection(sessionId: string): { lastUsed: AcpModelSelection; next: AcpModelSelection } {
    const selection = this.modelSelection(sessionId)
    return { lastUsed: selection, next: selection }
  }

  private async hostSessionModels(sessionId: string): Promise<AcpSessionModels> {
    if (this.backend === 'cursor' || this.backend === 'opencode' || !this.client.sessionModels) return { current: { provider: this.backend, model: 'host-settings' }, routable: true, groups: [], failures: [] }
    const models = await this.client.sessionModels(nativeAcpId(sessionId, this.backend), this.backend)
    this.selectedModels.set(sessionId, models.current)
    return models
  }

  private async selectModel(request: JsonRecord): Promise<unknown> {
    const sessionId = extractSessionId(request)
    nativeAcpId(sessionId, this.backend)
    const provider = requiredString(request.provider, 'provider')
    const model = requiredString(request.model, 'model')
    const reasoningEffort = string(request.reasoningEffort)
    const catalog = this.backend !== 'cursor' ? await this.hostSessionModels(sessionId) : modelCatalog(this.backend)
    const group = catalog.groups.find(g => g.id === provider)
    const targetModel = group?.models.find(m => m.id === model)
    if (group === undefined || targetModel === undefined) {
      return failure('model-unavailable', `The selected ${this.backend} model is unavailable on this Host.`)
    }
    const supportedEfforts = targetModel.reasoning?.efforts.map(effort => effort.id) ?? []
    if (reasoningEffort !== undefined && !supportedEfforts.includes(reasoningEffort)) {
      return failure('model-unavailable', `The selected reasoning effort is unavailable for this ${this.backend} model.`)
    }
    const selected: AcpModelSelection = {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
    if (this.backend !== 'cursor' && this.backend !== 'opencode') {
      if (!this.client.selectModel) return failure('model-unavailable', 'The Host does not support ACP model selection.')
      const confirmed = await this.client.selectModel(nativeAcpId(sessionId, this.backend), this.backend, selected)
      this.selectedModels.set(sessionId, confirmed)
    } else return failure('model-unavailable', `${this.backendLabel()} model selection follows Host settings.`)
    const seq = this.nextProjectionSeq()
    this.events.publishProjection(sessionId, 'modelSelection', this.modelSelectionProjection(sessionId), seq)
    return success({ selected: this.modelSelection(sessionId) })
  }

  private publishWorkspaceBaseline(): void {
    for (const queue of this.workspaceStreams) {
      for (const workspace of this.visibleWorkspaces()) {
        queue.push({ type: 'upsert', workspace: nativeWorkspace(workspace) })
      }
      queue.push({ type: 'archived', archivedSessionIds: [] })
    }
  }

  private nextProjectionSeq(): number {
    this.lastProjectionSeq += 1
    return this.lastProjectionSeq
  }
}

export { acpCwdWorkspaceId, createAcpWorkspaceView, discoverAcpVirtualWorkspaces, modelCatalog } from './virtual-catalog.js'
export type { AcpModelSelection, AcpModelView, AcpVirtualWorkspaceView } from './virtual-catalog.js'
export type { AcpClientLike } from './virtual-contract.js'
