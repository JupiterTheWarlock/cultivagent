# Cultivagent Install

Cultivagent is a **pure passive ingest sink**: agents forward hook events to `POST /ingest`, the server stores them and renders a dashboard. No MCP, no agent-callable interface.

## 1. Run the server

Requires Node.js 24+.

```bash
git clone https://github.com/JupiterTheWarlock/cultivagent.git
cd cultivagent
npm start
```

Dashboard: http://127.0.0.1:3737

### Remote / authenticated deployment

For VPS / Cloudflare, generate a token and require auth:

```bash
export CULTIVAGENT_TOKEN=$(node bin/cultivagent.mjs token)
HOST=0.0.0.0 CULTIVAGENT_TOKEN=$CULTIVAGENT_TOKEN npm start
```

With a token set, every path except `GET /api/health` requires auth. Three forms accepted:

- `Authorization: Bearer <token>` — agent hooks
- `x-cultivagent-token: <token>` — alternate header
- cookie `cultivagent_token` — browser dashboard (visit `/`, enter token on the login page; cookie is HttpOnly/Secure/SameSite=Lax, 30 days)

See [docs/UBUNTU.md](UBUNTU.md) for systemd / reverse-proxy deployment.

## 2. Install an agent plugin

Each agent has a one-line installer that writes `~/.cultivagent/config.json` (endpoint + token + optional username), clones the repo, and registers the plugin. Re-running is safe (idempotent). Non-interactive when piped (`curl | bash`) — uses env / existing config / defaults.

> Windows: run the installers under **git-bash** (the bash from Git for Windows).

### Claude Code

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/claude-code/setup-helper/install.sh)
```

Manual: `claude plugin marketplace add <repo>/plugins` → `claude plugin install claude-code@cultivagent-plugins-local`. See [plugins/claude-code/README.md](../plugins/claude-code/README.md).

### Codex

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)
```

Codex 0.130 does not inject a plugin-root env var, so the installer copies the plugin and renders `__CULTIVAGENT_PLUGIN_ROOT__` into an absolute path. On Linux it also installs `cultivagent-codex-session-collector.timer`, which reads Codex session JSONL token counters so `codex exec` usage is captured even when plugin hooks do not fire. See [plugins/codex/README.md](../plugins/codex/README.md).

### OpenCode

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/opencode/install.sh)
```

Appends the plugin path to `~/.config/opencode/opencode.json`. See [plugins/opencode/README.md](../plugins/opencode/README.md).

### Pi

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/pi/install.sh)
```

Adds a `pi()` shell wrapper (or use `pi -e <file>` / package.json `pi.extensions`). See [plugins/pi/README.md](../plugins/pi/README.md).

### OpenClaw

Native plugin entry (TypeScript, build required). See [plugins/openclaw/README.md](../plugins/openclaw/README.md).

## 3. Config priority

All plugins resolve endpoint/token as: env (`CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN`) > `~/.cultivagent/config.json` > `http://127.0.0.1:3737` (no token).

`username` defaults to the local machine hostname. To override the label for that machine, set `CULTIVAGENT_USERNAME` or add it to the shared config:

```json
{
  "endpoint": "https://cultivagent.example.com",
  "token": "<server token>",
  "username": "workstation"
}
```

## API

```bash
curl http://127.0.0.1:3737/api/health

curl -X POST http://127.0.0.1:3737/ingest \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CULTIVAGENT_TOKEN" \
  -d '{"source_agent":"codex","event_type":"model_response","usage":{"input_tokens":10,"output_tokens":3}}'
```

Endpoints: `POST /ingest`, `POST /otel/v1/logs`, `POST /otel/v1/metrics`, `GET /api/events`, `GET /api/daily`, `GET /api/agents`, `GET /api/pool`, `GET /api/usage/*`, `POST /api/login`, `POST /api/logout`.
