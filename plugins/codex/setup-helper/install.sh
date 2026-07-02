#!/usr/bin/env bash
#
# Cultivagent Codex plugin — installer.
#
# One-liner:
#   bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)
#
# 与 Claude Code installer 的关键区别：Codex 0.130 不把 CODEX_PLUGIN_ROOT 注入
# hook 子进程，所以 hooks.json 里的 __CULTIVAGENT_PLUGIN_ROOT__ 必须在 install
# 时渲染成绝对路径。本脚本采用「复制 plugin 到固定目录 + 就地渲染」，不依赖
# Codex 的 plugin cache（cache 路径含版本号、随 codex 版本变化，脆弱）。
#
# 不需要 shell wrapper：hook 脚本自己读 ~/.cultivagent/config.json，不走
# Codex 进程 env（cultivagent 无 MCP，与 OpenViking codex plugin 的本质差异）。
#
# 仅依赖 git + node（config.json 用 node 读写，不依赖 jq）。
# Targets bash — Linux (production) and git-bash on Windows (dev/test).

set -euo pipefail

CV_HOME="${CULTIVAGENT_HOME:-$HOME/.cultivagent}"
REPO_URL="${CULTIVAGENT_REPO_URL:-https://github.com/JupiterTheWarlock/cultivagent.git}"
REPO_REF="${CULTIVAGENT_REPO_REF:-${CULTIVAGENT_REPO_BRANCH:-main}}"
REPO_DIR="${CULTIVAGENT_REPO_DIR:-$CV_HOME/repo}"
CONFIG_FILE="$CV_HOME/config.json"
MARKETPLACE_NAME="cultivagent-plugins-local"
PLUGIN_NAME="codex"
PLUGIN_ID="$PLUGIN_NAME@$MARKETPLACE_NAME"
MP_ROOT="$CV_HOME/codex-marketplace"
PLUGIN_DEST="$MP_ROOT/$PLUGIN_NAME"
CODEX_CONFIG="${CODEX_CONFIG_FILE:-$HOME/.codex/config.toml}"

# --- colors ---
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

print_help() {
  cat <<'EOF'
Cultivagent Codex plugin installer.

Usage:
  bash install.sh                 interactive (or env-driven when piped)

Env overrides:
  CULTIVAGENT_HOME                config/repo root (default: ~/.cultivagent)
  CULTIVAGENT_REPO_DIR            repo checkout path
  CULTIVAGENT_REPO_URL            git remote (default: JupiterTheWarlock/cultivagent)
  CULTIVAGENT_REPO_REF / _BRANCH  ref to checkout (default: main)
  CULTIVAGENT_ENDPOINT            non-interactive: server URL
  CULTIVAGENT_TOKEN               non-interactive: bearer token
  CULTIVAGENT_USERNAME            optional username label (default: machine name)
  CODEX_CONFIG_FILE               codex config.toml path (default: ~/.codex/config.toml)

Targets bash (Linux production + git-bash on Windows). Requires only git + node.
EOF
}

case "${1:-}" in
  -h|--help) print_help; exit 0 ;;
esac

# 用 node 读 config.json 字段（不依赖 jq）
cfg_get() {
  node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]]||''))}catch{}" "$1" "$2" 2>/dev/null
}

write_config() {
  node -e '
    const fs = require("fs");
    const [path, endpoint, token, username] = process.argv.slice(1);
    const config = { endpoint, token };
    if (username) config.username = username;
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  ' "$CONFIG_FILE" "$1" "$2" "${3:-}"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
}

# --- 1. dependencies ---
heading 'Step 1/6 — dependencies'
for cmd in git node; do
  command -v "$cmd" >/dev/null 2>&1 || { err "$cmd not found (required)"; exit 1; }
done
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 24 ]; then err "node >= 24 required (got $(node -v))"; exit 1; fi
info "node $(node -v) · git OK"

# --- 2. config.json ---
heading 'Step 2/6 — config (~/.cultivagent/config.json)'
mkdir -p "$CV_HOME"

if [ -f "$CONFIG_FILE" ]; then
  CUR_URL=$(cfg_get "$CONFIG_FILE" endpoint)
  info "existing config: $CONFIG_FILE"
  info "  endpoint = ${CUR_URL:-<unset>}"
  if [ "$INTERACTIVE" = 1 ]; then
    ask 'Reconfigure? [y/N] '; read -r RECONFIG
    case "$RECONFIG" in [Yy]*) RECONFIG=yes ;; *) RECONFIG=no ;; esac
  else
    RECONFIG=no
  fi
else
  RECONFIG=yes
fi

if [ "$RECONFIG" = yes ]; then
  if [ "$INTERACTIVE" = 1 ]; then
    ask 'Deploy mode — (l)ocal http://127.0.0.1:3737 or (r)emote? [l/r] '; read -r MODE
    case "$MODE" in
      [Rr]*)
        ask 'Server URL (https://...): '; read -r ENDPOINT
        ask 'Token (CULTIVAGENT_TOKEN, input hidden): '; read -r -s TOKEN; echo
        ask 'Username label (blank = machine name): '; read -r USERNAME
        ;;
      *)
        ENDPOINT='http://127.0.0.1:3737'; TOKEN=''
        ask 'Username label (blank = machine name): '; read -r USERNAME
        ;;
    esac
    [ -n "${ENDPOINT:-}" ] || { err 'endpoint required'; exit 1; }
  else
    ENDPOINT="${CULTIVAGENT_ENDPOINT:-http://127.0.0.1:3737}"
    TOKEN="${CULTIVAGENT_TOKEN:-}"
    USERNAME="${CULTIVAGENT_USERNAME:-}"
    info "non-interactive: endpoint from env/default"
  fi
  write_config "$ENDPOINT" "$TOKEN" "${USERNAME:-}"
  info "wrote $CONFIG_FILE"
