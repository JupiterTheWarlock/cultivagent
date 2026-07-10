# Cultivagent Plugin-ization Spec

> [English](./PLUGIN_SPEC.en.md) · [中文](./PLUGIN_SPEC.md)

> Reference implementation: `volcengine/OpenViking` (local copy at `~/.openviking/openviking-repo`).
> The directory layout, manifest fields, placeholder rendering, and install.sh steps in this spec are mapped 1:1 against OpenViking's real files — no invented fields.
> Goal: let cultivagent, like OpenViking, host **server + multiple agent plugins inside one repo**, where users "install a plugin to connect" and the server is deployed independently on a remote host (VPS / Cloudflare, HTTPS) with mandatory auth.

---

## 0. Product Positioning (drives every trade-off below)

cultivagent is a **pure passive ingest sink**: it receives each agent's hook events → routes them through a TTL pool → persists to SQLite → renders a dashboard.

**It exposes no interface for agents to call proactively** — no MCP, no tools, no query API for agents. The only thing an agent does is `POST` hook events to `/ingest` (or the OTel endpoint). This is the fundamental difference from OpenViking: OV's plugin core is an MCP server (exposing recall/store tools); cultivagent has none and will not add one. Accordingly, **`.mcp.json`, `mcpServers`, and a `/mcp` endpoint never appear in this spec**.

---

## 1. Current State and Problems

### 1.1 Backward onboarding

Today onboarding relies on [scripts/generate-hook-config.mjs](../scripts/generate-hook-config.mjs) to **generate and overwrite** `~/.claude/settings.json` / `~/.codex/hooks.json`. This is equivalent to OpenViking's **legacy mode** (see `examples/claude-code-memory-plugin/setup-helper/install.sh:327 install_legacy`), not the plugin mode. Problems:

- Overwrites the user's existing settings.json, requiring manual backup.
- No marketplace, so no `plugin install` / `plugin enable` / `plugin uninstall` lifecycle.
- Upgrades are re-run-the-script, without idempotency guarantees.

### 1.2 Auth protects only write paths (remote is exposed)

