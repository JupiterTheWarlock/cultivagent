# Cultivagent 产品规格

> [English](./SPEC.md) · [中文](./SPEC.zh.md)

## 目标

Cultivagent 把本地编程 agent 的生命周期事件和模型用量收集到一个自托管面板。

## 后端选择

MVP 为自托管：

- 一个 Node.js 进程。
- SQLite 数据库。
- 默认 localhost。
- 可选共享 token，用于远程上报。

Cloudflare 作为后续公网分发与托管面板的后端选项保留。

## 规范化事件

```json
{
  "source_agent": "codex|claude-code|opencode|openclaw|pi",
  "source_surface": "hook|otel|plugin|extension|cli-smoke",
  "event_type": "raw vendor hook name",
  "occurred_at": "ISO-8601",
  "username": "machine name by default; configurable per machine",
  "host_id": "redacted host key",
  "workspace_id": "redacted workspace key",
  "session_id": "source session id",
  "turn_id": "source prompt/turn id",
  "model": "model id",
  "provider": "provider id",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "total_tokens": 0,
    "cost_usd": null
  }
}
```

`event_type` 保持原始值。语义 loop 翻译存在 `meta.loop_event`、`meta.agent_status` 和 `meta.event_role`。

## 计数规则

只计数已完成的模型请求或官方聚合 usage 指标。

不要把每个生命周期 hook 都计入。

## 游戏 UI

Dyson 游戏 UI 需求见 [DYSON_GAME_UI.md](./DYSON_GAME_UI.zh.md)。

## Fixture 门槛

Adapter 可能在 token usage 完成前发布。各 agent 的 token 计数只有在以脱敏原始 fixture 证明 payload 字段后才具权威性。
