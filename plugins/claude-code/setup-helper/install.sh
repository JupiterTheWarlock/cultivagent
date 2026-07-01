#!/usr/bin/env bash
#
# Cultivagent Claude Code plugin — interactive installer.
#
# One-liner:
#   bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/claude-code/setup-helper/install.sh)
#
# UX mirrors the OpenViking claude-code installer: colored step output +
# interactive config setup. When stdin is not a TTY (e.g. `curl | bash`)
# interactive prompts are skipped and existing config / env vars / defaults
# are used.
#
# Env overrides:
#   CULTIVAGENT_HOME                config/repo root (default: ~/.cultivagent)
#   CULTIVAGENT_REPO_DIR            repo checkout path (default: $CULTIVAGENT_HOME/repo)
#   CULTIVAGENT_REPO_URL            git remote (default: JupiterTheWarlock/cultivagent)
#   CULTIVAGENT_REPO_REF / _BRANCH  ref to checkout (default: main)
#   CULTIVAGENT_ENDPOINT            non-interactive: server URL
#   CULTIVAGENT_TOKEN               non-interactive: bearer token
#
# Targets bash — Linux (production) and git-bash on Windows (dev/test).

set -euo pipefail

CV_HOME="${CULTIVAGENT_HOME:-$HOME/.cultivagent}"
REPO_URL="${CULTIVAGENT_REPO_URL:-https://github.com/JupiterTheWarlock/cultivagent.git}"
REPO_REF="${CULTIVAGENT_REPO_REF:-${CULTIVAGENT_REPO_BRANCH:-main}}"
REPO_DIR="${CULTIVAGENT_REPO_DIR:-$CV_HOME/repo}"
CONFIG_FILE="$CV_HOME/config.json"
MARKETPLACE_NAME="cultivagent-plugins-local"
PLUGIN_ID="claude-code@$MARKETPLACE_NAME"

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

# 交互式仅当 stdin 是 TTY（curl|bash 时 stdin 非TTY，跳过 prompt）
INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0

print_help() {
  cat <<'EOF'
Cultivagent Claude Code plugin installer.

Usage:
  bash install.sh                 interactive (or env-driven when piped)

Env overrides:
  CULTIVAGENT_HOME                config/repo root (default: ~/.cultivagent)
  CULTIVAGENT_REPO_DIR            repo checkout path
  CULTIVAGENT_REPO_URL            git remote (default: JupiterTheWarlock/cultivagent)
  CULTIVAGENT_REPO_REF / _BRANCH  ref to checkout (default: main)
  CULTIVAGENT_ENDPOINT            non-interactive: server URL
  CULTIVAGENT_TOKEN               non-interactive: bearer token

Targets bash (Linux production + git-bash on Windows).
EOF
}

case "${1:-}" in
  -h|--help) print_help; exit 0 ;;
esac

# --- legacy fallback: Claude Code < 2.0 没有 `claude plugin` ---
# 用 jq 把 ${CLAUDE_PLUGIN_ROOT} 替换成绝对路径，再把 hooks 合并进 settings.json。
install_legacy() {
  local settings="$HOME/.claude/settings.json"
  local plugin_dir="$REPO_DIR/plugins/claude-code"
  local tmp_h
  info 'legacy mode: merge hooks into ~/.claude/settings.json'
  command -v jq >/dev/null 2>&1 || { err 'jq required for legacy mode'; exit 1; }

  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  cp -p "$settings" "$settings.bak.$(date +%s)"

  tmp_h=$(mktemp)
  # 用 jq（非 sed）替换 ${CLAUDE_PLUGIN_ROOT}：plugin_dir 可能含特殊字符
  jq --arg root "$plugin_dir" \
    'walk(if type == "string" then gsub("\\$\\{CLAUDE_PLUGIN_ROOT\\}"; $root) else . end)' \
    "$plugin_dir/hooks/hooks.json" > "$tmp_h" || { err 'expand CLAUDE_PLUGIN_ROOT failed'; rm -f "$tmp_h"; exit 1; }

  jq --slurpfile h "$tmp_h" '.hooks = ((.hooks // {}) * $h[0].hooks)' \
    "$settings" > "$settings.tmp" || { err 'merge hooks failed'; rm -f "$tmp_h"; exit 1; }
  jq -e . "$settings.tmp" >/dev/null && mv "$settings.tmp" "$settings" || { err 'merged settings invalid'; rm -f "$settings.tmp"; exit 1; }
  rm -f "$tmp_h"
  info "merged into $settings (backup saved)"
}

