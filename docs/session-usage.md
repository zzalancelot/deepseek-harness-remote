# Session Token Usage API

给 Remote Client / Agent 使用的只读接口说明。权威线协议见 [protocol.md](protocol.md)。

## 用途

一次查询同时拿到：

1. **会话总量**：当前 `sessionId` 下，所有已提交模型调用的 token 合计
2. **最近一轮**：该会话里编号最大的那一轮（同一轮内多次模型调用会再相加）

不是账号下所有会话的总和，也不是未提交的流式回复。

## 调用路径

加密通道 RPC：`harness.remote.call`

```json
{
  "endpoint": "session/usage",
  "payload": {
    "args": {
      "request": {
        "sessionId": "<session-id>"
      }
    }
  }
}
```

也可用与 `session/page` 相同的地址：

```json
{
  "endpoint": "session/usage",
  "payload": {
    "args": {
      "request": {
        "address": { "kind": "session", "sessionId": "<session-id>" }
      }
    }
  }
}
```

子会话：

```json
{
  "address": {
    "kind": "subagent",
    "parentSessionId": "<parent-session-id>",
    "childSessionId": "<child-session-id>"
  }
}
```

Typert Client（`@dsh-remote/client-core`）：

```ts
const usage = await alphaClient.sessionUsage(sessionId)
// 子会话：
const usage = await alphaClient.sessionUsage(childSessionId, parentSessionId)
```

## 成功响应

官方 envelope：`{ "ok": true, "value": ... }`。`value` 形状：

```json
{
  "sessionId": "session-id",
  "inputTokens": 0,
  "outputTokens": 0,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "reasoningTokens": 0,
  "totalTokens": 0,
  "reportedCalls": 0,
  "unreportedCalls": 0,
  "complete": true,
  "turn": {
    "turn": 4,
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "reasoningTokens": 0,
    "totalTokens": 0,
    "reportedCalls": 0,
    "unreportedCalls": 0,
    "complete": true
  }
}
```

| 字段 | 含义 |
| --- | --- |
| 顶层计数 | **会话总量** |
| `turn` | **最近一轮**；还没有编号轮次时为 `null` |
| `inputTokens` | 未缓存输入 |
| `cacheReadTokens` / `cacheWriteTokens` | 缓存读 / 写 |
| `outputTokens` | 输出；已包含 reasoning |
| `reasoningTokens` | 推理 token（若上游单独报告） |
| `totalTokens` | 该范围内各次调用合计 |
| `reportedCalls` | 有可用用量的助手消息数 |
| `unreportedCalls` | 没有可用用量的助手消息数 |
| `complete` | `true` 表示该范围合计完整 |

Agent 通常读：

- 会话总量：`value.totalTokens`
- 本轮用量：`value.turn?.totalTokens`

## 规则

- Host 本地根据已允许的 `session/page` 翻页汇总，不转发官方不存在的 `session/usage` 方法。
- 只累计已提交的 `assistant/message` 官方 `usage`；不估算缺失数字。
- 进行中的流式回复，在提交为 `assistant/message` 之前不计入。
- `complete: false` 表示该范围有缺失用量、用量不一致，或历史没有读完；此时 `totalTokens` 仍是已读到部分的合计，不能当成最终账单。
- 超时 60s；请求/响应仍受 `MAX_SECURE_MESSAGE_BYTES` 限制。

## 失败

| 情况 | 结果 |
| --- | --- |
| 缺少 / 非法 `sessionId` 或 address | `{ ok: false, error: { code: "INVALID_MESSAGE", ... } }` |
| 历史页失败（如会话不存在） | 透传该页的 `{ ok: false, error }` |
| endpoint 未在 Host allowlist（旧插件） | `METHOD_NOT_ALLOWED` |

## 最小示例（给 Agent）

```ts
import type { HarnessAlphaClient } from '@dsh-remote/client-core'

async function reportUsage(client: HarnessAlphaClient, sessionId: string) {
  const usage = await client.sessionUsage(sessionId)
  return {
    sessionTotal: usage.totalTokens,
    sessionComplete: usage.complete,
    latestTurn: usage.turn?.turn ?? null,
    latestTurnTotal: usage.turn?.totalTokens ?? null,
    latestTurnComplete: usage.turn?.complete ?? null,
  }
}
```

原始 RPC 等价于：

```ts
await gateway.call('session/usage', {
  args: { request: { sessionId } },
})
```

## 验证边界

- 已覆盖：分页累加、重复 seq 去重、不一致用量丢弃、chunk usage、子会话 address、Client 解析。
- 未宣称：Desktop/Android UI 展示、跨设备加密验收、账号级账单。
