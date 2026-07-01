#!/usr/bin/env bash
#
# Cultivagent OpenCode plugin installer.
#
# One-liner:
#   bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/opencode/install.sh)
#
# 写 ~/.config/opencode/opencode.json 的 plugin 数组，加入 cultivagent.js 绝对路径。
# 仅依赖 git + node。Targets bash — Linux + git-bash on Windows.

set -euo pipefail

CV_HOME="${CULTIVAGENT_HOME:-$HOME/.cultivagent}"
REPO_URL="${CULTIVAGENT_REPO_URL:-https://github.com/JupiterTheWarlock/cultivagent.git}"
REPO_REF="${CULTIVAGENT_REPO_REF:-${CULTIVAGENT_REPO_BRANCH:-main}}"
REPO_DIR="${CULTIVAGENT_REPO_DIR:-$CV_HOME/repo}"
CONFIG_FILE="$CV_HOME/config.json"
PLUGIN_FILE="$REPO_DIR/plugins/opencode/cultivagent.js"
OPENCODE_CONFIG="${OPENCODE_CONFIG_FILE:-$HOME/.config/opencode/opencode.json}"

if [ -t 1 ]; then
  CYAN=$'\033[0;36m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
fi
info()    { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()    { printf '%s!!%s  %s\n' "$YELLOW" "$RESET" "$*"; }
err()     { printf '%sxx%s  %s\n' "$RED" "$RESET" "$*" >&2; }
ask()     { printf '%s??%s  %s' "$CYAN" "$RESET" "$*"; }
heading() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }

INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Cultivagent OpenCode plugin installer.

Env overrides:
  CULTIVAGENT_HOME / _REPO_DIR / _REPO_URL / _REPO_REF / _BRANCH
  CULTIVAGENT_ENDPOINT / _TOKEN      non-interactive config
  OPENCODE_CONFIG_FILE               opencode.json path (default: ~/.config/opencode/opencode.json)
EOF
    exit 0 ;;
esac

cfg_get() {
  node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]]||''))}catch{}" "$1" "$2" 2>/dev/null
}
write_config() {
  node -e '
    const fs = require("fs");
    const [path, endpoint, token] = process.argv.slice(2);
    fs.writeFileSync(path, JSON.stringify({ endpoint, token }, null, 2) + "\n");
  ' "$CONFIG_FILE" "$1" "$2"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
}

# 1. dependencies
heading 'Step 1/4 — dependencies'
for cmd in git node; do
  command -v "$cmd" >/dev/null 2>&1 || { err "$cmd not found (required)"; exit 1; }
done
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[ "$NODE_MAJOR" -ge 24 ] || { err "node >= 24 required (got $(node -v))"; exit 1; }
info "node $(node -v) · git OK"

# 2. config.json
heading 'Step 2/4 — config (~/.cultivagent/config.json)'
mkdir -p "$CV_HOME"
if [ -f "$CONFIG_FILE" ] && [ "$INTERACTIVE" = 1 ]; then
  info "existing: $CONFIG_FILE (endpoint=$(cfg_get "$CONFIG_FILE" endpoint))"
  ask 'Reconfigure? [y/N] '; read -r RC; case "$RC" in [Yy]*) RC=yes ;; *) RC=no ;; esac
elif [ -f "$CONFIG_FILE" ]; then
  RC=no
else
  RC=yes
fi
if [ "$RC" = yes ]; then
  if [ "$INTERACTIVE" = 1 ]; then
    ask 'Deploy mode — (l)ocal http://127.0.0.1:3737 or (r)emote? [l/r] '; read -r MODE
    case "$MODE" in
      [Rr]*) ask 'Server URL: '; read -r EP; ask 'Token (hidden): '; read -r -s TK; echo ;;
      *) EP='http://127.0.0.1:3737'; TK='' ;;
    esac
  else
    EP="${CULTIVAGENT_ENDPOINT:-http://127.0.0.1:3737}"; TK="${CULTIVAGENT_TOKEN:-}"
  fi
  write_config "$EP" "$TK"; info "wrote $CONFIG_FILE"
fi

# 3. repo
heading 'Step 3/4 — repo'
if [ -d "$REPO_DIR/.git" ]; then
  info "updating $REPO_DIR"
  git -C "$REPO_DIR" fetch --quiet origin "$REPO_REF"
  git -C "$REPO_DIR" reset --hard "origin/$REPO_REF" >/dev/null
else
  info "cloning → $REPO_DIR"
  git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$REPO_DIR"
fi

# 4. opencode.json plugin 字段（node 幂等：去重 push）
heading 'Step 4/4 — register plugin in opencode.json'
node - "$OPENCODE_CONFIG" "$PLUGIN_FILE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [cfgPath, pluginFile] = process.argv.slice(2);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch { cfg = {}; }
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (!cfg.plugin.includes(pluginFile)) cfg.plugin.push(pluginFile);
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
console.log("  registered: " + pluginFile);
NODE
info "wrote $OPENCODE_CONFIG"

# self-check
EP=$(cfg_get "$CONFIG_FILE" endpoint); EP="${EP:-http://127.0.0.1:3737}"
info "endpoint: $EP"
node -e '
  const fs = require("fs");
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
  const endpoint = (cfg.endpoint || "http://127.0.0.1:3737").replace(/\/$/, "");
  const headers = cfg.token ? { authorization: "Bearer " + cfg.token } : {};
  fetch(endpoint + "/api/health", { headers })
    .then((r) => console.log("  health: " + (r.status === 200 ? "OK" : "HTTP " + r.status)))
    .catch((e) => console.log("  health: UNREACHABLE (" + e.message + ")"));
' "$CONFIG_FILE" || warn 'self-check failed'

echo
info 'Done. Restart OpenCode to load the plugin.'
