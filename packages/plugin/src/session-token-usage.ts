import type { TypertRpcResult } from './typert-gateway-contract.js'
import { RpcError } from './safe-error.js'

/** Official per-call token accounting for one scope. */
export interface TokenUsageCounts {
  /** Uncached input only. Cached input is reported in the cache fields. */
  inputTokens: number
  /** Includes reasoning tokens when the provider reports them inside output. */
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Sum of per-call totals. Exact only when `complete` is true. */
  totalTokens: number
  reportedCalls: number
  unreportedCalls: number
  /**
   * True when every committed assistant message in this scope contributed a
   * consistent total. In-progress streams are excluded.
   */
  complete: boolean
}

/** Committed usage of the latest numbered turn. */
export interface SessionTurnUsage extends TokenUsageCounts {
  turn: number
}

/** Session total plus the latest turn. Top-level counts are the whole session. */
export interface SessionTokenUsage extends TokenUsageCounts {
  sessionId: string
  /** Null when the session has no numbered turn yet. */
  turn: SessionTurnUsage | null
}

const USAGE_PAGE_MESSAGES = 60
const USAGE_MAX_PAGES = 200

export function createSessionTokenUsage(sessionId: string): SessionTokenUsage {
  return { sessionId, ...emptyCounts(), turn: null }
}

function emptyCounts(): TokenUsageCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    reportedCalls: 0,
    unreportedCalls: 0,
    complete: true,
  }
}

interface TurnLedger {
  latest?: number
  buckets: Map<number, TokenUsageCounts>
}

function createTurnLedger(): TurnLedger {
  return { buckets: new Map() }
}

interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  exactTotal: boolean
}

/**
 * Adds committed `assistant/message` usage from one history page.
 * Returns the oldest event seq in the page, when any record has one.
 */
export function accumulateSessionTokenUsage(
  total: SessionTokenUsage,
  records: readonly unknown[],
  seen: Set<number>,
  turns: TurnLedger = createTurnLedger(),
): number | undefined {
  let oldest: number | undefined
  for (const record of records) {
    const event = eventOf(record)
    if (event === undefined) continue
    if (event.seq !== undefined) {
      oldest = oldest === undefined ? event.seq : Math.min(oldest, event.seq)
      if (seen.has(event.seq)) continue
      seen.add(event.seq)
    }
    const turn = turnNumber(event.data)
    if (turn !== undefined) noteTurn(turns, turn)
    if (event.type !== 'assistant/message') continue
    const usage = normalizeUsage(event.data)
    const bucket = turn === undefined ? undefined : turns.buckets.get(turn)
    if (usage === undefined) {
      markUnreported(total)
      if (bucket !== undefined) markUnreported(bucket)
      continue
    }
    applyUsage(total, usage)
    if (bucket !== undefined) applyUsage(bucket, usage)
  }
  return oldest
}

export async function collectSessionTokenUsage(
  sessionId: string,
  readPage: (beforeSeq: number | undefined) => Promise<{ records: unknown[]; hasMore: boolean }>,
  signal: AbortSignal,
): Promise<SessionTokenUsage> {
  const usage = createSessionTokenUsage(sessionId)
  const turns = createTurnLedger()
  const seen = new Set<number>()
  let beforeSeq: number | undefined
  for (let page = 0; page < USAGE_MAX_PAGES; page += 1) {
    if (signal.aborted) throw new RpcError('CANCELLED', 'The session usage request was cancelled.')
    const result = await readPage(beforeSeq)
    const oldest = accumulateSessionTokenUsage(usage, result.records, seen, turns)
    if (!result.hasMore) return finishUsage(usage, turns, true)
    if (oldest === undefined || (beforeSeq !== undefined && oldest >= beforeSeq)) {
      usage.complete = false
      return finishUsage(usage, turns, false)
    }
    beforeSeq = oldest
  }
  usage.complete = false
  return finishUsage(usage, turns, false)
}

/** Host read of official session history. Does not forward `session/usage` itself. */
export async function readSessionTokenUsage(
  dispatch: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<TypertRpcResult>,
  payload: unknown,
  signal: AbortSignal,
): Promise<TypertRpcResult> {
  const address = usageAddress(payload)
  if (address === undefined) {
    return { ok: false, error: { code: 'INVALID_MESSAGE', message: 'The session usage request is invalid.', details: {} } }
  }
  try {
    const usage = await collectSessionTokenUsage(address.sessionId, async beforeSeq => {
      const result = await dispatch('session/page', {
        args: {
          request: {
            address: address.wire,
            maxMessages: USAGE_PAGE_MESSAGES,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          },
        },
      }, signal)
      if (result.ok !== true) throw new UsagePageError(result)
      const value = isRecord(result.value) ? result.value : {}
      return {
        records: Array.isArray(value.records) ? value.records : [],
        hasMore: value.hasMore === true,
      }
    }, signal)
    return { ok: true, value: usage }
  } catch (error) {
    if (error instanceof UsagePageError) return error.result
    throw error
  }
}

class UsagePageError extends Error {
  constructor(readonly result: TypertRpcResult) {
    super('Session history page failed.')
  }
}