# --- 1. dependencies ---
heading 'Step 1/5 — dependencies'
for cmd in git jq curl node; do
  command -v "$cmd" >/dev/null 2>&1 || { err "$cmd not found (required)"; exit 1; }
done
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 24 ]; then err "node >= 24 required (got $(node -v))"; exit 1; fi
info "node $(node -v) · git · jq · curl OK"

# --- 2. config.json ---
heading 'Step 2/5 — config (~/.cultivagent/config.json)'
mkdir -p "$CV_HOME"

write_config() {
  local endpoint="$1" token="$2"
  jq -n --arg url "$endpoint" --arg tok "$token" '{endpoint:$url, token:$tok}' > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
}

if [ -f "$CONFIG_FILE" ]; then
  CUR_URL=$(jq -r '.endpoint // ""' "$CONFIG_FILE")
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
        ;;
      *)
        ENDPOINT='http://127.0.0.1:3737'; TOKEN=''
        ;;
    esac
    [ -n "${ENDPOINT:-}" ] || { err 'endpoint required'; exit 1; }
  else
    ENDPOINT="${CULTIVAGENT_ENDPOINT:-http://127.0.0.1:3737}"
    TOKEN="${CULTIVAGENT_TOKEN:-}"
    info "non-interactive: endpoint from env/default"
  fi
  write_config "$ENDPOINT" "$TOKEN"
  info "wrote $CONFIG_FILE"
fi

# --- 3. repo ---
heading 'Step 3/5 — repo'
if [ -d "$REPO_DIR/.git" ]; then
  info "updating $REPO_DIR"
  git -C "$REPO_DIR" fetch --quiet origin "$REPO_REF"
  git -C "$REPO_DIR" reset --hard "origin/$REPO_REF" >/dev/null
else
  info "cloning $REPO_URL → $REPO_DIR"
  git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$REPO_DIR"
fi

# --- 4. marketplace + plugin ---
heading 'Step 4/5 — claude plugin'
if ! command -v claude >/dev/null 2>&1; then
  err "'claude' CLI not found. Install Claude Code >= 2.0 first, then re-run."
  err "Once available, the manual commands are:"
  err "  claude plugin marketplace add \"$REPO_DIR/plugins\""
  err "  claude plugin install $PLUGIN_ID"
  exit 1
fi

if claude plugin marketplace list 2>/dev/null | grep -qF "$MARKETPLACE_NAME"; then
  info "marketplace already registered — update ($MARKETPLACE_NAME)"
  claude plugin marketplace update "$MARKETPLACE_NAME" || warn 'marketplace update returned non-zero — continuing'
else
  info 'marketplace add'
  ( cd "$REPO_DIR" && claude plugin marketplace add "$REPO_DIR/plugins" ) || warn 'marketplace add returned non-zero — continuing'
fi

if claude plugin list 2>/dev/null | grep -qF "$PLUGIN_ID"; then
  info "plugin already installed: $PLUGIN_ID"
else
  info "plugin install $PLUGIN_ID"
  if ! ( cd "$REPO_DIR" && claude plugin install "$PLUGIN_ID" ); then
    warn 'plugin install failed — falling back to legacy mode'
    install_legacy
  fi
fi
claude plugin enable "$PLUGIN_ID" >/dev/null 2>&1 || true
info "enabled $PLUGIN_ID"

# --- 5. self-check ---
heading 'Step 5/5 — self-check'
node "$REPO_DIR/plugins/claude-code/scripts/status.mjs" || warn 'self-check failed (server may be down — hooks will retry)'

echo
info 'Done. Restart Claude Code to activate hooks.'