[src/server.mjs:28](../src/server.mjs#L28):

```js
if (token && isWrite(req) && !isAuthorized(req, token)) {
  return json(res, 401, { error: "unauthorized" });
}
```

`isWrite` only excludes `GET`/`HEAD` → **all `/api/*` GETs and the dashboard `/` have no auth at all**. Once cultivagent is deployed to a VPS / Cloudflare, anyone can pull all usage data and the dashboard. This is the hole that **must be plugged before** plugin-ization proceeds.

Additionally, [src/server.mjs:158](../src/server.mjs#L158) `isAuthorized` compares the token with `===` string equality, which has a theoretical timing leak.

### 1.3 Config scattered across env

[scripts/hook-lib.mjs:12-13](../scripts/hook-lib.mjs#L12-L13) only reads `CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN` environment variables, with no config file — inconvenient when multiple agents share one set of credentials. OpenViking manages this centrally via `~/.openviking/ovcli.conf`; the pattern is reusable.

---

## 2. Reference Implementation Notes (from OpenViking)

| Dimension | OpenViking's approach | cultivagent equivalent |
|---|---|---|
| Server location | repo root, Rust+Python, port 1933 | repo root, Node, port 3737 (unchanged) |
| Plugin location | `examples/<agent>-*/` | **`plugins/<agent>/`** (clearer than examples) |
| Local marketplace | `examples/.claude-plugin/marketplace.json`, `source` points at a relative directory | `plugins/.claude-plugin/marketplace.json` |
| Claude hook path placeholder | `${CLAUDE_PLUGIN_ROOT}` (native expansion in 2.0+) | same |
| Codex hook path placeholder | `__OPENVIKING_PLUGIN_ROOT__`, rendered by install.sh via sed (Codex 0.130 does not inject `CODEX_PLUGIN_ROOT`) | `__CULTIVAGENT_PLUGIN_ROOT__`, rendered the same way |
| Credentials config file | `~/.openviking/ovcli.conf` (JSON) | **`~/.cultivagent/config.json`** |
| Credentials injected into Codex | shell function `wrapper.sh`, parses creds + injects env on each launch | same (cultivagent's version is simpler; see §8.5) |
| Dual-track install | one-line `curl | bash` install.sh + 4-step manual README | same |
| install.sh registration | `claude plugin marketplace add` / `codex plugin marketplace add`, idempotent | same |
| **MCP server** | plugin core is MCP (`.mcp.json` required) | **not built** (see §0, pure passive sink) |

---

## 3. Target Repo Structure

```
cultivagent/
├── src/                                    # server (auth hardened, see §4)
│   ├── server.mjs
│   ├── db.mjs
│   ├── normalize.mjs
│   ├── auth.mjs                            # 【new】auth + cookie + login page
│   └── dashboard.html
├── bin/cultivagent.mjs                     # server entry (adds token subcommand)
├── plugins/                                # 【new】mirrors OpenViking examples/
│   ├── .claude-plugin/
│   │   └── marketplace.json                # local marketplace declaration
│   ├── claude-code/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/hooks.json
│   │   ├── commands/cultivagent-status.md  # /cultivagent-status slash command
│   │   ├── scripts/
│   │   │   ├── hook.mjs                    # migrated from scripts/claude-hook.mjs
│   │   │   ├── status.mjs                  # new: health probe + status print
│   │   │   └── lib.mjs                     # migrated from scripts/hook-lib.mjs
│   │   ├── setup-helper/install.sh
│   │   └── README.md
│   ├── codex/
│   │   ├── .codex-plugin/plugin.json
│   │   ├── hooks/hooks.json                # __CULTIVAGENT_PLUGIN_ROOT__, rendered on install
│   │   ├── scripts/
│   │   │   ├── hook.mjs                    # migrated from scripts/codex-hook.mjs
│   │   │   └── lib.mjs
│   │   ├── setup-helper/install.sh         # copy + render placeholder + marketplace + config.toml (no wrapper)
│   │   └── README.md
│   ├── opencode/                           # adapter + install.sh + README
│   ├── pi/                                 # adapter + install.sh + README
│   └── openclaw/                           # native plugin entry (TS) + README
├── scripts/                                # dev tools only (after plugin-ization, legacy hook entries are deleted)
│   ├── hook-lib.mjs                        # shared by cli-smoke / emit (includes config.json read)
│   ├── emit.mjs                            # manual event-emit tool
│   └── cli-smoke.mjs                       # CLI smoke (package.json script)
├── docs/
│   ├── PLUGIN_SPEC.md                      # this file
│   ├── INSTALL.md                          # dual-track plugin install guide
│   └── ...
└── package.json
```

> There is no `.mcp.json` or `mcpServers` field — cultivagent is a passive sink (§0).

---

## 4. Server-Side Auth Hardening (Phase 0, mandatory prerequisite)

> Without this step, installing plugins pointed at a remote server ships your usage data to the internet. All plugin work is sequenced after Phase 0.
> Deployment shape: **HTTPS** (VPS / Cloudflare, TLS terminated at the reverse proxy or on the server). The cookie scheme depends on HTTPS (the `Secure` attribute).

### 4.1 Target Auth Model

When `token` is non-empty (remote deployment), a request passes if it satisfies any of:

1. **`Authorization: Bearer <token>`** — for agent hooks ([hook-lib.mjs](../scripts/hook-lib.mjs) already sends this header; keep it).
2. **`x-cultivagent-token: <token>`** — alternate header (kept).
3. **cookie `cultivagent_token=<token>`** — for browser dashboard access, set by the login page.

**Browser dashboard login flow** (replaces the earlier Basic Auth idea):

```
GET /  (no cookie or cookie invalid)
  └─ returns login-page HTML (a form: input token → POST /api/login)
POST /api/login  { token }
  ├─ token valid → 200 + Set-Cookie: cultivagent_token=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
  └─ token invalid → 401
GET /  (cookie valid)
  └─ returns dashboard.html
```

**Cookie attributes**: `HttpOnly` (prevents XSS reads), `Secure` (HTTPS only), `SameSite=Lax` (prevents CSRF, allows top-level navigation), `Max-Age=2592000` (30 days).

**Public allowlist** (anonymous access still works even when token is non-empty):
- `GET /api/health` — health probe.
- `GET /` "not-logged-in returns login page" branch (returns 200 login-page HTML, not 401).
- `POST /api/login` — log in.
- `POST /api/logout` — log out (clears cookie).

Every other path (the dashboard HTML body, all `/api/*` GETs, all POST ingest/otel) requires auth.

**timing-safe comparison**: `crypto.timingSafeEqual` + return false immediately on length mismatch (no length leak).

**Empty token (local 127.0.0.1)**: behavior unchanged — everything passes, preserving the existing local zero-config experience.

### 4.2 Code Change Points

Add [src/auth.mjs](../src/auth.mjs) exporting `isAuthorized(req, token)`, `handleLogin(req, res, token)`, `loginPageHtml()`, `dashboardGate(req, res, token, serveDashboard)`. Auth logic is extracted from [src/server.mjs](../src/server.mjs).

```js
// src/auth.mjs (draft)
import { timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "cultivagent_token";
const COOKIE_MAX_AGE = 2592000; // 30 days

// Pull candidate tokens from any of the three sources
function candidateTokens(req) {
  const out = [];
  const auth = req.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) out.push(auth.slice(7));
  const x = req.headers["x-cultivagent-token"];
  if (x) out.push(x);
  const cookie = parseCookie(req.headers.cookie ?? "");
  if (cookie[COOKIE_NAME]) out.push(cookie[COOKIE_NAME]);
  return out;
}

export function isAuthorized(req, token) {
  return candidateTokens(req).some((c) => safeEq(c, token));
}

function safeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length || bb.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookie(header) {
  const out = {};
  for (const pair of header.split(";")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

export async function handleLogin(req, res, token) {
  const body = await readJson(req);
  if (!safeEq(body.token ?? "", token)) return json(res, 401, { error: "invalid token" });
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": `${COOKIE_NAME}=${encodeURIComponent(body.token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
  });
  res.end(JSON.stringify({ ok: true }));
}
```

[src/server.mjs](../src/server.mjs) request entry (lines 26-30) becomes:

```js
const url = new URL(req.url, "http://localhost");

// Public allowlist
if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });
if (req.method === "POST" && url.pathname === "/api/login") return handleLogin(req, res, token);
if (req.method === "POST" && url.pathname === "/api/logout") return handleLogout(res);

// dashboard: cookie passes, otherwise return the login page
if (req.method === "GET" && url.pathname === "/") {
  if (!token || isAuthorized(req, token)) return html(res, dashboardHtml());
  return html(res, loginPageHtml());   // login page, not 401
}

// All other paths: enforce auth when token is non-empty (GETs too)
if (token && !isAuthorized(req, token)) {
  return json(res, 401, { error: "unauthorized" });
}
// ... subsequent /api/* and /ingest routes unchanged
```

**Zero frontend change**: [src/dashboard.html](../src/dashboard.html) already does `fetch('/api/...')`; same-origin requests carry the cookie by default, so auth works post-login with no header changes.

### 4.3 Token Source and Management

- Current behavior kept: [bin/cultivagent.mjs:13](../bin/cultivagent.mjs#L13) reads from `--token` arg or `CULTIVAGENT_TOKEN` env.
- **New (Phase 0)**: `cultivagent token` subcommand, `crypto.randomBytes(32).toString("hex")` generates and prints it, for `$(cultivagent token)` injection into systemd / Cloudflare Worker env.
- [docs/UBUNTU.md](./UBUNTU.md) adds: `Environment=CULTIVAGENT_TOKEN=$(cultivagent token)`.

### 4.4 Acceptance

When token is non-empty:
- `curl /api/usage/summary` → 401;
- `curl -H "Authorization: Bearer $T" /api/usage/summary` → 200;
- `curl /api/health` → 200 (allowlist);
- Browser first visit to `/` → login page; enter token → cookie → dashboard; close and reopen `/` → still logged in (cookie 30 days);
- `POST /ingest` with no header → 401, with Bearer → 202.

When token is empty: every path returns 200 (local unchanged), no login page.

---

## 5. Shared Config File `~/.cultivagent/config.json`

> Mirrors OpenViking's `~/.openviking/ovcli.conf`. Plugin scripts and install.sh share this file.
> **Core purpose: local agents use the token here to reach the remote server** — this is "the place" where you configure a token so the local machine can access the service.

```json
{
  "endpoint": "https://cultivagent.example.com",
  "token": "<32-hex, matching the server's CULTIVAGENT_TOKEN>"
}
```

- `endpoint`: the full server URL, **without `/ingest`** (scripts append `/ingest` themselves). Default `http://127.0.0.1:3737`.
- `token`: matches the server's `CULTIVAGENT_TOKEN`. Can be omitted when local has no auth.

**Config priority** (written into [scripts/hook-lib.mjs](../scripts/hook-lib.mjs) `sendEvent` and each install.sh):

```
1. env vars CULTIVAGENT_ENDPOINT / CULTIVAGENT_TOKEN   (CI, ad-hoc override, wrapper injection)
2. ~/.cultivagent/config.json                           (the steady state)
3. built-in default http://127.0.0.1:3737 / no token   (local zero-config)
```

hook-lib.mjs change: `sendEvent` reads config.json to fill defaults, then lets env override. See §6.3.

---

## 6. Plugin Common Conventions

### 6.1 Placeholders

| Placeholder | Appears in | Rendered by | Renders to |
|---|---|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | Claude plugin's hooks.json | Claude Code 2.0+ natively (no install.sh handling) | absolute plugin path |
| `__CULTIVAGENT_PLUGIN_ROOT__` | Codex plugin's hooks.json | Codex install.sh via sed (Codex 0.130 does not inject `CODEX_PLUGIN_ROOT`) | cached plugin absolute path |

> No endpoint placeholder — hook scripts read endpoint from env / config.json, it is not baked into the hook config (§8.5's wrapper injects env at launch).

### 6.2 Hook Script Contract (unchanged, current behavior)

Each agent's hook-script contract keeps the current [scripts/hook-lib.mjs](../scripts/hook-lib.mjs) behavior:

- Reads hook input JSON from **stdin** (both Claude Code and Codex write the hook payload to stdin).
- Takes event_type fallback from **argv[2]**.
- Calls `sendEvent(baseEvent(<agent>, input, eventType))` → `POST {endpoint}/ingest`, with `Authorization: Bearer <token>`.
- `source_agent` is fixed to that plugin's agent name (`claude-code` / `codex` / ...).
- On failure, **logs only, does not block** the hook (current behavior, kept). A hook failure must not interrupt the agent's main flow.

### 6.3 hook-lib.mjs Change (read config.json)

[scripts/hook-lib.mjs:11-13](../scripts/hook-lib.mjs#L11-L13) `sendEvent` endpoint / token resolution becomes:

```js
import { homedir } from "node:os";
import { join } from "node:path";

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".cultivagent", "config.json"), "utf8"));
  } catch { return {}; }
}

export async function sendEvent(event) {
  const cfg = loadConfig();
  let endpoint = process.env.CULTIVAGENT_ENDPOINT ?? cfg.endpoint ?? "http://127.0.0.1:3737";
  if (!endpoint.endsWith("/ingest")) endpoint = endpoint.replace(/\/$/, "") + "/ingest";
  const token = process.env.CULTIVAGENT_TOKEN ?? cfg.token ?? "";
  // ... remaining headers / fetch unchanged
}
```

> `lib.mjs` is copied into each claude / codex / other plugin (consistent with OpenViking: each plugin ships its own `scripts/lib.mjs`, no cross-plugin references).

---

## 7. Claude Code Plugin Spec (Phase 1)

### 7.1 marketplace.json

`plugins/.claude-plugin/marketplace.json` (mirrors `examples/.claude-plugin/marketplace.json`):

```json
{
  "name": "cultivagent-plugins-local",
  "description": "Cultivagent plugins (local development)",
  "owner": { "name": "cultivagent" },
  "plugins": [
    {
      "name": "claude-code",
      "description": "Send Claude Code hook events to a Cultivagent server",
      "source": "./claude-code",
      "category": "productivity"
    }
  ]
}
```

> Phase 3 adds opencode / pi / openclaw to `plugins[]`, each `source` pointing at its own directory.

### 7.2 plugin.json

`plugins/claude-code/.claude-plugin/plugin.json` (mirrors `examples/claude-code-memory-plugin/.claude-plugin/plugin.json`, **no `mcpServers`**):

```json
{
  "name": "cultivagent",
  "version": "0.1.0",
  "description": "Send Claude Code hook events (SessionStart/UserPromptSubmit/Stop/SessionEnd/...) to a self-hosted Cultivagent server for token & usage monitoring.",
  "author": { "name": "cultivagent", "url": "https://github.com/JupiterTheWarlock/cultivagent" },
  "repository": "https://github.com/JupiterTheWarlock/cultivagent",
  "license": "MIT",
  "keywords": ["telemetry", "tokens", "claude-code", "monitoring", "cultivagent"]
}
```

### 7.3 hooks.json

`plugins/claude-code/hooks/hooks.json` (structure mirrors `examples/claude-code-memory-plugin/hooks/hooks.json`; events chosen for cultivagent's coverage):

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs session_start", "timeout": 10 }]
    }],
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs user_prompt_submit", "timeout": 8 }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs stop", "timeout": 10 }]
    }],
    "PreCompact": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs pre_compact", "timeout": 10 }]
    }],
    "SessionEnd": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs session_end", "timeout": 10 }]
    }]
  }
}
```

> The second argument in the command is passed through as an event_type fallback. Claude's actual hook name comes from the stdin payload's `hook_event_name` ([hook-lib.mjs:25](../scripts/hook-lib.mjs#L25) already handles this). Timeouts use OpenViking's conservative values for the same hook types.

### 7.4 scripts/

- `plugins/claude-code/scripts/hook.mjs` ← migrated from [scripts/claude-hook.mjs](../scripts/claude-hook.mjs) (identical content, `source_agent: "claude-code"`).
- `plugins/claude-code/scripts/lib.mjs` ← migrated from [scripts/hook-lib.mjs](../scripts/hook-lib.mjs) (including the §6.3 config.json read).
- `plugins/claude-code/scripts/status.mjs` ← new: reads config.json → `GET {endpoint}/api/health` (with Bearer) → prints endpoint / token preview / health. Mirrors `examples/claude-code-memory-plugin/scripts/ov-status.mjs`.

### 7.5 commands/cultivagent-status.md

```markdown
---
description: Show Cultivagent plugin status — endpoint, last ingest, server health
---

