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

### Cloudflare Worker + D1 deployment

The Worker runtime is API-compatible with the Node service and stores data in D1. It uses the same auth token and serves the same dashboard as static Worker assets.

```bash
npm install
npx wrangler d1 create cultivagent
```

Copy the generated `database_id` into `wrangler.jsonc`, then run:

```bash
npm run worker:migrate:remote
npx wrangler secret put CULTIVAGENT_TOKEN
npm run worker:deploy
```

For a custom domain, add a route in `wrangler.jsonc`, for example:

```jsonc
"routes": [
  { "pattern": "cv.example.com/*", "zone_name": "example.com" }
]
```

`npm run worker:deploy` runs `worker:prepare` first, which copies `src/dashboard.html` to `worker/public/index.html` for Workers static assets. The npm scripts use `npx wrangler`, so a global Wrangler install is not required.

## 2. Install an agent plugin

Each agent has a one-line installer that writes `~/.cultivagent/config.json` (endpoint + token + optional username), clones the repo, and registers the plugin. Re-running is safe (idempotent). Non-interactive when piped (`curl | bash`) — uses env / existing config / defaults.

> Windows: run the installers under **git-bash** (the bash from Git for Windows).

For an existing hosted server, set the shared config once before running agent installers:

```bash
export CULTIVAGENT_ENDPOINT=https://cv.jthewl.cc
export CULTIVAGENT_TOKEN=<token from the hosted server>
export CULTIVAGENT_USERNAME=<machine label>
```

Both Claude Code and Codex installers read those env vars and write the same `~/.cultivagent/config.json`. If the file already exists, rerunning installers keeps the existing config unless you reconfigure interactively.

### Claude Code

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/claude-code/setup-helper/install.sh)
```

Manual from the repo root: `claude plugin marketplace add ./plugins` → `claude plugin install claude-code@cultivagent-plugins-local`. The Stop hook runs the session collector to report JSONL usage, so the installer does not write OTel variables into `~/.claude/settings.json` by default. Re-run the installer after upgrades to sync the installed plugin copy under `~/.cultivagent/repo`. See [plugins/claude-code/README.md](../plugins/claude-code/README.md).

### Codex

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)
```

Codex 0.130 does not inject a plugin-root env var, so the installer copies the plugin and renders `__CULTIVAGENT_PLUGIN_ROOT__` into an absolute path. The Stop hook runs the session collector to report usage, so `[otel]` is not written by default. Re-run the installer after upgrades; it removes and re-adds `codex@cultivagent-plugins-local` so Codex's versioned plugin cache is refreshed. See [plugins/codex/README.md](../plugins/codex/README.md).

After install, restart the agent app/CLI so hook changes are loaded.

Quick checks after a Codex install:

```bash
codex plugin add codex@cultivagent-plugins-local --json
node ~/.cultivagent/codex-marketplace/codex/scripts/session-collector.mjs --lookback-minutes 10 --include-incomplete --dry-run --json
```

The installed Codex shape should match `plugins/codex/README.md`: one Stop hook command (`hook.mjs stop`) and the collector launched inside `hook.mjs` with `--delay-ms 3000 --include-incomplete`.

Claude Code check:

```bash
node ~/.cultivagent/repo/plugins/claude-code/scripts/status.mjs
claude plugin list | grep cultivagent
```

If a Claude Code local marketplace plugin changed without a version bump, refresh the installed cache:

```bash
claude plugin marketplace update cultivagent-plugins-local
claude plugin uninstall claude-code@cultivagent-plugins-local
claude plugin install claude-code@cultivagent-plugins-local
```

### OpenCode

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/opencode/install.sh)
```

Appends the plugin path to `~/.config/opencode/opencode.json`. See [plugins/opencode/README.md](../plugins/opencode/README.md).

OpenCode usage backfill is available with:

```bash
node ~/.cultivagent/repo/plugins/opencode/session-collector.mjs
```

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