fi

# --- 3. repo ---
heading 'Step 3/6 — repo'
if [ -d "$REPO_DIR/.git" ]; then
  info "updating $REPO_DIR"
  git -C "$REPO_DIR" fetch --quiet origin "$REPO_REF"
  git -C "$REPO_DIR" reset --hard "origin/$REPO_REF" >/dev/null
else
  info "cloning $REPO_URL → $REPO_DIR"
  git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$REPO_DIR"
fi

# --- 4. copy + render ---
heading 'Step 4/6 — render plugin (copy + substitute __CULTIVAGENT_PLUGIN_ROOT__)'
mkdir -p "$MP_ROOT"
rm -rf "$PLUGIN_DEST"
cp -r "$REPO_DIR/plugins/codex" "$PLUGIN_DEST"
# sed 渲染占位符。用 | 作 delimiter，避免 replacement 里转义路径中的 /
# （git-bash 下传统 \/ 转义在 replacement 中行为异常）。.bak 后缀兼容 GNU/BSD sed。
if [ -f "$PLUGIN_DEST/hooks/hooks.json" ]; then
  sed -i.bak "s|__CULTIVAGENT_PLUGIN_ROOT__|$PLUGIN_DEST|g" "$PLUGIN_DEST/hooks/hooks.json"
  rm -f "$PLUGIN_DEST/hooks/hooks.json.bak"
  info "rendered $PLUGIN_DEST/hooks/hooks.json"
else
  err "hooks.json not found at $PLUGIN_DEST/hooks/hooks.json"; exit 1
fi

# --- 5. marketplace + config.toml + install ---
heading 'Step 5/6 — codex plugin'
if ! command -v codex >/dev/null 2>&1; then
  err "'codex' CLI not found. Install Codex first, then re-run."
  err "Manual commands once codex is available:"
  err "  codex plugin marketplace add \"$MP_ROOT\""
  err "  codex plugin install $PLUGIN_ID"
  exit 1
fi

mkdir -p "$MP_ROOT/.claude-plugin"
cat > "$MP_ROOT/.claude-plugin/marketplace.json" <<EOF
{
  "name": "$MARKETPLACE_NAME",
  "plugins": [
    { "name": "$PLUGIN_NAME", "source": "./$PLUGIN_NAME" }
  ]
}
EOF

codex plugin marketplace add "$MP_ROOT" >/dev/null 2>&1 || true
info "marketplace registered: $MP_ROOT"

# config.toml 幂等改写：[features] plugin_hooks = true + [plugins."<id>"] enabled = true
node - "$CODEX_CONFIG" "$PLUGIN_ID" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const pluginId = process.argv[3];

let text = "";
try { text = fs.readFileSync(path, "utf8"); } catch { text = ""; }

function ensureSectionLine(src, section, key, value) {
  const lines = src.split(/\n/);
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const prefix = src.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${header}\n${key} = ${value}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n").replace(/\n*$/, "\n");
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
  return lines.join("\n").replace(/\n*$/, "\n");
}

function ensurePluginEnabled(src, pluginId) {
  const header = `[plugins."${pluginId}"]`;
  const lines = src.split(/\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const prefix = src.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${header}\nenabled = true\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i += 1) {
    if (/^\s*enabled\s*=/.test(lines[i])) {
      lines[i] = "enabled = true";
      return lines.join("\n").replace(/\n*$/, "\n");
    }
  }
  lines.splice(end, 0, "enabled = true");
  return lines.join("\n").replace(/\n*$/, "\n");
}

text = ensurePluginEnabled(text, pluginId);
text = ensureSectionLine(text, "features", "plugin_hooks", "true");
fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
fs.writeFileSync(path, text);
NODE
info "enabled plugin + features.plugin_hooks in $CODEX_CONFIG"

if codex plugin add --help >/dev/null 2>&1; then
  codex plugin add "$PLUGIN_ID" >/dev/null 2>&1 || info "plugin add: already installed or queued"
else
  codex plugin install "$PLUGIN_ID" >/dev/null 2>&1 || info "plugin install: already installed or queued"
fi

# --- 6. self-check ---
heading 'Step 6/6 — self-check'
ENDPOINT_CHECK=$(cfg_get "$CONFIG_FILE" endpoint); ENDPOINT_CHECK="${ENDPOINT_CHECK:-http://127.0.0.1:3737}"
TOKEN_CHECK=$(cfg_get "$CONFIG_FILE" token)
info "endpoint: $ENDPOINT_CHECK"
node -e '
  const fs = require("fs");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
  const endpoint = (cfg.endpoint || "http://127.0.0.1:3737").replace(/\/$/, "");
  const token = cfg.token || "";
  const headers = token ? { authorization: "Bearer " + token } : {};
  fetch(endpoint + "/api/health", { headers })
    .then((r) => console.log("  health: " + (r.status === 200 ? "OK" : "HTTP " + r.status)))
    .catch((e) => console.log("  health: UNREACHABLE (" + e.message + ")"));
' "$CONFIG_FILE" || warn 'self-check failed'

echo
info 'Done. Restart Codex to activate hooks.'
