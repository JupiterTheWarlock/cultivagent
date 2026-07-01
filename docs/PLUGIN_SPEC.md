# Cultivagent Plugin 化改造 Spec

> 参照实现：`volcengine/OpenViking`（本地副本 `~/.openviking/openviking-repo`）。
> 本 spec 的目录布局、manifest 字段、占位符渲染、install.sh 步骤均 1:1 对照 OpenViking 的真实文件，不发明字段。
> 改造目标：让 cultivagent 像 OpenViking 一样，**一个 repo 内同时容纳 server + 多 agent plugin**，用户「装 plugin 即接入」，server 独立部署在远端（VPS / Cloudflare，HTTPS）并强制 auth。

---

## 0. 产品定位（决定下面所有取舍）

cultivagent 是**纯被动 ingest sink**：接收各 agent 的 hook 事件 → 进 TTL pool → 落 SQLite → 渲染 dashboard。

**不提供任何供 agent 主动调用的接口**——无 MCP、无工具、无查询 API 给 agent。agent 唯一做的事就是把 hook 事件 POST 到 `/ingest`（或 OTel 端点）。这是与 OpenViking 的根本差异：OV 的 plugin 核心是 MCP server（暴露 recall/store 工具），cultivagent 没有，也不做。因此本 spec 中**不出现 `.mcp.json`、`mcpServers`、`/mcp` 端点**。

---

## 1. 现状与问题

### 1.1 接入方式落后

当前接入靠 [scripts/generate-hook-config.mjs](../scripts/generate-hook-config.mjs) **生成并覆盖** `~/.claude/settings.json` / `~/.codex/hooks.json`。这等价于 OpenViking 的 **legacy mode**（见 `examples/claude-code-memory-plugin/setup-helper/install.sh:327 install_legacy`），不是 plugin 模式。问题：

- 覆盖用户既有 settings.json，需手动备份；
- 不走 marketplace，无法 `plugin install` / `plugin enable` / `plugin uninstall` 生命周期管理；
- 升级靠重跑脚本，无幂等保证。

### 1.2 Auth 只保护写路径（远端裸奔）

