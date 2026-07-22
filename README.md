# Cultivagent

> A self-hosted, privacy-first monitor for AI coding agents — one dashboard for every hook, every token, every agent.

[English](./README.md) · [中文](./README.zh.md)

---

Cultivagent is a **pure passive** ingest sink for coding-agent hooks and token usage. Point your agents' hooks at it, and it collects, normalizes, and visualizes everything they do — across Claude Code, Codex, OpenCode, Pi, OpenClaw, and Locus — in a single self-hosted dashboard.

No prompts, commands, file contents, or tool outputs are ever stored. **No MCP, no agent-callable interface** — agents can only `POST` events to `/ingest`. They cannot read, query, or manipulate the monitor, so your usage data stays honest.

## Why Cultivagent

- **One pane of glass for every agent.** Stop hopping between vendor dashboards. Every agent's lifecycle, tokens, and cost roll up into one timeline.
- **Privacy by design.** The monitor stores metadata and token counts — never your code or conversations.
- **Agents can't cheat.** Because it's a write-only sink, no agent can read or alter what's recorded about it.
- **Self-hosted, you own it.** Runs on Node.js + SQLite locally, or on a Cloudflare Worker + D1 for a hosted dashboard with auth.
- **A dashboard that's actually fun to look at.** Token usage drives a live **Dyson sphere** visualization — agents are planets, tokens become Dyson clouds, milestones condense into structure. See [Dyson Game UI](./docs/DYSON_GAME_UI.md).

## Features

- **Multi-agent ingest** — hooks from Claude Code, Codex, OpenCode, Pi, OpenClaw; read-only collector for Locus.
- **Canonical loop events** — raw vendor hook names are translated into a consistent loop model (`input.received`, `model.request.start`, `tool.before`, `agent.end`, …). See [Loop Events](./docs/LOOP_EVENTS.md).
- **Honest token accounting** — counted only from completed model responses or official usage surfaces, never fabricated from lifecycle hooks.
- **Daily rollups + recent-event pool** — daily token totals and a TTL pool of recent events for live inspection.
- **Gamified Dyson view** at `/dyson` — a Three.js star system where today's activity is rendered in real time.
- **Auth for remote deployment** — Bearer token, `x-cultivagent-token` header, or a dashboard login cookie (timing-safe, 30-day, HTTPS).
- **Shared agent config** — one `~/.cultivagent/config.json` powers every plugin on a machine.

## Quick Start

Requires Node.js 24+.

```bash
git clone https://github.com/JupiterTheWarlock/cultivagent.git
cd cultivagent
npm start
```

Open http://127.0.0.1:3737 — the dashboard. The Dyson view is at http://127.0.0.1:3737/dyson.

Run the built-in checks:

```bash
npm run smoke      # server endpoint smoke test
npm run cli-smoke  # emit CLI events from each adapter
```

Full setup (remote auth, Cloudflare Worker, systemd) → **[Install Guide](./docs/INSTALL.md)**.

## Connect an Agent

Each agent has a one-line installer that writes `~/.cultivagent/config.json`, clones the repo, and registers the plugin. Re-running is safe.

> Windows: run installers under **git-bash** (Git for Windows).

| Agent | One-line install | Docs |
|---|---|---|
| Claude Code | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/claude-code/setup-helper/install.sh)` | [claude-code](./plugins/claude-code/README.md) |
| Codex | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)` | [codex](./plugins/codex/README.md) |
| OpenCode | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/opencode/install.sh)` | [opencode](./plugins/opencode/README.md) |
| Pi | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/pi/install.sh)` | [pi](./plugins/pi/README.md) |
| OpenClaw | native plugin entry (build required) | [openclaw](./plugins/openclaw/README.md) |
| Locus | read-only session collector | [locus](./plugins/locus/README.md) |

To point all agents at a hosted server first:

```bash
export CULTIVAGENT_ENDPOINT=https://your-host.example.com
export CULTIVAGENT_TOKEN=<token from the server>
export CULTIVAGENT_USERNAME=<machine label>
```

## Deploy

**Local** (default, no auth): `npm start` → http://127.0.0.1:3737

**VPS / LAN** (Node + auth): generate a token and require login.
→ [Ubuntu / systemd guide](./docs/UBUNTU.md)

**Cloudflare Worker + D1**: same dashboard and API, global edge, D1 storage.
→ [Worker deployment in the Install Guide](./docs/INSTALL.md#cloudflare-worker--d1-deployment)

## Documentation

The full docs library lives in [`docs/`](./docs/). Start at the **[docs index](./docs/README.md)**, or jump straight to:

- [Install Guide](./docs/INSTALL.md) — server setup, auth, Cloudflare Worker, agent plugins
- [Loop Events](./docs/LOOP_EVENTS.md) — canonical event model and vendor hook mapping
- [Dyson Game UI](./docs/DYSON_GAME_UI.md) — design spec for the gamified visualization
- [Product Spec](./docs/SPEC.md) — goals, normalized event shape, counting rules
- [Plugin Architecture](./docs/PLUGIN_SPEC.md) — repo layout, auth model, plugin contracts
- [Ubuntu / systemd](./docs/UBUNTU.md) — VPS deployment with reverse proxy

## API

```bash
# health (anonymous, always public)
curl http://127.0.0.1:3737/api/health

# ingest a hook event
curl -X POST http://127.0.0.1:3737/ingest \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CULTIVAGENT_TOKEN" \
  -d '{"source_agent":"codex","event_type":"model_response","usage":{"input_tokens":10,"output_tokens":3}}'
```

Endpoints: `POST /ingest`, `POST /otel/v1/logs`, `POST /otel/v1/metrics`, `GET /api/events`, `GET /api/daily`, `GET /api/agents`, `GET /api/pool`, `GET /api/usage/*`, `GET /api/dyson/state`, `POST /api/login`, `POST /api/logout`.

## License

MIT