!node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs
```

### 7.6 install.sh Steps

`plugins/claude-code/setup-helper/install.sh`, steps mirror `examples/claude-code-memory-plugin/setup-helper/install.sh`:

1. Check `git jq curl node(>=24)`.
2. Ensure `~/.cultivagent/config.json` exists (endpoint + token; interactive "local / remote" prompt; for remote, ask URL and token, mirroring OpenViking `install.sh:109-170` ovcli.conf interaction).
3. Clone / refresh repo to `~/.cultivagent/repo`.
4. `claude plugin marketplace list | grep` to decide update vs `add "$REPO/plugins"` (marketplace name `cultivagent-plugins-local`).
5. `claude plugin install claude-code@cultivagent-plugins-local` (install uses marketplace.json's plugin name `claude-code`, not plugin.json's `cultivagent`); skip if already installed.
6. `claude plugin enable claude-code@cultivagent-plugins-local`.
7. On failure → fallback to `install_legacy` (see §7.7).

Idempotent: re-runs only update / skip; never overwrites the user's settings.json.

### 7.7 Legacy Mode (Claude Code < 2.0)

Mirrors `install.sh:327-393 install_legacy`. Only when `claude plugin` is unavailable:

- Use **jq** (not sed, mirroring `install.sh:369`) to replace `${CLAUDE_PLUGIN_ROOT}` with the plugin's absolute path, then `jq --slurpfile` to merge hooks into `~/.claude/settings.json`, with a `cp -p` backup before merging.
- No MCP involved (cultivagent has no MCP server).

> The existing `scripts/generate-hook-config.mjs` claude branch is the legacy implementation; its merge logic can be reused directly and moved into install.sh's `install_legacy()`.

---

## 8. Codex Plugin Spec (Phase 2)

### 8.1 .codex-plugin/plugin.json

`plugins/codex/.codex-plugin/plugin.json` (mirrors `examples/codex-memory-plugin/.codex-plugin/plugin.json`, includes the `interface` field, **no `mcpServers`**):

```json
{
  "name": "cultivagent",
  "version": "0.1.0",
  "description": "Send Codex hook events to a self-hosted Cultivagent server for token & usage monitoring. Codex hook surface has no SessionEnd (see DESIGN), so capture relies on Stop/PreCompact + SessionStart.",
  "author": { "name": "cultivagent", "url": "https://github.com/JupiterTheWarlock/cultivagent" },
  "repository": "https://github.com/JupiterTheWarlock/cultivagent",
  "license": "MIT",
  "keywords": ["telemetry", "tokens", "codex", "monitoring", "cultivagent"],
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "Cultivagent",
    "shortDescription": "Forward Codex hook events to Cultivagent",
    "longDescription": "Hooks Codex's lifecycle to forward events to a Cultivagent server. Codex provides no SessionEnd hook, so the plugin forwards SessionStart/UserPromptSubmit/Stop/PreCompact. For authoritative token totals, additionally point Codex OTel logs export at the server's /otel/v1/logs.",
    "developerName": "cultivagent",
    "category": "Productivity",
    "capabilities": ["Hook event forwarding", "OTel usage ingest"],
    "websiteURL": "https://github.com/JupiterTheWarlock/cultivagent"
  }
}
```

### 8.2 hooks.json (placeholders)

`plugins/codex/hooks/hooks.json` (mirrors `examples/codex-memory-plugin/hooks/hooks.json`):

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "clear|startup|resume",
      "hooks": [{ "type": "command", "command": "node __CULTIVAGENT_PLUGIN_ROOT__/scripts/hook.mjs session_start", "timeout": 10 }]
    }],
    "UserPromptSubmit": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "node __CULTIVAGENT_PLUGIN_ROOT__/scripts/hook.mjs user_prompt_submit", "timeout": 8 }]
    }],
    "Stop": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "node __CULTIVAGENT_PLUGIN_ROOT__/scripts/hook.mjs stop", "timeout": 10 }]
    }],
    "PreCompact": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "node __CULTIVAGENT_PLUGIN_ROOT__/scripts/hook.mjs pre_compact", "timeout": 10 }]
    }]
  }
}
```

