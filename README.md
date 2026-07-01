# Cultivagent

Cultivagent is a small self-hosted monitor for coding-agent hooks, CLI smoke checks, and token rollups.

It starts local-first:

- Node.js HTTP service.
- SQLite storage through Node's built-in `node:sqlite`.
- In-memory TTL event pool for recent hook events.
- Daily usage rollups.
- Minimal dashboard at `http://127.0.0.1:3737`.
- Adapter stubs for Codex, Claude Code, OpenCode, OpenClaw, and Pi.

No prompt text, command text, file contents, or tool output is stored by default.

## Hook Coverage

Cultivagent can ingest any hook, plugin, extension, or OTel event that is configured to send data to `/ingest` or `/otel/*`.

It does not magically monitor every hook in every agent until that agent's hook/plugin/extension is installed and trusted.

Token totals are counted only from events that include usage fields, such as model response events, official OTel usage metrics, or verified adapter payloads. Plain lifecycle hooks are shown in the request log but do not add fake token usage.

## Quick Start

Requires Node.js 24+.

```bash
npm start
```

Open:

```text
http://127.0.0.1:3737
```

Run checks:

```bash
npm run smoke
npm run cli-smoke
```

`cli-smoke` detects `codex`, `claude`, and `opencode`, then sends one status event for each CLI to the running service.

## API

```bash
curl http://127.0.0.1:3737/api/health

curl -X POST http://127.0.0.1:3737/ingest \
  -H 'content-type: application/json' \
  -d '{"source_agent":"codex","event_type":"model_response","usage":{"input_tokens":10,"output_tokens":3}}'
```

Useful endpoints:

- `POST /ingest`
- `POST /otel/v1/logs`
- `POST /otel/v1/metrics`
- `GET /api/events`
- `GET /api/daily`
- `GET /api/agents`
- `GET /api/pool`

## Auth

For a LAN or public deployment, set a shared token:

```bash
CULTIVAGENT_TOKEN=change-me npm start
```

Clients then send:

```text
Authorization: Bearer change-me
```

## Install Guides

See [docs/INSTALL.md](docs/INSTALL.md).

For Ubuntu/systemd, see [docs/UBUNTU.md](docs/UBUNTU.md).

## Status

Implemented:

- Local SQLite service.
- Dashboard.
- Event normalization and dedupe.
- Daily token rollups.
- Recent event TTL pool.
- Codex hook script.
- Claude Code hook script.
- OpenCode plugin adapter.
- Pi extension adapter.
- OpenClaw native plugin sketch.
- CLI smoke events for Codex, Claude Code, and OpenCode.

Still intentionally fixture-gated:

- OpenCode per-message token usage.
- OpenClaw provider-specific `usage` fields.
- Pi provider-specific assistant `message_end.usage`.
- Codex hook/session correlation beyond OTel.

Those are not guessed. Capture raw redacted fixtures before marking adapter token accounting complete.
