# Cultivagent plugin for Claude Code

Sends Claude Code hook events (SessionStart / UserPromptSubmit / MessageDisplay / PreToolUse / PostToolUse / PostToolUseFailure / PostToolBatch / Stop / PreCompact / SessionEnd) to a self-hosted [Cultivagent](../..) server for token & usage monitoring.

Cultivagent is a **pure passive ingest sink** — this plugin forwards hook events to `POST /ingest`, configures Claude Code OTel usage export to `/otel/v1/metrics` and `/otel/v1/logs`, and runs a JSONL session collector on `Stop` to backfill usage when live telemetry misses it. It does not expose any MCP tool or agent-callable interface.

## Install

### One-line installer

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/claude-code/setup-helper/install.sh)
```

The installer checks dependencies, writes `~/.cultivagent/config.json` (endpoint + token + optional username), clones the repo to `~/.cultivagent/repo`, registers the local marketplace, runs `claude plugin install`, and enables Claude Code OTel usage export in `~/.claude/settings.json`. Re-running is safe (idempotent) and is the upgrade path for syncing the installed plugin copy. Non-interactive when piped (`curl | bash`) — uses env / existing config / defaults.

> Windows: run under **git-bash** (the bundled bash from Git for Windows). The installer targets bash — Linux for production, git-bash for dev/test.

### Manual setup

1. Have a Cultivagent server reachable. Default `http://127.0.0.1:3737` (local, no auth); a remote server needs a token.

2. Write `~/.cultivagent/config.json`:

   ```json
   { "endpoint": "https://your-server.example.com", "token": "<32-hex>" }
   ```

3. From the repo root:

   ```bash
   claude plugin marketplace add "$(pwd)/plugins"
   claude plugin install claude-code@cultivagent-plugins-local
   claude plugin enable claude-code@cultivagent-plugins-local
   ```

4. Restart Claude Code.

## Config priority

hook scripts resolve endpoint/token as: env (`CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN`) > `~/.cultivagent/config.json` > `http://127.0.0.1:3737` (no token). `username` defaults to the machine hostname; override it with `CULTIVAGENT_USERNAME` or `~/.cultivagent/config.json.username`.

## Status

```
/cultivagent-status
```

## Hook coverage

| Event | argv fallback |
|---|---|
| SessionStart | `session_start` |
| UserPromptSubmit | `user_prompt_submit` |
| MessageDisplay | `message_display` |
| PreToolUse | `pre_tool_use` |
| PostToolUse | `post_tool_use` |
| PostToolUseFailure | `post_tool_use_failure` |
| PostToolBatch | `post_tool_batch` |
| Stop | `stop` |
| PreCompact | `pre_compact` |
| SessionEnd | `session_end` |

The actual Claude hook name from the stdin payload is used as `event_type`; the argv value is only a fallback when the payload carries no hook name.

## Usage accounting

Lifecycle hooks (`UserPromptSubmit`, `MessageDisplay`, `Stop`, ...) appear in request logs but carry zero tokens. Usage totals come from Claude OTel records and from the Stop-hook session collector. Manual backfill:

```bash
node ~/.cultivagent/repo/plugins/claude-code/scripts/session-collector.mjs --lookback-minutes 120 --batch-size 10
```