> Codex has no SessionEnd (confirmed by OpenViking in `codex-rs/hooks/src/events/`; upstream #17421/#20374 were rejected), so it is not listed. Authoritative token values go through OTel: users additionally `export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<endpoint>/otel/v1/logs`.

### 8.3 install.sh Steps (self-managed rendering, no Codex cache dependency)

`plugins/codex/setup-helper/install.sh`. Unlike OpenViking, cultivagent **does not depend on Codex's plugin cache directory** to render placeholders — the cache path contains a version number and changes with the codex version, making it fragile. Instead, on install it copies the plugin to a fixed directory and renders in place. Depends only on `git + node` (config.json is read/written by node, not jq):

1. Check `git node(>=24)` (the codex CLI is checked in step 5).
2. Ensure `~/.cultivagent/config.json` (same as §7.6 step 2, via node).
3. Clone / refresh repo to `~/.cultivagent/repo`.
4. **Copy + render**: `cp -r $REPO/plugins/codex $CV/codex-marketplace/codex`, then `sed -i.bak "s|__CULTIVAGENT_PLUGIN_ROOT__|$dest|g" hooks.json` (use `|` delimiter to avoid git-bash `/` escaping quirks; `.bak` for GNU/BSD sed compatibility). The endpoint is **not rendered** — the hook script reads it from config.json at runtime.
5. Write `$CV/codex-marketplace/.claude-plugin/marketplace.json` (`name: cultivagent-plugins-local`, `plugins:[{name:codex, source:./codex}]`), then `codex plugin marketplace add "$CV/codex-marketplace"`.
6. **config.toml** (idempotent rewrite by a node script, mirroring OpenViking `install.sh:268-330`): `[features] plugin_hooks = true` + `[plugins."codex@cultivagent-plugins-local"] enabled = true`.
7. `codex plugin install codex@cultivagent-plugins-local` (skip if installed).
8. Self-check (inline node probes `/api/health`).

### 8.4 Why No Shell Wrapper

OpenViking's codex plugin needs `wrapper.sh` because its MCP runtime reads credentials from process env (`.mcp.json`'s `bearer_token_env_var` points at an env var). cultivagent **has no MCP**; the hook script (`scripts/lib.mjs sendEvent`) reads `~/.cultivagent/config.json` itself and does not depend on the codex process injecting env. So cultivagent's codex plugin **does not build a wrapper** — a key simplification versus OpenViking.

