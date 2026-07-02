#!/usr/bin/env bash
#
# Cultivagent OpenClaw plugin installer.
#
# Env overrides:
#   CULTIVAGENT_HOME      config root (default: ~/.cultivagent)
#   CULTIVAGENT_ENDPOINT  server URL
#   CULTIVAGENT_TOKEN     bearer token
#   CULTIVAGENT_USERNAME  optional username label (default: machine name)

set -euo pipefail

CV_HOME="${CULTIVAGENT_HOME:-$HOME/.cultivagent}"
CONFIG_FILE="$CV_HOME/config.json"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_ID="cultivagent"

info() { printf '==> %s\n' "$*"; }
err() { printf 'xx  %s\n' "$*" >&2; }

write_config() {
  node -e '
    const fs = require("node:fs");
    const [path, endpoint, token, username] = process.argv.slice(1);
    const config = { endpoint, token };
    if (username) config.username = username;
    fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  ' "$CONFIG_FILE" "$1" "$2" "${3:-}"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
}

for cmd in node openclaw; do
  command -v "$cmd" >/dev/null 2>&1 || { err "$cmd not found"; exit 1; }
done

mkdir -p "$CV_HOME"
if [ ! -f "$CONFIG_FILE" ] || [ -n "${CULTIVAGENT_ENDPOINT:-}" ] || [ -n "${CULTIVAGENT_TOKEN:-}" ]; then
  write_config "${CULTIVAGENT_ENDPOINT:-http://127.0.0.1:3737}" "${CULTIVAGENT_TOKEN:-}" "${CULTIVAGENT_USERNAME:-}"
  info "wrote $CONFIG_FILE"
else
  info "using existing $CONFIG_FILE"
fi

info "installing OpenClaw plugin from $PLUGIN_DIR"
openclaw plugins install "$PLUGIN_DIR" --link >/dev/null 2>&1 || {
  info "plugin already installed or linked; continuing"
}

openclaw plugins enable "$PLUGIN_ID" >/dev/null
openclaw config patch --stdin >/dev/null <<'JSON'
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

info "enabled $PLUGIN_ID"
openclaw plugins inspect "$PLUGIN_ID" --json >/dev/null
info "Done. Restart OpenClaw Gateway to activate hooks."