function usageAddress(payload: unknown): { sessionId: string; wire: Record<string, unknown> } | undefined {
  const request = requestOf(payload)
  const address = isRecord(request.address) ? request.address : undefined
  if (address?.kind === 'subagent') {
    if (!validId(address.parentSessionId) || !validId(address.childSessionId)) return undefined
    return {
      sessionId: address.childSessionId,
      wire: {
        kind: 'subagent',
        parentSessionId: address.parentSessionId,
        childSessionId: address.childSessionId,
        mode: 'unknown',
      },
    }
  }
  const sessionId = address?.kind === 'session' && typeof address.sessionId === 'string'
    ? address.sessionId
    : typeof request.sessionId === 'string' ? request.sessionId : undefined
  if (!validId(sessionId)) return undefined
  return { sessionId, wire: { kind: 'session', sessionId } }
}

function requestOf(payload: unknown): Record<string, unknown> {
  const root = isRecord(payload) ? payload : {}
  const args = isRecord(root.args) ? root.args : root
  return isRecord(args.request) ? args.request : isRecord(args._request) ? args._request : args
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')
}

function eventOf(record: unknown): { type: string; seq?: number; data: unknown } | undefined {
  if (!isRecord(record) || record.type === 'chunks') return undefined
  const event = record.type === 'event' && isRecord(record.event)
    ? record.event
    : isRecord(record.event) && typeof record.event.type === 'string'
      ? record.event
      : typeof record.type === 'string' ? record : undefined
  if (event === undefined || typeof event.type !== 'string') return undefined
  const seq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : undefined
  return { type: event.type, ...(seq === undefined ? {} : { seq }), data: event.data }
}

function normalizeUsage(data: unknown): NormalizedUsage | undefined {
  if (!isRecord(data)) return undefined
  const value = usageRecord(data)
  if (value === undefined) return undefined
  if (!count(value.inputTokens) || !count(value.outputTokens)) return undefined
  const usage: NormalizedUsage = {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    exactTotal: false,
  }
  const cacheRead = value.cacheReadTokens
  const cacheWrite = value.cacheWriteTokens
  const reasoning = value.reasoningTokens
  const total = value.totalTokens
  if (cacheRead !== undefined && !count(cacheRead)) return undefined
  if (cacheWrite !== undefined && !count(cacheWrite)) return undefined
  if (reasoning !== undefined && !count(reasoning)) return undefined
  if (total !== undefined && !count(total)) return undefined
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  if (usage.reasoningTokens > usage.outputTokens) return undefined
  const knownPrompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const knownTotal = knownPrompt + usage.outputTokens
  if (!Number.isSafeInteger(knownPrompt) || !Number.isSafeInteger(knownTotal)) return undefined
  if (total !== undefined && (total < knownTotal || (cacheRead !== undefined && cacheWrite !== undefined && total !== knownTotal))) return undefined
  if (total !== undefined) {
    usage.totalTokens = total
    usage.exactTotal = true
  } else if (cacheRead !== undefined && cacheWrite !== undefined) {
    usage.totalTokens = knownTotal
    usage.exactTotal = true
  } else {
    usage.totalTokens = knownTotal
    usage.exactTotal = false
  }
  return usage
}

function usageRecord(data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(data.usage)) return data.usage
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const row = stream[index]
    if (!isRecord(row) || row.type !== 'chunk' || !isRecord(row.chunk) || row.chunk.type !== 'usage' || !isRecord(row.chunk.usage)) continue
    return row.chunk.usage
  }
  return undefined
}

function noteTurn(turns: TurnLedger, turn: number): void {
  if (turns.latest === undefined || turn > turns.latest) turns.latest = turn
  if (!turns.buckets.has(turn)) turns.buckets.set(turn, emptyCounts())
}

function turnNumber(data: unknown): number | undefined {
  if (!isRecord(data) || !count(data.turn)) return undefined
  return data.turn
}

function markUnreported(total: TokenUsageCounts): void {
  total.unreportedCalls += 1
  total.complete = false
}

function finishUsage(usage: SessionTokenUsage, turns: TurnLedger, historyComplete: boolean): SessionTokenUsage {
  if (turns.latest === undefined) {
    usage.turn = null
    return usage
  }
  const counts = turns.buckets.get(turns.latest) ?? emptyCounts()
  if (!historyComplete) counts.complete = false
  usage.turn = { turn: turns.latest, ...counts }
  return usage
}

function applyUsage(total: TokenUsageCounts, usage: NormalizedUsage): void {
  const inputTokens = total.inputTokens + usage.inputTokens
  const outputTokens = total.outputTokens + usage.outputTokens
  const cacheReadTokens = total.cacheReadTokens + usage.cacheReadTokens
  const cacheWriteTokens = total.cacheWriteTokens + usage.cacheWriteTokens
  const reasoningTokens = total.reasoningTokens + usage.reasoningTokens
  const totalTokens = total.totalTokens + usage.totalTokens
  const reportedCalls = total.reportedCalls + 1
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, reportedCalls].every(Number.isSafeInteger)) {
    total.unreportedCalls += 1
    total.complete = false
    return
  }
  total.inputTokens = inputTokens
  total.outputTokens = outputTokens
  total.cacheReadTokens = cacheReadTokens
  total.cacheWriteTokens = cacheWriteTokens
  total.reasoningTokens = reasoningTokens
  total.totalTokens = totalTokens
  total.reportedCalls = reportedCalls
  if (!usage.exactTotal) total.complete = false
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
