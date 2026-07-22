# Agent 循环事件

> [English](./LOOP_EVENTS.md) · [中文](./LOOP_EVENTS.zh.md)

Cultivagent 不把厂商 hook 名当作产品模型。厂商 hook 是原始输入。监控器把它们翻译成规范的 loop event，用于面板状态、token 计数和未来的游戏 UI。

## 规范循环

实际循环如下：

1. `session.start`：agent 进程 / 会话变得可观测。
2. `input.received`：用户 prompt、CLI 命令或排队任务进入 agent。
3. `context.loaded` / `context.build`：准备 instructions、memory、rules、resources 和压缩后的上下文。
4. `agent.start` / `turn.start`：agent 开始为该 prompt 工作。
5. `model.request.start`：构建并发送 LLM 请求。
6. `message.streaming`：助手正在产出可见文本或中间推理摘要。
7. `tool.before`：模型选了一个 action/tool，但尚未执行。
8. `approval.request`：运行时等待权限 / 用户决策。
9. `tool.start` / `tool.update` / `tool.end`：工具执行中，随后返回输出。
10. `tool.batch.end`：并行 tool call 在下一次模型调用前完成。
11. 循环回到第 5 步，直到不再需要 tool call。
12. `model.response`：一次模型尝试完成；usage 字段存在时在此计入 token。
13. `agent.finalizing`：agent 在检查或组织最终输出。
14. `agent.end`：prompt / run 完成。
15. `agent.idle`：agent 无活动工作。
16. `error`：本轮 / 会话失败。

## Agent 状态值

这些值驱动游戏 UI：

- `idle`：无活动工作。
- `receiving_input`：正在接收 / 转换 prompt 或命令。
- `loading_context`：正在准备 instructions、resources、memory 或压缩上下文。
- `thinking`：模型 / agent 正在推理或准备下一步。
- `streaming`：正在显示助手输出。
- `tool_calling`：有 tool call 待处理 / 运行中。
- `waiting_approval`：等待用户 / 运行时权限。
- `waiting_user`：tool / MCP 流程中等待显式用户输入。
- `compacting`：上下文压缩进行中。
- `delegating`：正在创建或运行 subagent / 任务。
- `finalizing`：正在准备最终答案或收尾。
- `done`：run 完成。
- `error`：run 失败。

## Raw Hook 策略

每个 adapter 应对它观察到的每个 hook / event 发一个事件，即使 Cultivagent 还不知道如何解读。

每个存储事件保留：

- `event_type`：原始厂商 hook / event 名。
- `meta.raw_hook`：原始厂商 hook / event 名（可得时）。
- `meta.loop_event`：规范 loop event。
- `meta.agent_status`：面板 / 游戏状态。
- `meta.event_role`：大类角色，如 `session`、`input`、`model`、`tool`、`approval`、`subagent`、`context`、`message` 或 `raw`。

未知 hook 映射为：

```json
{
  "loop_event": "hook.raw",
  "agent_status": "running",
  "event_role": "raw"
}
```

这样让捕获完整，同时保持语义解读诚实。

## 厂商映射

| 规范事件 | Codex | Claude Code | OpenCode | Pi | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| `session.start` | `SessionStart` | `SessionStart` | `session.created` | `session_start` | `session_start`, `gateway_start` |
| `input.received` | `UserPromptSubmit` | `UserPromptSubmit` | `tui.prompt.append` | `input` | `message_received`, `inbound_claim` |
| `context.loaded` | OTel/config context, `PreCompact/PostCompact` 相邻 | `InstructionsLoaded` | resource/session 更新 | `resources_discover` | `agent_turn_prepare`, `heartbeat_prompt_contribution` |
| `agent.start` | 由 prompt/session 事件推断 | `TaskCreated`（task/subagent 工作） | `session.status` | `before_agent_start`, `agent_start` | `before_agent_run` |
| `model.request.start` | `codex.api_request`, `codex.sse_event` 起始类 OTel | `claude_code.llm_request` span/log | 仅 message/session 事件或 stats | `before_provider_request` | `model_call_started`, `llm_input` |
| `message.streaming` | `codex.sse_event` 流事件 | `MessageDisplay`，OTel 助手响应事件 | `message.updated` | `message_update` | `before_agent_reply` |
| `tool.before` | `PreToolUse` | `PreToolUse` | `tool.execute.before` | `tool_call`, `tool_execution_start` | `before_tool_call` |
| `approval.request` | `PermissionRequest` | `PermissionRequest` | `permission.asked` | `tool_call`（含 extension/用户提示） | `before_tool_call`（带 `requireApproval`） |
| `tool.end` | `PostToolUse` | `PostToolUse`, `PostToolUseFailure` | `tool.execute.after` | `tool_result`, `tool_execution_end` | `after_tool_call` |
| `tool.batch.end` | 无直接 hook | `PostToolBatch` | 由 tool 事件推断 | 由轮次结束推断 | 由 tool 事件推断 |
| `model.response` | `codex.sse_event`（`response.completed`） | `claude_code.token.usage`, `llm_request` usage | `opencode stats` 或已验证消息 usage | `message_end`, `after_provider_response` | `model_call_ended`, `llm_output` |
| `agent.end` | `Stop` | `Stop`, `StopFailure` | `session.idle`, `session.error` | `agent_end`, `turn_end` | `agent_end`, `session_end` |
| `agent.idle` | `Stop` 后或心跳超时推断 | `TeammateIdle` | `session.idle` | `ctx.isIdle()`/session idle 信号 | `session_end`（reason `idle`） |
| `compaction.before` | `PreCompact` | `PreCompact` | `session.compacted` 之前不可得 | `session_before_compact` | `before_compaction` |
| `compaction.after` | `PostCompact` | `PostCompact` | `session.compacted` | `session_compact` | `after_compaction` |
| `subagent.start` | `SubagentStart` | `SubagentStart`, `TaskCreated` | 无通用 hook | fork/session 事件 | `subagent_spawned` |
| `subagent.end` | `SubagentStop` | `SubagentStop`, `TaskCompleted` | 无通用 hook | session shutdown/switch | `subagent_ended` |

## Token 计数

Token 计数不是"所有 hook"。只从已完成的模型响应或官方 usage 接口计数：

- Codex：OTel `codex.sse_event`，其中 stream event 为 `response.completed`。
- Claude Code：OTel metrics/logs，尤其 token/cost usage 和 `llm_request` 属性。
- OpenCode：优先 `opencode stats`；仅在有原始 fixture 证明后才用 per-message 插件 usage。
- Pi：助手 `message_end` usage 或 provider 响应 usage（可得时）。
- OpenClaw：`model_call_ended` / `llm_output` usage（可得时）。

生命周期 hook 对游戏 UI 仍然重要，但不得编造 usage。

## 已核查的官方来源

- OpenAI Agents SDK 概览：https://developers.openai.com/api/docs/guides/agents
- OpenAI tool calling 流程：https://developers.openai.com/api/docs/guides/function-calling
- OpenAI reasoning summaries：https://developers.openai.com/api/docs/guides/reasoning
- Codex manual hooks 与 OTel 章节，2026-07-01 用 OpenAI docs helper 获取。
- Claude Code hooks 参考：https://code.claude.com/docs/en/hooks
- Claude Code monitoring/OTel：https://code.claude.com/docs/en/monitoring-usage
- OpenCode plugins：https://opencode.ai/docs/plugins/
- Pi extensions：https://pi.dev/docs/latest/extensions
- OpenClaw automation hooks：https://docs.openclaw.ai/automation/hooks
- OpenClaw plugin hooks：https://docs.openclaw.ai/plugins/hooks
