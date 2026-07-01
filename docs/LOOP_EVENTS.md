# Agent Loop Events

Cultivagent does not treat vendor hook names as the product model. Vendor hooks are raw input. The monitor translates them into canonical loop events for dashboard state, token accounting, and future game UI.

## Canonical Loop

The practical loop is:

1. `session.start`: the agent process/session becomes observable.
2. `input.received`: the user prompt, CLI command, or queued task enters the agent.
3. `context.loaded` / `context.build`: instructions, memory, rules, resources, and compacted context are prepared.
4. `agent.start` / `turn.start`: the agent begins work for the prompt.
5. `model.request.start`: the LLM request is built and sent.
6. `message.streaming`: the assistant is producing visible text or intermediate reasoning summaries.
7. `tool.before`: the model selected an action/tool, but it has not executed yet.
8. `approval.request`: the runtime is waiting on a permission/user decision.
9. `tool.start` / `tool.update` / `tool.end`: tool execution is running and then returns output.
10. `tool.batch.end`: parallel tool calls finish before the next model call.
11. The loop repeats at step 5 until no more tool calls are needed.
12. `model.response`: a model attempt completes; token usage is counted here when usage fields exist.
13. `agent.finalizing`: the agent is checking or composing final output.
14. `agent.end`: the prompt/run is complete.
15. `agent.idle`: the agent has no active work.
16. `error`: the turn/session failed.

## Agent Status Values

These values drive the game UI:

- `idle`: not doing active work.
- `receiving_input`: prompt or command is being accepted/transformed.
- `loading_context`: instructions, resources, memories, or compaction context are being prepared.
- `thinking`: the model/agent is reasoning or preparing the next action.
- `streaming`: assistant output is being displayed.
- `tool_calling`: a tool call is pending/running.
- `waiting_approval`: blocked on user/runtime permission.
- `waiting_user`: blocked on explicit user input during a tool/MCP flow.
- `compacting`: context compaction is running.
- `delegating`: subagent/task work is being created or running.
- `finalizing`: final answer or teardown is being prepared.
- `done`: run completed.
- `error`: run failed.

## Raw Hook Policy

Every adapter should send one event for every hook/event it observes, even if Cultivagent does not know how to interpret it yet.

Each stored event keeps:

- `event_type`: raw vendor hook/event name.
- `meta.raw_hook`: raw vendor hook/event name when available.
- `meta.loop_event`: canonical loop event.
- `meta.agent_status`: dashboard/game status.
- `meta.event_role`: broad role such as `session`, `input`, `model`, `tool`, `approval`, `subagent`, `context`, `message`, or `raw`.

Unknown hooks map to:

```json
{
  "loop_event": "hook.raw",
  "agent_status": "running",
  "event_role": "raw"
}
```

That makes the system complete for capture while keeping semantic interpretation honest.

## Vendor Mapping

| Canonical | Codex | Claude Code | OpenCode | Pi | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| `session.start` | `SessionStart` | `SessionStart` | `session.created` | `session_start` | `session_start`, `gateway_start` |
| `input.received` | `UserPromptSubmit` | `UserPromptSubmit` | `tui.prompt.append` | `input` | `message_received`, `inbound_claim` |
| `context.loaded` | OTel/config context, `PreCompact/PostCompact` adjacent | `InstructionsLoaded` | resource/session updates | `resources_discover` | `agent_turn_prepare`, `heartbeat_prompt_contribution` |
| `agent.start` | inferred from prompt/session events | `TaskCreated` for task/subagent work | `session.status` | `before_agent_start`, `agent_start` | `before_agent_run` |
| `model.request.start` | `codex.api_request`, `codex.sse_event` start-ish OTel | `claude_code.llm_request` span/log | message/session events or stats only | `before_provider_request` | `model_call_started`, `llm_input` |
| `message.streaming` | `codex.sse_event` stream events | `MessageDisplay`, OTel assistant response events | `message.updated` | `message_update` | `before_agent_reply` |
| `tool.before` | `PreToolUse` | `PreToolUse` | `tool.execute.before` | `tool_call`, `tool_execution_start` | `before_tool_call` |
| `approval.request` | `PermissionRequest` | `PermissionRequest` | `permission.asked` | `tool_call` with extension/user prompt | `before_tool_call` with `requireApproval` |
| `tool.end` | `PostToolUse` | `PostToolUse`, `PostToolUseFailure` | `tool.execute.after` | `tool_result`, `tool_execution_end` | `after_tool_call` |
| `tool.batch.end` | no direct hook | `PostToolBatch` | inferred from tool events | inferred from turn end | inferred from tool events |
| `model.response` | `codex.sse_event` with `response.completed` | `claude_code.token.usage`, `llm_request` usage | `opencode stats` or verified message usage | `message_end`, `after_provider_response` | `model_call_ended`, `llm_output` |
| `agent.end` | `Stop` | `Stop`, `StopFailure` | `session.idle`, `session.error` | `agent_end`, `turn_end` | `agent_end`, `session_end` |
| `agent.idle` | inferred after `Stop` or heartbeat timeout | `TeammateIdle` | `session.idle` | `ctx.isIdle()`/session idle signals | `session_end` reason `idle` |
| `compaction.before` | `PreCompact` | `PreCompact` | before `session.compacted` unavailable | `session_before_compact` | `before_compaction` |
| `compaction.after` | `PostCompact` | `PostCompact` | `session.compacted` | `session_compact` | `after_compaction` |
| `subagent.start` | `SubagentStart` | `SubagentStart`, `TaskCreated` | no direct generic hook | fork/session events | `subagent_spawned` |
| `subagent.end` | `SubagentStop` | `SubagentStop`, `TaskCompleted` | no direct generic hook | session shutdown/switch | `subagent_ended` |

## Token Counting

Token accounting is not "all hooks". It is only counted from completed model-response or official usage surfaces:

- Codex: OTel `codex.sse_event` where the stream event is `response.completed`.
- Claude Code: OTel metrics/logs, especially token/cost usage and `llm_request` attributes.
- OpenCode: `opencode stats` first; per-message plugin usage only after raw fixtures prove it.
- Pi: assistant `message_end` usage or provider response usage when present.
- OpenClaw: `model_call_ended` / `llm_output` usage when present.

Lifecycle hooks still matter for the game UI, but they must not fabricate usage.

## Official Sources Checked

- OpenAI Agents SDK overview: https://developers.openai.com/api/docs/guides/agents
- OpenAI tool calling flow: https://developers.openai.com/api/docs/guides/function-calling
- OpenAI reasoning summaries: https://developers.openai.com/api/docs/guides/reasoning
- Codex manual hooks and OTel sections, fetched with the OpenAI docs helper on 2026-07-01.
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Claude Code monitoring/OTel: https://code.claude.com/docs/en/monitoring-usage
- OpenCode plugins: https://opencode.ai/docs/plugins/
- Pi extensions: https://pi.dev/docs/latest/extensions
- OpenClaw automation hooks: https://docs.openclaw.ai/automation/hooks
- OpenClaw plugin hooks: https://docs.openclaw.ai/plugins/hooks