---

## 9. Other Agent Plugins (Phase 3)

The existing [adapters/](../adapters/) directory already has single-file adapters for opencode / pi / openclaw. Phase 3 packages each into its own plugin directory, structurally aligned with §7 / §8:

| Agent | Package要点 | Install mechanism |
|---|---|---|
| **opencode** | `plugins/opencode/`, mirroring `examples/opencode-plugin/`. opencode uses `opencode.json`'s `plugin: ["./path.js"]` | install.sh writes `~/.config/opencode/opencode.json`'s `plugin` field, pointing at the adapter in the repo |
| **pi** | `plugins/pi/`, mirroring `examples/pi-coding-agent-extension/`. pi uses `-e extension.js` or package.json `pi.extensions` | install.sh writes pi's extension config |
| **openclaw** | `plugins/openclaw/`, mirroring `examples/openclaw-plugin/`. openclaw has a native plugin surface | install.sh goes through openclaw's plugin registration |

> Phase 3's manifest formats for each agent follow the corresponding OpenViking `examples/<agent>-plugin/` as the source of truth, verified one by one at implementation time, not pre-defined here (to avoid inventing fields). None involve MCP.

---

## 10. install.sh Common Responsibilities

All agents' install.sh share these responsibilities (distilled from OpenViking's two installers):

