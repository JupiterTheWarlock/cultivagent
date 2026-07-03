# Cultivagent plugin for Codex

Sends Codex hook events (SessionStart / UserPromptSubmit / Stop / PreCompact) and Codex OTel usage records to a self-hosted [Cultivagent](../..) server for token & usage monitoring.

Codex provides no `SessionEnd` hook (upstream rejected — threads are always resumable), so the plugin forwards the four available lifecycle events. Token accounting comes from Codex's built-in OTel log export: `codex.sse_event` records include token counts on `response.completed`.

Cultivagent is a **pure passive ingest sink** — this plugin only forwards hook metadata to `POST /ingest` and configures Codex OTel logs to `POST /otel/v1/logs`. No MCP, no agent-callable interface, **no shell wrapper**.

## Install

### One-line installer

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)
```

The installer checks dependencies, writes `~/.cultivagent/config.json`, clones the repo, **copies the plugin to `~/.cultivagent/codex-marketplace/codex` and renders `__CULTIVAGENT_PLUGIN_ROOT__` into an absolute path** (Codex 0.130 does not inject a plugin-root env var into hook subprocesses), registers the marketplace, enables the plugin in `~/.codex/config.toml`, and configures `[otel]` to send usage logs to Cultivagent. Re-running is safe.

> Windows: run under **git-bash**.

### Manual setup

1. Have a Cultivagent server reachable.

2. Write `~/.cultivagent/config.json`:

   ```json
   { "endpoint": "https://your-server.example.com", "token": "<32-hex>" }
   ```

3. Copy the plugin and render the placeholder (Codex 0.130 needs an absolute path):

   ```bash
   REPO=/path/to/cultivagent
   DEST=~/.cultivagent/codex-marketplace/codex
   mkdir -p ~/.cultivagent/codex-marketplace
   cp -r "$REPO/plugins/codex" "$DEST"
   sed -i.bak "s|__CULTIVAGENT_PLUGIN_ROOT__|$DEST|g" "$DEST/hooks/hooks.json" && rm -f "$DEST/hooks/hooks.json.bak"
   ```

4. Write `~/.cultivagent/codex-marketplace/.claude-plugin/marketplace.json`:

   ```json
   { "name": "cultivagent-plugins-local", "plugins": [{ "name": "codex", "source": "./codex" }] }
   ```

5. Register and install:

   ```bash
   codex plugin marketplace add ~/.cultivagent/codex-marketplace
   codex plugin install codex@cultivagent-plugins-local
   ```

6. Enable the hook feature in `~/.codex/config.toml`:

   ```toml
   [features]
   plugin_hooks = true

   [plugins."codex@cultivagent-plugins-local"]
   enabled = true
   ```

7. Configure Codex OTel usage export:

   ```toml
   [otel]
   environment = "cultivagent"
   exporter = { otlp-http = { endpoint = "https://your-server.example.com/otel/v1/logs", protocol = "json", headers = { "Authorization" = "Bearer <token>" } } }
   ```

## Config priority

env (`CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN`) > `~/.cultivagent/config.json` > `http://127.0.0.1:3737` (no token).
`username` defaults to the machine hostname; override it with `CULTIVAGENT_USERNAME` or `~/.cultivagent/config.json.username`.

## Hook coverage

| Event | matcher | argv fallback |
|---|---|---|
| SessionStart | `clear\|startup\|resume` | `session_start` |
| UserPromptSubmit | `*` | `user_prompt_submit` |
| Stop | `*` | `stop` |
| PreCompact | `*` | `pre_compact` |

The actual Codex hook name from the stdin payload is used as `event_type`; the argv value is only a fallback.

## Usage Accounting

Hook events are lifecycle signals, not the source of truth for token counts. Codex OTel logs are the live usage source; Cultivagent counts OTel `response.completed` records with token fields as `model_response` usage events. Manual session backfill:

```bash
node ~/.cultivagent/codex-marketplace/codex/scripts/session-collector.mjs --lookback-minutes 120 --batch-size 10
```
