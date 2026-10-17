import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { describe, expect, it, vi } from 'vitest'
import { readSessionTokenUsage } from '../src/session-token-usage.js'
import type { TypertRpcResult } from '../src/typert-gateway-contract.js'

describe('session token usage', () => {
  const assistant = (seq: number, usage?: Record<string, number>, turn?: number) => ({
    type: 'event',
    event: {
      type: 'assistant/message',
      seq,
      time: 1,
      data: {
        ...(turn === undefined ? {} : { turn }),
        ...(usage === undefined ? {} : { usage }),
      },
    },
  })

  it('sums committed assistant usage from official history pages', async () => {
    await runScenarios([
      {
        name: 'sums later and earlier pages without counting a repeated seq or a live chunk',
        run: async () => {
          const dispatch = vi.fn(async (endpoint: string, payload: unknown): Promise<TypertRpcResult> => {
            expect(endpoint).toBe('session/page')
            const request = (payload as { args: { request: { beforeSeq?: number } } }).args.request
            if (request.beforeSeq === undefined) {
              return {
                ok: true,
                value: {
                  records: [
                    assistant(5, { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 2, reasoningTokens: 1, totalTokens: 22 }),
                    { type: 'event', event: { type: 'user/message', seq: 4, time: 1, data: {} } },
                    { type: 'chunks', event: { type: 'assistant/message', seq: 9, time: 1, data: { usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } } } },
                  ],
                  hasMore: true,
                },
              }
            }
            expect(request.beforeSeq).toBe(4)
            return {
              ok: true,
              value: {
                records: [
                  assistant(5, { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 2, reasoningTokens: 1, totalTokens: 22 }),
                  assistant(2, { inputTokens: 3, outputTokens: 1 }),
                ],
                hasMore: false,
              },
            }
          })
          await expect(readSessionTokenUsage(dispatch, {
            args: { request: { address: { kind: 'session', sessionId: 's1' } } },
          }, new AbortController().signal)).resolves.toEqual({
            ok: true,
            value: {
              sessionId: 's1',
              inputTokens: 13,
              outputTokens: 5,
              cacheReadTokens: 6,
              cacheWriteTokens: 2,
              reasoningTokens: 1,
              totalTokens: 26,
              reportedCalls: 2,
              unreportedCalls: 0,
              complete: false,
              turn: null,
            },
          })
          expect(dispatch).toHaveBeenCalledTimes(2)
        },
      },
      {
        name: 'drops an inconsistent usage record and keeps the valid call',
        run: async () => {
          const dispatch = vi.fn(async (): Promise<TypertRpcResult> => ({
            ok: true,
            value: {
              records: [
                assistant(2, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }),
                assistant(3, { inputTokens: 1, outputTokens: 1, reasoningTokens: 4, totalTokens: 2 }),
              ],
              hasMore: false,
            },
          }))
          await expect(readSessionTokenUsage(dispatch, {
            args: { request: { sessionId: 's1' } },
          }, new AbortController().signal)).resolves.toMatchObject({
            ok: true,
            value: { inputTokens: 1, outputTokens: 1, totalTokens: 2, reportedCalls: 1, unreportedCalls: 1, complete: false },
          })
        },
      },
      {
        name: 'stops when an older page does not move backward',
        run: async () => {
          const dispatch = vi.fn(async (): Promise<TypertRpcResult> => ({
            ok: true,
            value: {
              records: [assistant(3, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }, 2)],
              hasMore: true,
            },
          }))
          await expect(readSessionTokenUsage(dispatch, {
            args: { request: { sessionId: 's1' } },
          }, new AbortController().signal)).resolves.toMatchObject({
            ok: true,
            value: { reportedCalls: 1, complete: false, turn: { turn: 2, reportedCalls: 1, complete: false } },
          })
          expect(dispatch).toHaveBeenCalledTimes(2)
        },
      },
      {
        name: 'rejects an invalid session address before reading history',
        run: async () => {
          const dispatch = vi.fn()
          await expect(readSessionTokenUsage(dispatch, { args: {} }, new AbortController().signal)).resolves.toEqual({
            ok: false,
            error: { code: 'INVALID_MESSAGE', message: 'The session usage request is invalid.', details: {} },
          })
          expect(dispatch).not.toHaveBeenCalled()
        },
      },
      {
        name: 'returns the history page error unchanged',
        run: async () => {
          const dispatch = vi.fn(async (): Promise<TypertRpcResult> => ({
            ok: false,
            error: { code: 'SESSION_NOT_FOUND', message: 'The session is no longer available.', details: {} },
          }))
          await expect(readSessionTokenUsage(dispatch, {
            args: { request: { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child' } } },
          }, new AbortController().signal)).resolves.toEqual({
            ok: false,
            error: { code: 'SESSION_NOT_FOUND', message: 'The session is no longer available.', details: {} },
          })
          expect(dispatch).toHaveBeenCalledWith('session/page', {
            args: {
              request: {
                address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'unknown' },
                maxMessages: 60,
              },
            },
          }, expect.any(AbortSignal))
        },
      },
      {
        name: 'separates the latest turn from the session total',
        run: async () => {
          const message = (seq: number, turn: number, usage: Record<string, number>) => ({
            type: 'event',
            event: { type: 'assistant/message', seq, time: 1, data: { turn, usage } },
          })
          const dispatch = vi.fn(async (): Promise<TypertRpcResult> => ({
            ok: true,
            value: {
              records: [
                message(1, 1, { inputTokens: 3, outputTokens: 1 }),
                message(2, 2, { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 2, reasoningTokens: 1, totalTokens: 22 }),
                message(3, 2, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }),
              ],
              hasMore: false,
            },
          }))
          await expect(readSessionTokenUsage(dispatch, {
            args: { request: { sessionId: 's1' } },
          }, new AbortController().signal)).resolves.toEqual({
            ok: true,
            value: {
              sessionId: 's1',
              inputTokens: 14,
              outputTokens: 6,
              cacheReadTokens: 6,
              cacheWriteTokens: 2,
              reasoningTokens: 1,
              totalTokens: 28,
              reportedCalls: 3,
              unreportedCalls: 0,
              complete: false,
              turn: {
                turn: 2,
                inputTokens: 11,
                outputTokens: 5,
                cacheReadTokens: 6,
                cacheWriteTokens: 2,
                reasoningTokens: 1,
                totalTokens: 24,
                reportedCalls: 2,
                unreportedCalls: 0,
                complete: true,
              },
            },
          })
        },
      },
      {
        name: 'uses a usage chunk when the committed message has no usage field',
        run: async () => {
          const dispatch = vi.fn(async (): Promise<TypertRpcResult> => ({
            ok: true,
            value: {
              records: [{
                type: 'event',
                event: {
                  type: 'assistant/message',
                  seq: 1,
                  time: 1,
                  data: {
                    stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 1 } } }],
                  },
                },
              }],
              hasMore: false,
            },
          }))
          await expect(readSessionTokenUsage(dispatch, {
            args: { request: { sessionId: 's1' } },
          }, new AbortController().signal)).resolves.toMatchObject({
            ok: true,
            value: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 1, totalTokens: 7, reportedCalls: 1, complete: true },
          })
        },
      },
    ])
  })
})
