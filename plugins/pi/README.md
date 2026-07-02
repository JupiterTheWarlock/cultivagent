# Cultivagent plugin for Pi

Forwards Pi coding-agent events to a self-hosted [Cultivagent](../..) server (`POST /ingest`). Pure passive ingest — no MCP, no agent-callable interface.

Pi exposes rich lifecycle events including `message_end` with `message.usage` (input/output/total tokens, cost). Where the payload carries usage, the plugin forwards it; otherwise the event is recorded as a lifecycle signal only.

## Install

### One-line installer

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/pi/install.sh)
```

Writes `~/.cultivagent/config.json`, clones the repo, and adds a `pi()` shell wrapper to your rc so `pi` launches with `-e <extension>` automatically. Re-running is safe (marker-delimited block is replaced). Set `CULTIVAGENT_PI_SKIP_WRAPPER=1` to skip the wrapper.

> Windows: run under **git-bash**.

### Manual setup

1. Write `~/.cultivagent/config.json`:

   ```json
   { "endpoint": "https://your-server.example.com", "token": "<32-hex>" }
   ```

2. Load the extension (pick one):

   ```bash
   # one-shot
   pi -e <repo>/plugins/pi/cultivagent.js
   ```

   ```json
   // or via package.json
   { "pi": { "extensions": ["<repo>/plugins/pi/cultivagent.js"] } }
   ```

## Config priority

env (`CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN`) > `~/.cultivagent/config.json` > `http://127.0.0.1:3737` (no token).
`username` defaults to the machine hostname; override it with `CULTIVAGENT_USERNAME` or `~/.cultivagent/config.json.username`.

## Events forwarded

28 Pi events (session lifecycle, message start/update/end, tool calls, model select, …). Token usage is extracted from `event.message.usage` when present. Provider-specific `usage` field shapes should be verified with a fixture before treating totals as authoritative.
