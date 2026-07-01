# Cultivagent plugin for OpenClaw

Forwards OpenClaw lifecycle and model-usage events to a self-hosted [Cultivagent](../..) server (`POST /ingest`). Pure passive ingest — no MCP, no agent-callable interface.

This is an OpenClaw **native plugin entry** (`definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`). It registers 32 OpenClaw hooks (`session_start`/`session_end`, `before_compaction`/`after_compaction`, `model_call_started`/`model_call_ended`, `llm_input`/`llm_output`, tool calls, gateway start/stop, …).

## Status

Stub-grade. The entry is complete (all hooks wired, usage forwarded from `event.usage`), but:

- it is TypeScript and needs to be built (or loaded by an OpenClaw runtime that accepts `.ts`) before registration;
- the OpenClaw plugin manifest / registration flow is not bundled here — follow your OpenClaw version's plugin install docs to register this entry;
- provider-specific `usage` field shapes should be verified with a fixture before treating totals as authoritative.

## Config

env (`CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN`) > `~/.cultivagent/config.json` > `http://127.0.0.1:3737` (no token). Same config file as all other Cultivagent plugins.

## Manual setup

1. Write `~/.cultivagent/config.json`:

   ```json
   { "endpoint": "https://your-server.example.com", "token": "<32-hex>" }
   ```

2. Build (if your OpenClaw runtime needs compiled JS):

   ```bash
   tsc -p plugins/openclaw
   ```

3. Register the entry with OpenClaw per its plugin install documentation.