1. **Dependency check**: `node>=24`, `git`, `curl`, `jq`.
2. **Config file**: ensure `~/.cultivagent/config.json`; interactively ask for endpoint (local / remote) + token (required for remote); preserve if it exists.
3. **Repo landing**: clone / `git fetch + reset` to `~/.cultivagent/repo`, idempotent.
4. **Marketplace registration**: `<agent> plugin marketplace add`; update / skip if it exists.
5. **Plugin install**: `<agent> plugin install cultivagent@cultivagent-plugins-local`; skip if installed.
6. **Placeholder rendering** (Codex and other agents that don't inject PLUGIN_ROOT): sed-render the cached copy's `__CULTIVAGENT_PLUGIN_ROOT__`.
7. **Credential injection** (agents that need env): write a shell wrapper into rc, marker-wrapped, idempotent.
8. **Self-check**: at the end, print endpoint, token preview, `<agent> plugin list` result; `GET /api/health` probe (with Bearer).

One-line installer shape:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/<agent>/setup-helper/install.sh)
```

> **Target shell: bash.** Compatible with two run environments:
> - **Production**: Linux (agents run on VPS / Cloudflare deployment hosts) — primary target.
> - **Dev / test**: Windows + git-bash (the author's main environment).
>
> git-bash is broadly POSIX-bash compatible. Differences (path style, `read -s`, `mktemp`) are noted and verified inside install.sh. **No `.ps1` files.**

---

## 11. Rollout Sequence

> All complete (2026-07-01).

| Phase | Content | Status |
|---|---|---|
| **Phase 0** | Server auth hardening (§4: login page + cookie + Bearer + timing-safe) + `~/.cultivagent/config.json` (§5) + hook-lib.mjs reads config (§6.3) + `cultivagent token` command + malformed JSON→400 | ✅ |
| **Phase 1** | Claude Code plugin (§7) + install.sh + `< 2.0` legacy fallback | ✅ |
| **Phase 2** | Codex plugin (§8) + install.sh (copy + render `__CULTIVAGENT_PLUGIN_ROOT__`, no wrapper) | ✅ |
| **Phase 3** | opencode / pi (adapter + config.json + install.sh) / openclaw (native entry + README) | ✅ |
| **Phase 4** | Rewrite INSTALL.md / README for dual-track plugins; delete `scripts/generate-hook-config.mjs` + `adapters/` + legacy hook entries; smoke tests plugin hooks.json | ✅ |

Phase 0 is the prerequisite for remote-deployment safety (plugging the exposed `/api/*`). It had to go first — done. The Codex plugin ultimately did not adopt a wrapper: the hook script reads config.json directly, cultivagent has no MCP, and there is no MCP runtime needing env injection.

---

## 12. Explicitly Not Done / Deferred

- **MCP / agent-callable interface**: not built. cultivagent is a pure passive ingest sink (§0) with no interface for agents to operate on proactively.
- **Public marketplace listing**: OpenViking is also local-marketplace only; public listing deferred. cultivagent starts with a local marketplace.
- **Multi-account / multi-server switching**: OpenViking's `ov config switch` system is out of scope. cultivagent works with a single server and single token; switch by hand-editing `config.json`.
- **PowerShell install scripts**: not written. install.sh is compatible with git-bash (dev) + Linux (production).
- **Custom-styled login page**: the login page is a minimal form only; no frontend-design investment.

---

## Appendix: OpenViking Reference Index

| This spec's section | OpenViking reference file |
|---|---|
| §3 structure | `examples/` overall |
| §4 auth | (OV runs on cloud SaaS; only token/endpoint config is cross-referenced) `examples/claude-code-memory-plugin/setup-helper/install.sh:109-170` |
| §5 config.json | `examples/claude-code-memory-plugin/setup-helper/install.sh:109-170` (ovcli.conf handling) |
| §6 placeholders | `examples/codex-memory-plugin/hooks/hooks.json`, `install.sh:368-378` |
| §7 Claude plugin | `examples/claude-code-memory-plugin/` all + `setup-helper/install.sh` |
| §8 Codex plugin | `examples/codex-memory-plugin/` all + `setup-helper/install.sh` + `wrapper.sh` |
| §9 other agents | `examples/opencode-plugin/`, `pi-coding-agent-extension/`, `openclaw-plugin/` |
| §10 install common | the shared steps across both `install.sh` files |
