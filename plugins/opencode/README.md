# Cultivagent plugin for OpenCode

Forwards OpenCode events to a self-hosted [Cultivagent](../..) server (`POST /ingest`). Pure passive ingest — no MCP, no agent-callable interface.

## Install

### One-line installer

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/opencode/install.sh)
```

Writes `~/.cultivagent/config.json`, clones the repo, and appends the plugin path to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/home/you/.cultivagent/repo/plugins/opencode/cultivagent.js"]
}
```

Re-running is safe (idempotent dedupe).

> Windows: run under **git-bash**.

### Manual setup

1. Write `~/.cultivagent/config.json`:

   ```json
   { "endpoint": "https://your-server.example.com", "token": "<32-hex>" }
   ```

2. Add to `~/.config/opencode/opencode.json` (global) or your project's `opencode.json`:

   ```json
   { "plugin": ["<repo>/plugins/opencode/cultivagent.js"] }
   ```

3. Restart OpenCode.

## Config priority

env (`CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN`) > `~/.cultivagent/config.json` > `http://127.0.0.1:3737` (no token).
`username` defaults to the machine hostname; override it with `CULTIVAGENT_USERNAME` or `~/.cultivagent/config.json.username`.

## What it forwards

Every OpenCode `event` is sent as one ingest with `source_agent: "opencode"`, `event_type: event.type`. Per-message usage can also be backfilled from the local OpenCode SQLite database when assistant messages contain `tokens`:

```bash
node ~/.cultivagent/repo/plugins/opencode/session-collector.mjs
```
