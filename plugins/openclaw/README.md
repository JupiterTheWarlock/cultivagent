# Cultivagent plugin for OpenClaw

Forwards OpenClaw lifecycle and model-usage events to a self-hosted [Cultivagent](../..) server (`POST /ingest`). Pure passive ingest — no MCP, no agent-callable interface.

This is an OpenClaw **native plugin entry** (`definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`). It registers 32 OpenClaw hooks (`session_start`/`session_end`, `before_compaction`/`after_compaction`, `model_call_started`/`model_call_ended`, `llm_input`/`llm_output`, tool calls, gateway start/stop, …).

## Install

```bash
CULTIVAGENT_ENDPOINT=https://your-server.example.com \
CULTIVAGENT_TOKEN=<token> \
bash plugins/openclaw/setup-helper/install.sh
```

The installer writes the shared `~/.cultivagent/config.json`, links this plugin
directory with `openclaw plugins install --link`, enables `plugins.entries.cultivagent`,
and allows conversation-observation hooks so `llm_output` usage metadata can be
observed. The plugin forwards metadata and usage counters, including nested
OpenClaw usage state; it does not forward raw prompts or model output.

## Config

env (`CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN`) > `~/.cultivagent/config.json` > `http://127.0.0.1:3737` (no token). Same config file as all other Cultivagent plugins.

## Manual setup

1. Write `~/.cultivagent/config.json`:

   ```json
   { "endpoint": "https://your-server.example.com", "token": "<32-hex>" }
   ```

2. Install and enable the plugin:

   ```bash
   openclaw plugins install plugins/openclaw --link
   openclaw plugins enable cultivagent
   openclaw config patch --stdin <<'JSON'
   {
     "plugins": {
       "entries": {
         "cultivagent": {
           "enabled": true,
           "hooks": {
             "allowConversationAccess": true,
             "timeoutMs": 5000
           },
           "config": {}
         }
       }
     }
   }
   JSON
   ```

3. Restart the OpenClaw Gateway.