[src/server.mjs:28](../src/server.mjs#L28):

```js
if (token && isWrite(req) && !isAuthorized(req, token)) {
  return json(res, 401, { error: "unauthorized" });
}
```

`isWrite` 只排除 `GET`/`HEAD` → **所有 `/api/*` GET 与 dashboard `/` 完全无 auth**。cultivagent 一旦部署到 VPS / Cloudflare，任何人都能拉走全部 usage 数据与 dashboard。这是 plugin 化前**必须先堵的洞**。

另外 [src/server.mjs:158](../src/server.mjs#L158) `isAuthorized` 用 `===` 字符串全等比较 token，存在理论上的时序泄露。

### 1.3 配置散落在 env

[scripts/hook-lib.mjs:12-13](../scripts/hook-lib.mjs#L12-L13) 只认 `CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN` 环境变量，没有配置文件，多个 agent 共用一套凭据时不便切换。OpenViking 用 `~/.openviking/ovcli.conf` 统一管理，可复用模式。

---

## 2. 参照实现要点（来自 OpenViking）

| 维度 | OpenViking 的做法 | cultivagent 对应 |
|---|---|---|
| server 位置 | repo 根，Rust+Python，1933 端口 | repo 根，Node，3737 端口（不变） |
| plugin 位置 | `examples/<agent>-*/` | **`plugins/<agent>/`**（不用 examples，更直白） |
| 本地 marketplace | `examples/.claude-plugin/marketplace.json`，`source` 指向相对目录 | `plugins/.claude-plugin/marketplace.json` |
| Claude hook 路径占位 | `${CLAUDE_PLUGIN_ROOT}`（2.0+ 原生展开） | 同左 |
| Codex hook 路径占位 | `__OPENVIKING_PLUGIN_ROOT__`，install.sh 用 sed 渲染（Codex 0.130 不注入 `CODEX_PLUGIN_ROOT`） | `__CULTIVAGENT_PLUGIN_ROOT__`，同法渲染 |
| 凭据配置文件 | `~/.openviking/ovcli.conf`（JSON） | **`~/.cultivagent/config.json`** |
| 凭据注入到 Codex | shell function `wrapper.sh`，每次启动解析凭据 + 注入 env | 同法（cultivagent 版更简，见 §8.5） |
| 安装双轨 | 一行 `curl | bash` install.sh + README 手动 4 步 | 同左 |
| install.sh 注册 | `claude plugin marketplace add` / `codex plugin marketplace add`，幂等 | 同左 |
| **MCP server** | plugin 核心是 MCP（`.mcp.json` 必需） | **不做**（见 §0，纯被动 sink） |

---

## 3. 目标仓库结构

```
cultivagent/
├── src/                                    # server（改 auth，见 §4）
│   ├── server.mjs
│   ├── db.mjs
│   ├── normalize.mjs
│   ├── auth.mjs                            # 【新增】auth + cookie + 登录页
│   └── dashboard.html
├── bin/cultivagent.mjs                     # server 入口（加 token 子命令）
├── plugins/                                # 【新增】对标 OpenViking examples/
│   ├── .claude-plugin/
│   │   └── marketplace.json                # 本地 marketplace 声明
│   ├── claude-code/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/hooks.json
│   │   ├── commands/cultivagent-status.md  # /cultivagent-status slash 命令
│   │   ├── scripts/
│   │   │   ├── hook.mjs                    # 由 scripts/claude-hook.mjs 迁入
│   │   │   ├── status.mjs                  # 新增：探活 + 打印状态
│   │   │   └── lib.mjs                     # 由 scripts/hook-lib.mjs 迁入
│   │   ├── setup-helper/install.sh
│   │   └── README.md
│   ├── codex/
│   │   ├── .codex-plugin/plugin.json
│   │   ├── hooks/hooks.json                # __CULTIVAGENT_PLUGIN_ROOT__，install 时渲染
│   │   ├── scripts/
│   │   │   ├── hook.mjs                    # 由 scripts/codex-hook.mjs 迁入
│   │   │   └── lib.mjs
│   │   ├── setup-helper/install.sh         # 复制+渲染占位符+marketplace+config.toml（无 wrapper）
│   │   └── README.md
│   ├── opencode/                           # adapter + install.sh + README
│   ├── pi/                                 # adapter + install.sh + README
│   └── openclaw/                           # native plugin entry (TS) + README
├── scripts/                                # 仅保留开发工具（plugin 化后 legacy hook 入口已删）
│   ├── hook-lib.mjs                        # cli-smoke / emit 共用（含 config.json 读取）
│   ├── emit.mjs                            # 手动发事件工具
│   └── cli-smoke.mjs                       # CLI 冒烟（package.json script）
├── docs/
│   ├── PLUGIN_SPEC.md                      # 本文件
│   ├── INSTALL.md                          # plugin 双轨安装指引
│   └── ...
└── package.json
```

> 不存在 `.mcp.json`、`mcpServers` 字段——cultivagent 是被动 sink（§0）。

---

## 4. Server 侧 Auth 加固（Phase 0，前置必做）

> 不做这一步，plugin 装到远端 server 就是把 usage 数据送给互联网。所有 plugin 工作排在 Phase 0 之后。
> 部署形态：**HTTPS**（VPS / Cloudflare，TLS 在反代层终止或 server 自带）。cookie 方案依赖 HTTPS（`Secure` 属性）。

### 4.1 目标 Auth 模型

当 `token` 非空（远端部署）时，每条请求满足以下任一即放行：

1. **`Authorization: Bearer <token>`** — agent hook 用（[hook-lib.mjs](../scripts/hook-lib.mjs) 已发此 header，保留）。
2. **`x-cultivagent-token: <token>`** — 备用 header（保留）。
3. **cookie `cultivagent_token=<token>`** — 浏览器访问 dashboard 用，登录页设置。

**浏览器 dashboard 登录流程**（替代原 Basic Auth 方案）：

```
GET /  (无 cookie 或 cookie 无效)
  └─ 返回登录页 HTML（一个 form：input token → POST /api/login）
POST /api/login  { token }
  ├─ token 有效 → 200 + Set-Cookie: cultivagent_token=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
  └─ token 无效 → 401
GET /  (cookie 有效)
  └─ 返回 dashboard.html
```

**cookie 属性**：`HttpOnly`（防 XSS 读取）、`Secure`（仅 HTTPS）、`SameSite=Lax`（防 CSRF，允许顶级导航携带）、`Max-Age=2592000`（30 天）。

**公开白名单**（token 非空时仍可匿名访问）：
- `GET /api/health` — 探活；
- `GET /` 的「未登录返回登录页」分支（不返回 401，直接 200 登录页 HTML）；
- `POST /api/login` — 登录；
- `POST /api/logout` — 登出（清 cookie）。

其余所有路径（dashboard HTML 本体、全部 `/api/*` GET、全部 POST ingest/otel）一律要求 auth。

**timing-safe 比较**：`crypto.timingSafeEqual` + 长度不等直接 false（不泄露长度）。

**token 为空（本地 127.0.0.1）**：行为不变，全部放行，保持现有本地零配置体验。

### 4.2 代码改动点

新增 [src/auth.mjs](../src/auth.mjs)，导出 `isAuthorized(req, token)`、`handleLogin(req, res, token)`、`loginPageHtml()`、`dashboardGate(req, res, token, serveDashboard)`。auth 逻辑从 [src/server.mjs](../src/server.mjs) 抽出。

```js
// src/auth.mjs（草案）
import { timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "cultivagent_token";
const COOKIE_MAX_AGE = 2592000; // 30 天

// 从三种来源任一提取候选 token
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

[src/server.mjs](../src/server.mjs) 请求入口（第 26-30 行）改为：

```js
const url = new URL(req.url, "http://localhost");

// 公开白名单
if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });
if (req.method === "POST" && url.pathname === "/api/login") return handleLogin(req, res, token);
if (req.method === "POST" && url.pathname === "/api/logout") return handleLogout(res);

// dashboard：有 cookie 放行，否则返回登录页
if (req.method === "GET" && url.pathname === "/") {
  if (!token || isAuthorized(req, token)) return html(res, dashboardHtml());
  return html(res, loginPageHtml());   // 登录页，不 401
}

// 其余路径：token 非空时强制 auth（GET 也查）
if (token && !isAuthorized(req, token)) {
  return json(res, 401, { error: "unauthorized" });
}
// ... 后续 /api/* 与 /ingest 路由不变
```

**前端零改动**：[src/dashboard.html](../src/dashboard.html) 现有 `fetch('/api/...')` 同源默认带 cookie，登录后自动鉴权，无需加 header。

### 4.3 Token 来源与管理

- 现状保留：[bin/cultivagent.mjs:13](../bin/cultivagent.mjs#L13) 从 `--token` arg 或 `CULTIVAGENT_TOKEN` env 读。
- **新增（Phase 0）**：`cultivagent token` 子命令，`crypto.randomBytes(32).toString("hex")` 生成并打印，便于 `$(cultivagent token)` 注入 systemd / Cloudflare Worker env。
- [docs/UBUNTU.md](UBUNTU.md) 补：`Environment=CULTIVAGENT_TOKEN=$(cultivagent token)`。

### 4.4 验收

token 非空时：
- `curl /api/usage/summary` → 401；
- `curl -H "Authorization: Bearer $T" /api/usage/summary` → 200；
- `curl /api/health` → 200（白名单）；
- 浏览器首次访问 `/` → 登录页；输 token → cookie → dashboard；关浏览器重开 `/` → 仍登录（cookie 30 天）；
- `POST /ingest` 无 header → 401，带 Bearer → 202。

token 为空时：所有路径 200（本地不变），无登录页。

---

## 5. 共享配置文件 `~/.cultivagent/config.json`

> 对标 OpenViking `~/.openviking/ovcli.conf`。plugin 脚本与 install.sh 共用此文件。
> **核心作用：本地 agent 凭此处的 token 访问远端 server**——这是「在某一个地方配置 token，让本地得以访问服务」的那个「地方」。

```json
{
  "endpoint": "https://cultivagent.example.com",
  "token": "<32-hex，与 server 的 CULTIVAGENT_TOKEN 一致>"
}
```

- `endpoint`：server 完整 URL，**不含 `/ingest`**（脚本自行拼 `/ingest`）。默认 `http://127.0.0.1:3737`。
- `token`：与 server `CULTIVAGENT_TOKEN` 一致。本地无 auth 可省略。

**配置优先级**（写入 [scripts/hook-lib.mjs](../scripts/hook-lib.mjs) 的 `sendEvent` 与各 install.sh）：

```
1. 环境变量 CULTIVAGENT_ENDPOINT / CULTIVAGENT_TOKEN   （CI、临时覆盖、wrapper 注入）
2. ~/.cultivagent/config.json                           （常态）
3. 内置默认 http://127.0.0.1:3737 / 无 token            （本地零配置）
```

hook-lib.mjs 改动：`sendEvent` 读 config.json 填充默认值，再让 env 覆盖。详见 §6.3。

---

## 6. Plugin 通用约定

### 6.1 占位符

| 占位符 | 出现在 | 谁来渲染 | 渲染为 |
|---|---|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | Claude plugin 的 hooks.json | Claude Code 2.0+ 原生（无需 install.sh 处理） | plugin 绝对路径 |
| `__CULTIVAGENT_PLUGIN_ROOT__` | Codex plugin 的 hooks.json | Codex install.sh 用 sed（Codex 0.130 不注入 `CODEX_PLUGIN_ROOT`） | cached plugin 绝对路径 |

> 无 endpoint 占位符——hook 脚本从 env / config.json 读 endpoint，不 baked 进 hook 配置（§8.5 wrapper 在启动时注入 env）。

### 6.2 hook 脚本契约（不变，沿用现有）

每个 agent 的 hook 脚本契约保持 [scripts/hook-lib.mjs](../scripts/hook-lib.mjs) 现状：

- 从 **stdin** 读 hook 输入 JSON（Claude Code / Codex 都把 hook payload 写到 stdin）。
- 从 **argv[2]** 取 event_type 兜底。
- 调 `sendEvent(baseEvent(<agent>, input, eventType))` → `POST {endpoint}/ingest`，带 `Authorization: Bearer <token>`。
- `source_agent` 固定为该 plugin 的 agent 名（`claude-code` / `codex` / ...）。
- 失败**只打日志不阻塞** hook（现有行为，保留）。hook 失败不应阻断 agent 主流程。

### 6.3 hook-lib.mjs 改动（读取 config.json）

[scripts/hook-lib.mjs:11-13](../scripts/hook-lib.mjs#L11-L13) `sendEvent` 的 endpoint / token 解析改为：

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
  // ... 其余 headers / fetch 不变
}
```

> `lib.mjs` 被 claude / codex / 其他 plugin 各自 copy 一份（与 OpenViking 一致：每个 plugin 自带 `scripts/lib.mjs`，不跨 plugin 引用）。

---

## 7. Claude Code Plugin 规格（Phase 1）

### 7.1 marketplace.json

`plugins/.claude-plugin/marketplace.json`（对标 `examples/.claude-plugin/marketplace.json`）：

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

> Phase 3 把 opencode / pi / openclaw 也加进 `plugins[]`，`source` 指向各自目录。

### 7.2 plugin.json

`plugins/claude-code/.claude-plugin/plugin.json`（对标 `examples/claude-code-memory-plugin/.claude-plugin/plugin.json`，**无 `mcpServers`**）：

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

`plugins/claude-code/hooks/hooks.json`（结构对标 `examples/claude-code-memory-plugin/hooks/hooks.json`；事件按 cultivagent 需要的覆盖面选）：

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

> 命令里第二个参数透传为 event_type 兜底。Claude 实际 hook 名由 stdin payload 的 `hook_event_name` 带入（[hook-lib.mjs:25](../scripts/hook-lib.mjs#L25) 已处理）。timeout 取 OpenViking 同类 hook 的保守值。

### 7.4 scripts/

- `plugins/claude-code/scripts/hook.mjs` ← 迁移自 [scripts/claude-hook.mjs](../scripts/claude-hook.mjs)（内容一致，`source_agent: "claude-code"`）。
- `plugins/claude-code/scripts/lib.mjs` ← 迁移自 [scripts/hook-lib.mjs](../scripts/hook-lib.mjs)（含 §6.3 config.json 读取改动）。
- `plugins/claude-code/scripts/status.mjs` ← 新增：读 config.json → `GET {endpoint}/api/health`（带 Bearer）→ 打印 endpoint / token 预览 / 健康状态。对标 `examples/claude-code-memory-plugin/scripts/ov-status.mjs`。

### 7.5 commands/cultivagent-status.md

```markdown
---
description: Show Cultivagent plugin status — endpoint, last ingest, server health
---

!node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs
```

### 7.6 install.sh 步骤

`plugins/claude-code/setup-helper/install.sh`，步骤对标 `examples/claude-code-memory-plugin/setup-helper/install.sh`：

1. 检查 `git jq curl node(>=24)`；
2. 确保 `~/.cultivagent/config.json` 存在（endpoint + token，交互式询问「本地 / 远端」，远端则问 URL 与 token，参照 OpenViking `install.sh:109-170` 的 ovcli.conf 交互）；
3. clone / refresh repo 到 `~/.cultivagent/repo`；
4. `claude plugin marketplace list | grep` 判断已存在则 `update`，否则 `add "$REPO/plugins"`（marketplace 名 `cultivagent-plugins-local`）；
5. `claude plugin install claude-code@cultivagent-plugins-local`（install 用 marketplace.json 的 plugin name `claude-code`，非 plugin.json 的 `cultivagent`），已装则跳过；
6. `claude plugin enable claude-code@cultivagent-plugins-local`；
7. 失败 → fallback `install_legacy`（见 §7.7）。

幂等：重跑只 update / 跳过，不覆盖用户 settings.json。

### 7.7 Legacy mode（Claude Code < 2.0）

对标 `install.sh:327-393 install_legacy`。仅当 `claude plugin` 不可用时：

- 用 **jq**（不用 sed，参照 `install.sh:369`）把 `${CLAUDE_PLUGIN_ROOT}` 替换成 plugin 绝对路径，再 `jq --slurpfile` 把 hooks 合并进 `~/.claude/settings.json`，合并前 `cp -p` 备份。
- 不涉及 MCP（cultivagent 无 MCP server）。

> 现有 `scripts/generate-hook-config.mjs` 的 claude 分支即为 legacy 实现，可直接复用其合并逻辑，迁入 install.sh 的 `install_legacy()`。

---

## 8. Codex Plugin 规格（Phase 2）

### 8.1 .codex-plugin/plugin.json

`plugins/codex/.codex-plugin/plugin.json`（对标 `examples/codex-memory-plugin/.codex-plugin/plugin.json`，含 `interface` 字段，**无 `mcpServers`**）：

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

### 8.2 hooks.json（占位符）

`plugins/codex/hooks/hooks.json`（对标 `examples/codex-memory-plugin/hooks/hooks.json`）：

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

> Codex 无 SessionEnd（已由 OpenViking 在 `codex-rs/hooks/src/events/` 确认，upstream #17421/#20374 被拒），故不列。token 权威值走 OTel：用户额外 `export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<endpoint>/otel/v1/logs`。

### 8.3 install.sh 步骤（自管理渲染，不依赖 Codex cache）

`plugins/codex/setup-helper/install.sh`。与 OpenViking 不同，cultivagent **不依赖 Codex 的 plugin cache 目录**渲染占位符——cache 路径含版本号、随 codex 版本变化，脆弱。改为 install 时把 plugin 复制到固定目录并就地渲染。仅依赖 `git + node`（config.json 用 node 读写，不依赖 jq）：

1. 检查 `git node(>=24)`（codex CLI 在第 5 步检查）；
2. 确保 `~/.cultivagent/config.json`（同 §7.6 第 2 步，用 node 读写）；
3. clone / refresh repo 到 `~/.cultivagent/repo`；
4. **复制 + 渲染**：`cp -r $REPO/plugins/codex $CV/codex-marketplace/codex`，再 `sed -i.bak "s|__CULTIVAGENT_PLUGIN_ROOT__|$dest|g" hooks.json`（用 `|` delimiter 避免 git-bash 下 `/` 转义异常；`.bak` 兼容 GNU/BSD sed）。endpoint **不渲染**——hook 脚本运行时从 config.json 读；
5. 写 `$CV/codex-marketplace/.claude-plugin/marketplace.json`（`name: cultivagent-plugins-local`, `plugins:[{name:codex, source:./codex}]`），`codex plugin marketplace add "$CV/codex-marketplace"`；
6. **config.toml**（node 脚本幂等改写，对标 OpenViking `install.sh:268-330`）：`[features] plugin_hooks = true` + `[plugins."codex@cultivagent-plugins-local"] enabled = true`；
7. `codex plugin install codex@cultivagent-plugins-local`（已装跳过）；
8. self-check（inline node 探活 `/api/health`）。

### 8.4 为什么不需要 shell wrapper

OpenViking 的 codex plugin 需要 `wrapper.sh`，是因为它的 MCP runtime 从进程 env 读凭据（`.mcp.json` 的 `bearer_token_env_var` 指向 env）。cultivagent **无 MCP**，hook 脚本（`scripts/lib.mjs sendEvent`）自己读 `~/.cultivagent/config.json`，不依赖 codex 进程注入 env。因此 cultivagent 的 codex plugin **不做 wrapper**——这是与 OpenViking 的关键简化。

---

## 9. 其他 Agent Plugin（Phase 3）

现有 [adapters/](../adapters/) 下已有 opencode / pi / openclaw 的单文件 adapter。Phase 3 把每个包成独立 plugin 目录，结构对齐 §7 / §8：

| agent | 包结构要点 | 安装机制 |
|---|---|---|
| **opencode** | `plugins/opencode/`，参照 `examples/opencode-plugin/`。opencode 用 `opencode.json` 的 `plugin: ["./path.js"]` | install.sh 写 `~/.config/opencode/opencode.json` 的 `plugin` 字段，指向 repo 内 adapter |
| **pi** | `plugins/pi/`，参照 `examples/pi-coding-agent-extension/`。pi 用 `-e extension.js` 或 package.json `pi.extensions` | install.sh 写 pi 的 extension 配置 |
| **openclaw** | `plugins/openclaw/`，参照 `examples/openclaw-plugin/`。openclaw 有 native plugin surface | install.sh 走 openclaw plugin 注册 |

> Phase 3 各 agent 的 manifest 格式以 OpenViking 对应 `examples/<agent>-plugin/` 为准，实施时逐个核对，不在本 spec 预定义（避免发明字段）。均不涉及 MCP。

---

## 10. install.sh 通用职责清单

所有 agent 的 install.sh 共享以下职责（提炼自 OpenViking 两个 installer）：

1. **依赖检查**：`node>=24`、`git`、`curl`、`jq`。
2. **配置文件**：确保 `~/.cultivagent/config.json`，交互式询问 endpoint（本地 / 远端）+ token（远端必填），已存在则保留。
3. **repo 落地**：clone / `git fetch + reset` 到 `~/.cultivagent/repo`，幂等。
4. **marketplace 注册**：`<agent> plugin marketplace add`，已存在则 update / 跳过。
5. **plugin 安装**：`<agent> plugin install cultivagent@cultivagent-plugins-local`，已装跳过。
6. **占位符渲染**（Codex 等不注入 PLUGIN_ROOT 的 agent）：sed 渲染 cached 副本的 `__CULTIVAGENT_PLUGIN_ROOT__`。
7. **凭据注入**（需要 env 的 agent）：写 shell wrapper 到 rc，marker 包裹，幂等。
8. **自检**：install 末尾打印 endpoint、token 预览、`<agent> plugin list` 结果；`GET /api/health` 探活（带 Bearer）。

一行安装器形态：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/<agent>/setup-helper/install.sh)
```

> **目标 shell：bash**。兼容两处运行环境：
> - **生产**：Linux（VPS / Cloudflare 部署机上跑 agent）—— 主目标；
> - **开发测试**：Windows + git-bash（作者主环境）。
>
> git-bash 基本兼容 POSIX bash，差异点（路径风格、`read -s`、`mktemp`）在 install.sh 内注释标注并验证，**不写 .ps1**。

---

## 11. 落地顺序

> 全部完成（2026-07-01）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| **Phase 0** | Server auth 加固（§4：登录页 + cookie + Bearer + timing-safe）+ `~/.cultivagent/config.json`（§5）+ hook-lib.mjs 读 config（§6.3）+ `cultivagent token` 命令 + malformed JSON→400 | ✅ |
| **Phase 1** | Claude Code plugin（§7）+ install.sh + `< 2.0` legacy fallback | ✅ |
| **Phase 2** | Codex plugin（§8）+ install.sh（复制 + 渲染 `__CULTIVAGENT_PLUGIN_ROOT__`，无 wrapper） | ✅ |
| **Phase 3** | opencode / pi（adapter + config.json + install.sh）/ openclaw（native entry + README） | ✅ |
| **Phase 4** | 改写 INSTALL.md / README 为 plugin 双轨；删除 `scripts/generate-hook-config.mjs` + `adapters/` + legacy hook 入口；smoke 改测 plugin hooks.json | ✅ |

Phase 0 是远端部署安全的前置（auth 堵 `/api/*` 裸奔），必须最先——已完成。Codex plugin 最终未采用 wrapper：hook 脚本直接读 config.json，cultivagent 无 MCP，没有需要注入 env 的 MCP runtime。

---

## 12. 暂不做 / 待定

- **MCP / agent 可调用接口**：不做。cultivagent 是纯被动 ingest sink（§0），无任何供 agent 主动操作的接口。
- **公网 marketplace 发布**：OpenViking 也仅本地 marketplace，公网 listing 待后续。cultivagent 先本地 marketplace。
- **多账号 / 多 server 切换**：OpenViking 的 `ov config switch` 体系超规格。cultivagent 单 server 单 token 即可，`config.json` 手改切换。
- **PowerShell install 脚本**：不写。install.sh 兼容 git-bash（开发）+ Linux（生产）。
- **dashboard 自定义样式登录页**：登录页仅最简 form，不投入前端设计。

---

## 附：OpenViking 参照文件索引

| 本 spec 章节 | OpenViking 参照文件 |
|---|---|
| §3 结构 | `examples/` 整体 |
| §4 auth | （OV 走云端 SaaS，仅作 token/endpoint 配置对照）`examples/claude-code-memory-plugin/setup-helper/install.sh:109-170` |
| §5 config.json | `examples/claude-code-memory-plugin/setup-helper/install.sh:109-170`（ovcli.conf 处理） |
| §6 占位符 | `examples/codex-memory-plugin/hooks/hooks.json`、`install.sh:368-378` |
| §7 Claude plugin | `examples/claude-code-memory-plugin/` 全部 + `setup-helper/install.sh` |
| §8 Codex plugin | `examples/codex-memory-plugin/` 全部 + `setup-helper/install.sh` + `wrapper.sh` |
| §9 其他 agent | `examples/opencode-plugin/`、`pi-coding-agent-extension/`、`openclaw-plugin/` |
| §10 install 通用 | 两个 `install.sh` 的共同步骤 |
