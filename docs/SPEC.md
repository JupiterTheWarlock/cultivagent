# Cultivagent Spec

## Goal

Cultivagent collects local coding-agent lifecycle events and model usage into one self-hosted dashboard.

## Backend Choice

The MVP is self-hosted:

- One Node.js process.
- SQLite database.
- Localhost by default.
- Optional shared token for remote posts.

Cloudflare remains a later backend option for public plugin distribution and hosted dashboards.

## Normalized Event

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

`event_type` stays raw. The semantic loop translation is stored in `meta.loop_event`, `meta.agent_status`, and `meta.event_role`.

## Counting Rule

Only count completed model requests or official aggregate usage metrics.

Do not count every lifecycle hook.

## Fixture Gate

Adapters may ship before token usage is complete. Token accounting for each agent becomes authoritative only after redacted raw fixtures prove the payload fields.
