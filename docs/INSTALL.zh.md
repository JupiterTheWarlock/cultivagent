# Cultivagent 安装指引

> [English](./INSTALL.md) · [中文](./INSTALL.zh.md)

Cultivagent 是一个**纯被动接收端**：agent 把 hook 事件转发到 `POST /ingest`，服务端存储并渲染面板。无 MCP、无供 agent 调用的接口。

## 1. 启动服务端

需要 Node.js 24+。

```bash
git clone https://github.com/JupiterTheWarlock/cultivagent.git
cd cultivagent
npm start
```

面板：http://127.0.0.1:3737

### 远程 / 带鉴权部署

VPS / Cloudflare 场景下，生成 token 并要求鉴权：

```bash
export CULTIVAGENT_TOKEN=$(node bin/cultivagent.mjs token)
HOST=0.0.0.0 CULTIVAGENT_TOKEN=$CULTIVAGENT_TOKEN npm start
```

设置了 token 后，除 `GET /api/health` 外的所有路径都要求鉴权。接受三种形式：

- `Authorization: Bearer <token>` —— agent hook 用
- `x-cultivagent-token: <token>` —— 备用请求头
- cookie `cultivagent_token` —— 浏览器面板用（访问 `/`，在登录页输入 token；cookie 为 HttpOnly/Secure/SameSite-Lax，30 天）

systemd / 反向代理部署见 [docs/UBUNTU.md](./UBUNTU.zh.md)。

### Cloudflare Worker + D1 部署

Worker 运行时与 Node 服务 API 兼容，数据存入 D1。使用相同的 auth token，面板作为 Worker 静态资源提供。

```bash
npm install
npx wrangler d1 create cultivagent
```

把生成的 `database_id` 填进 `wrangler.jsonc`，然后：

```bash
npm run worker:migrate:remote
npx wrangler secret put CULTIVAGENT_TOKEN
npm run worker:deploy
```

自定义域名：在 `wrangler.jsonc` 里加 route，例如：

```jsonc
"routes": [
  { "pattern": "cv.example.com/*", "zone_name": "example.com" }
]
```

`npm run worker:deploy` 会先跑 `worker:prepare`，把 `src/dashboard.html` 复制到 `worker/public/index.html` 作为 Workers 静态资源。npm 脚本用 `npx wrangler`，无需全局安装 Wrangler。

## 2. 安装 agent 插件

每个 agent 都有一行安装器：写 `~/.cultivagent/config.json`（endpoint + token + 可选 username）、clone 仓库、注册插件。重跑安全（幂等）。管道方式（`curl | bash`）非交互——用 env / 已有配置 / 默认值。

> Windows：请在 **git-bash**（Git for Windows）下运行安装器。

对已有线上服务，先设置共享配置，再跑 agent 安装器：

```bash
export CULTIVAGENT_ENDPOINT=https://cv.jthewl.cc
export CULTIVAGENT_TOKEN=<线上服务的 token>
export CULTIVAGENT_USERNAME=<机器标签>
```

Claude Code 和 Codex 安装器都读这些 env 并写同一份 `~/.cultivagent/config.json`。文件已存在时，重跑安装器会保留已有配置，除非交互式重新配置。

### Claude Code

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/claude-code/setup-helper/install.sh)
```

从仓库根手动安装：`claude plugin marketplace add ./plugins` → `claude plugin install claude-code@cultivagent-plugins-local`。Stop hook 跑会话采集器上报 JSONL 用量，所以安装器默认不往 `~/.claude/settings.json` 写 OTel 变量。升级后重跑安装器同步 `~/.cultivagent/repo` 下的已装副本。见 [plugins/claude-code/README.md](../plugins/claude-code/README.md)。

### Codex

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)
```

