# Cultivagent plugin for Codex

Sends Codex hook events (SessionStart / UserPromptSubmit / Stop / PreCompact) and Codex session usage records to a self-hosted [Cultivagent](../..) server for token & usage monitoring.

Codex provides no `SessionEnd` hook (upstream rejected — threads are always resumable), so the plugin forwards the four available lifecycle events. Current Codex `exec` sessions can complete without running plugin hooks, so the installer also enables a local session collector that reads `~/.codex/sessions/**/*.jsonl` and forwards only token-count metadata from `token_count` events.

Cultivagent is a **pure passive ingest sink** — this plugin only forwards hook/session metadata to `POST /ingest`. No MCP, no agent-callable interface, **no shell wrapper** (hook scripts and the collector read `~/.cultivagent/config.json` directly, so there is no need to inject env into the Codex process).

## Install

### One-line installer

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)
```

The installer checks dependencies, writes `~/.cultivagent/config.json`, clones the repo, **copies the plugin to `~/.cultivagent/codex-marketplace/codex` and renders `__CULTIVAGENT_PLUGIN_ROOT__` into an absolute path** (Codex 0.130 does not inject a plugin-root env var into hook subprocesses), registers the marketplace, enables the plugin in `~/.codex/config.toml`, installs it, and enables the `cultivagent-codex-session-collector.timer` user systemd timer on Linux. Re-running is safe.

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

7. Run the session collector periodically, or install it as a user systemd timer:

   ```bash
   node ~/.cultivagent/codex-marketplace/codex/scripts/session-collector.mjs
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

## Session Collector

Hook events are lifecycle signals, not the source of truth for token counts. The session collector scans Codex rollout JSONL files and emits one `model_response` event per `token_count` record. It does not store prompt text, assistant text, command text, file contents, or tool output.

```bash
node ~/.cultivagent/codex-marketplace/codex/scripts/session-collector.mjs --lookback-minutes 10080
```
