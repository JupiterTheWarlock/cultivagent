# Cultivagent

Cultivagent is a small self-hosted, **pure passive** monitor for coding-agent hooks, CLI smoke checks, and token rollups.

- Node.js HTTP service (built-in `node:sqlite`) or Cloudflare Worker + D1.
- In-memory TTL event pool for recent hook events.
- Daily usage rollups.
- Dashboard at `http://127.0.0.1:3737`.
- Auth (token + login-page cookie) for remote / HTTPS deployment.
- Plugins for Claude Code, Codex, OpenCode, Pi, OpenClaw — install via one-line installer or local marketplace.

No prompt text, command text, file contents, or tool output is stored by default. **No MCP, no agent-callable interface** — agents only `POST` hook events to `/ingest`.

## Hook Coverage

Cultivagent ingests any hook / plugin / extension / OTel event sent to `/ingest` or `/otel/*`. Each installed adapter forwards every event it observes; raw vendor hook names are translated into canonical loop events (`input.received`, `model.request.start`, `tool.before`, `tool.end`, `agent.end`, `agent.idle`). Token totals come only from events that include usage fields (model response events, OTel usage metrics, verified adapter payloads). Plain lifecycle hooks show in the request log but do not add fake token usage.

See [docs/LOOP_EVENTS.md](docs/LOOP_EVENTS.md).

## Quick Start

Requires Node.js 24+.

```bash
npm start
```

Open http://127.0.0.1:3737

Run checks:

```bash
npm run smoke
npm run cli-smoke
```

## Install Agent Plugins

One-line installers per agent — write `~/.cultivagent/config.json`, clone the repo, register the plugin. Full steps in [docs/INSTALL.md](docs/INSTALL.md).

| Agent | Installer |
|---|---|
| Claude Code | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/claude-code/setup-helper/install.sh)` |
| Codex | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)` |
| OpenCode | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/opencode/install.sh)` |
| Pi | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/pi/install.sh)` |
| OpenClaw | native plugin entry — [plugins/openclaw/README.md](plugins/openclaw/README.md) |

## Auth

Local default (`http://127.0.0.1:3737`) needs no token. For LAN / public deployment:

```bash
export CULTIVAGENT_TOKEN=$(node bin/cultivagent.mjs token)
CULTIVAGENT_TOKEN=$CULTIVAGENT_TOKEN npm start
```

With a token set, every path except `GET /api/health` requires auth (`Authorization: Bearer <token>`, `x-cultivagent-token`, or the `cultivagent_token` cookie set by the dashboard login page).

## Cloudflare Worker

The Worker runtime serves the same dashboard and ingest/API surface using D1 for storage:

```bash
npx wrangler d1 create cultivagent
# copy the database_id into wrangler.jsonc
npm run worker:migrate:remote
npx wrangler secret put CULTIVAGENT_TOKEN
npm run worker:deploy
```

`npm run worker:prepare` copies `src/dashboard.html` into the Worker static assets directory before `wrangler dev` or `wrangler deploy`.

## API

```bash
curl http://127.0.0.1:3737/api/health

curl -X POST http://127.0.0.1:3737/ingest \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CULTIVAGENT_TOKEN" \
  -d '{"source_agent":"codex","event_type":"model_response","usage":{"input_tokens":10,"output_tokens":3}}'
```

Endpoints: `POST /ingest`, `POST /otel/v1/logs`, `POST /otel/v1/metrics`, `GET /api/events`, `GET /api/daily`, `GET /api/agents`, `GET /api/pool`, `GET /api/usage/*`, `POST /api/login`, `POST /api/logout`.

## Docs

- [Install guide](docs/INSTALL.md)
- [Plugin spec](docs/PLUGIN_SPEC.md)
- [Loop events](docs/LOOP_EVENTS.md)
- [Ubuntu / systemd](docs/UBUNTU.md)

## Status

Implemented:

- Local SQLite service + dashboard.
- Auth: Bearer / `x-cultivagent-token` / login-page cookie (timing-safe) + `cultivagent token` generator.
- `~/.cultivagent/config.json` shared config (env > config > default), including optional per-machine `username`.
- Event normalization and dedupe; daily token rollups; recent event TTL pool.
- Claude Code plugin (local marketplace + hooks + install.sh + `< 2.0` legacy fallback).
- Codex plugin (copy + render-on-install, `config.toml` wiring, install.sh; no wrapper needed).
- OpenCode / Pi plugins (adapter + install.sh).
- OpenClaw native plugin entry (stub-grade).
- CLI smoke events for Codex, Claude Code, OpenCode.

Usage-source notes:

- Claude Code: the Stop hook runs a local session collector to report JSONL usage; native OTel export is optional.
- Codex: OTel is the live source; the local session collector backfills Codex session JSONL usage when needed.
- OpenCode: plugin events are live; `plugins/opencode/session-collector.mjs` can backfill `opencode.db` assistant-message usage when present.
- OpenClaw: native plugin usage is counted from plugin payload usage fields, including nested `usageState` / `agentMeta` usage.