Codex 0.130 不注入 plugin-root env 变量，安装器复制插件并把 `__CULTIVAGENT_PLUGIN_ROOT__` 渲染成绝对路径。Stop hook 跑会话采集器上报用量，所以默认不写 `[otel]`。升级后重跑安装器；它会先 `codex plugin remove` 再 `add`，刷新 Codex 的版本化插件缓存。见 [plugins/codex/README.md](../plugins/codex/README.md)。

安装后重启 agent 应用 / CLI，让 hook 生效。

Codex 安装后的快速检查：

```bash
codex plugin add codex@cultivagent-plugins-local --json
node ~/.cultivagent/codex-marketplace/codex/scripts/session-collector.mjs --lookback-minutes 10 --include-incomplete --dry-run --json
```

已装的 Codex 形态应与 `plugins/codex/README.md` 一致：一条 Stop hook 命令（`hook.mjs stop`），采集器在 `hook.mjs` 内以 `--delay-ms 3000 --include-incomplete` 启动。

Claude Code 检查：

```bash
node ~/.cultivagent/repo/plugins/claude-code/scripts/status.mjs
claude plugin list | grep cultivagent
```

Claude Code 本地 marketplace 插件若改动但未升版本号，刷新已装缓存：

```bash
claude plugin marketplace update cultivagent-plugins-local
claude plugin uninstall claude-code@cultivagent-plugins-local
claude plugin install claude-code@cultivagent-plugins-local
```

### OpenCode

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/opencode/install.sh)
```

把插件路径追加到 `~/.config/opencode/opencode.json`。见 [plugins/opencode/README.md](../plugins/opencode/README.md)。

OpenCode 用量回补：

```bash
node ~/.cultivagent/repo/plugins/opencode/session-collector.mjs
```

### Pi

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/pi/install.sh)
```

加一个 `pi()` shell wrapper（或用 `pi -e <file>` / package.json `pi.extensions`）。见 [plugins/pi/README.md](../plugins/pi/README.md)。

### OpenClaw

原生插件入口（TypeScript，需构建）。见 [plugins/openclaw/README.md](../plugins/openclaw/README.md)。

### Locus

Locus 集成是只读采集器。不修改 Locus、不往 Locus 装 hook；只读本地 `locus.db`，把已完成的
`usageUpdate` 行以 `source_agent: "locus"` 上报。

```bash
node plugins/locus/session-collector.mjs --dry-run --json
node plugins/locus/session-collector.mjs --json
```

采集器用与其他插件相同的 `~/.cultivagent/config.json` 和 env 优先级。
自动发现会检查常见的 Locus 数据目录；需要时覆盖：

```bash
LOCUS_DB="D:/Apps/Locus/data/locus.db" node plugins/locus/session-collector.mjs --json
```

若做 Locus View 启动器，让 View 只启动/停止采集器并显示日志。关闭 View 不应停止
采集器；只有采集器自己的显式停止动作才杀进程。见 [plugins/locus/README.md](../plugins/locus/README.md)。

## 3. 配置优先级

所有插件按以下顺序解析 endpoint/token：env（`CULTIVAGENT_ENDPOINT` / `CULTIVAGENT_TOKEN`）> `~/.cultivagent/config.json` > `http://127.0.0.1:3737`（无 token）。

`username` 默认为本机 hostname。要为某台机器覆盖标签，设 `CULTIVAGENT_USERNAME` 或写进共享配置：

```json
{
  "endpoint": "https://cultivagent.example.com",
  "token": "<服务端 token>",
  "username": "workstation"
}
```

## API

```bash
curl http://127.0.0.1:3737/api/health

curl -X POST http://127.0.0.1:3737/ingest \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CULTIVAGENT_TOKEN" \
  -d '{"source_agent":"codex","event_type":"model_response","usage":{"input_tokens":10,"output_tokens":3}}'
```

端点：`POST /ingest`、`POST /otel/v1/logs`、`POST /otel/v1/metrics`、`GET /api/events`、`GET /api/daily`、`GET /api/agents`、`GET /api/pool`、`GET /api/usage/*`、`POST /api/login`、`POST /api/logout`。
