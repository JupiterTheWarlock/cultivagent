# Cultivagent Install Notes

These examples assume the service is running at:

```text
http://127.0.0.1:3737
```

Set this for all adapters:

```bash
export CULTIVAGENT_ENDPOINT=http://127.0.0.1:3737/ingest
```

If the server uses auth:

```bash
export CULTIVAGENT_TOKEN=change-me
```

## Codex

Codex hooks are configured through `hooks.json` or inline `[hooks]` tables. Use the hook script for lifecycle/status events. This template wires every Codex hook event documented in the current Codex manual.

Generate `~/.codex/hooks.json`:

```bash
node D:/Users/JtheWL/cultivagent/scripts/generate-hook-config.mjs codex D:/Users/JtheWL/cultivagent > ~/.codex/hooks.json
```

For token totals, prefer Codex OTel export to `POST /otel/v1/logs`. Hook events are status signals, not the source of truth for token accounting.

## Claude Code

Claude Code supports command and HTTP hooks. The easiest local hook is a command hook. Generate settings JSON:

```bash
node D:/Users/JtheWL/cultivagent/scripts/generate-hook-config.mjs claude D:/Users/JtheWL/cultivagent > ~/.claude/settings.json
```

For token and cost totals, configure Claude Code OpenTelemetry metrics/logs to the service:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:3737/otel/v1/metrics
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:3737/otel/v1/logs
```

## OpenCode

Copy or reference the plugin file:

```text
adapters/opencode/cultivagent.js
```

Global or project `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./adapters/opencode/cultivagent.js"]
}
```

For token totals, the first verified source is:

```bash
opencode stats --days 1 --models 10
```

Per-message plugin token fields must be fixture-captured before being treated as authoritative.

## Pi

Load the extension directly while testing:

```bash
pi -e D:/Users/JtheWL/cultivagent/adapters/pi/cultivagent.js
```

Or create a Pi package that declares:

```json
{
  "pi": {
    "extensions": ["./adapters/pi/cultivagent.js"]
  }
}
```

Pi examples show `message_end` usage on assistant messages. Provider coverage should be verified with fixtures.

## OpenClaw

Use the native plugin surface for runtime lifecycle and model usage events:

```text
adapters/openclaw/index.ts
```

OpenClaw internal `HOOK.md` scripts are better for coarse command/Gateway events. Typed native plugin hooks are the right target for token/usage observation.

## Ubuntu Deployment

```bash
git clone https://github.com/JupiterTheWarlock/cultivagent.git
cd cultivagent
npm start
```

For a long-running service, put it behind systemd, Caddy, Nginx, or Cloudflare Tunnel.
