# Agent 交接：`session/usage` 接口

把本文交给其他 Agent 即可调用。完整字段与失败语义见同目录 [session-usage.md](./session-usage.md)；线协议权威见 [protocol.md](./protocol.md)。

## 一句话

加密通道调用 `session/usage`，一次拿到**当前会话 token 总量**和**最近一轮**用量。不是账号账单，也不含未提交的流式回复。

## 前置条件

1. 已与 Host 建立认证后的加密 Remote 通道（`harness.remote.call` / Typert）。
2. Host 插件含本能力（本地 Desktop 已装 `feat/session-token-usage` / `2a742a7`；上游需合并 PR 或安装同版本）。
3. 已知目标 `sessionId`（或 subagent 的 parent/child）。

## 推荐调用（client-core）

```ts
import type { HarnessAlphaClient } from '@dsh-remote/client-core'

const usage = await alphaClient.sessionUsage(sessionId)
// 子会话：
// const usage = await alphaClient.sessionUsage(childSessionId, parentSessionId)

const sessionTotal = usage.totalTokens
const latestTurnTotal = usage.turn?.totalTokens ?? null
const okToBill = usage.complete && (usage.turn == null || usage.turn.complete)
```

## 原始 RPC

`endpoint`: `session/usage`

```json
{
  "args": {
    "request": {
      "sessionId": "<session-id>"
    }
  }
}
```

或：

```json
{
  "args": {
    "request": {
      "address": { "kind": "session", "sessionId": "<session-id>" }
    }
  }
}
```

子会话 address：

```json
{
  "kind": "subagent",
  "parentSessionId": "<parent>",
  "childSessionId": "<child>"
}
```

成功 envelope：`{ "ok": true, "value": { ... } }`。

## 读哪些字段

| 需求 | 字段 |
| --- | --- |
| 会话累计 | `value.totalTokens`（及 `inputTokens` / `outputTokens` 等） |
| 最近一轮 | `value.turn.totalTokens`；`value.turn.turn` 为轮次编号 |
| 是否可当真 | `value.complete`；轮次看 `value.turn.complete` |
| 无轮次 | `value.turn === null`（还没有编号轮） |

`complete: false` 时数字仍是已读到部分的合计，**不能**当最终账单。

## 硬规则（Agent 勿违反）

- 只读；不要发明账号级汇总或写用量接口。
- 进行中的流式助手回复在提交为 `assistant/message` 前不计入。
- 缺失 usage 不估算；用 `unreportedCalls` / `complete` 判断。
- 超时约 60s；旧 Host 无 allowlist 时会 `METHOD_NOT_ALLOWED`。

## 最小验收

1. 对有历史的会话调用，`totalTokens >= turn.totalTokens`（有 turn 时）。
2. 再发一轮并等提交后，`turn.turn` 增大或 `turn.totalTokens` 变化，会话总量不减。
3. 非法 / 空 `sessionId` → `INVALID_MESSAGE`；不存在会话 → 透传 `session/page` 类错误。
