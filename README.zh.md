# Cultivagent

> 自托管、隐私优先的 AI 编程 Agent 监控 —— 一个面板，看尽每一个 hook、每一颗 token、每一个 agent。

[English](./README.md) · [中文](./README.zh.md)

---

Cultivagent 是一个**纯被动**的 hook 与 token 接收端。把各 agent 的 hook 指过来，它就会收集、归一化、可视化 Claude Code、Codex、OpenCode、Pi、OpenClaw、Locus 的全部活动——全部汇总到一个自托管面板。

不存储任何 prompt、命令、文件内容或工具输出。**无 MCP、无供 agent 调用的接口**——agent 只能往 `/ingest` POST 事件，不能读取、查询或篡改监控本身，因此用量数据始终如实。

## 为什么选 Cultivagent

- **一个面板看所有 agent。** 不再在各个厂商仪表盘之间来回切换。每个 agent 的生命周期、token、成本都汇入一条时间线。
- **设计上保护隐私。** 只存元数据和 token 计数——绝不存你的代码或对话。
- **Agent 无法作弊。** 因为是只写接收端，没有任何 agent 能读取或篡改关于自己的记录。
- **自托管，数据归你。** 本地用 Node.js + SQLite 即可跑；也可部署到 Cloudflare Worker + D1 做带鉴权的线上面板。
- **一个看得开心的面板。** Token 用量驱动一个实时**戴森球**可视化——agent 是行星，token 化作戴森云，里程碑凝结成结构块。见 [Dyson 游戏面板](./docs/DYSON_GAME_UI.zh.md)。

## 特性

- **多 agent 接收** —— Claude Code、Codex、OpenCode、Pi、OpenClaw 的 hook；Locus 只读采集器。
- **规范化的 loop event** —— 各厂商原始 hook 名翻译成一致的循环模型（`input.received`、`model.request.start`、`tool.before`、`agent.end`……）。见 [Loop Events](./docs/LOOP_EVENTS.zh.md)。
- **诚实的 token 计数** —— 只从已完成的模型响应或官方 usage 接口计数，绝不拿生命周期 hook 编造。
- **每日汇总 + 最近事件池** —— 每日 token 总量与最近事件 TTL 池供实时检视。
- **游戏化戴森视图** `/dyson` —— 用 Three.js 把今日活动实时渲染成星系。
- **远程部署鉴权** —— Bearer token、`x-cultivagent-token` 头、或面板登录 cookie（timing-safe、30 天、HTTPS）。
- **共享 agent 配置** —— 一份 `~/.cultivagent/config.json` 驱动一台机器上的全部插件。

## 快速开始

需要 Node.js 24+。

```bash
git clone https://github.com/JupiterTheWarlock/cultivagent.git
cd cultivagent
npm start
```

打开 http://127.0.0.1:3737 —— 主面板。戴森视图在 http://127.0.0.1:3737/dyson。

跑内置检查：

```bash
npm run smoke      # 服务端端点冒烟
npm run cli-smoke  # 各 adapter 发 CLI 事件
```

完整安装（远程鉴权、Cloudflare Worker、systemd）→ **[安装指引](./docs/INSTALL.zh.md)**。

## 接入 Agent

每个 agent 都有一行安装器：写 `~/.cultivagent/config.json`、clone 仓库、注册插件。重跑安全（幂等）。

> Windows：请在 **git-bash**（Git for Windows 自带）下运行安装器。

| Agent | 一行安装 | 文档 |
|---|---|---|
| Claude Code | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/claude-code/setup-helper/install.sh)` | [claude-code](./plugins/claude-code/README.md) |
| Codex | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/codex/setup-helper/install.sh)` | [codex](./plugins/codex/README.md) |
| OpenCode | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/opencode/install.sh)` | [opencode](./plugins/opencode/README.md) |
| Pi | `bash <(curl -fsSL https://raw.githubusercontent.com/JupiterTheWarlock/cultivagent/main/plugins/pi/install.sh)` | [pi](./plugins/pi/README.md) |
| OpenClaw | 原生插件入口（需构建） | [openclaw](./plugins/openclaw/README.md) |
| Locus | 只读会话采集器 | [locus](./plugins/locus/README.md) |

要先把所有 agent 指向线上服务：

```bash
export CULTIVAGENT_ENDPOINT=https://your-host.example.com
export CULTIVAGENT_TOKEN=<服务端的 token>
export CULTIVAGENT_USERNAME=<机器标签>
```

## 部署

**本地**（默认，无鉴权）：`npm start` → http://127.0.0.1:3737

**VPS / 局域网**（Node + 鉴权）：生成 token，开启登录。
→ [Ubuntu / systemd 指引](./docs/UBUNTU.zh.md)

**Cloudflare Worker + D1**：同样的面板与 API，全球边缘节点，D1 存储。
→ [安装指引中的 Worker 部署](./docs/INSTALL.zh.md#cloudflare-worker--d1-部署)

## 文档

完整文档库在 [`docs/`](./docs/)。从 **[文档索引](./docs/README.zh.md)** 开始，或直达：

- [安装指引](./docs/INSTALL.zh.md) —— 服务端、鉴权、Cloudflare Worker、agent 插件
- [Loop Events](./docs/LOOP_EVENTS.zh.md) —— 规范事件模型与各厂商 hook 映射
- [Dyson 游戏面板](./docs/DYSON_GAME_UI.zh.md) —— 游戏化可视化设计规格
- [产品规格](./docs/SPEC.zh.md) —— 目标、规范化事件结构、计数规则
- [插件架构](./docs/PLUGIN_SPEC.zh.md) —— 仓库布局、鉴权模型、插件契约
- [Ubuntu / systemd](./docs/UBUNTU.zh.md) —— VPS 反向代理部署

## API

```bash
# 健康检查（匿名，始终公开）
curl http://127.0.0.1:3737/api/health

# 接收一个 hook 事件
curl -X POST http://127.0.0.1:3737/ingest \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CULTIVAGENT_TOKEN" \
  -d '{"source_agent":"codex","event_type":"model_response","usage":{"input_tokens":10,"output_tokens":3}}'
```

端点：`POST /ingest`、`POST /otel/v1/logs`、`POST /otel/v1/metrics`、`GET /api/events`、`GET /api/daily`、`GET /api/agents`、`GET /api/pool`、`GET /api/usage/*`、`GET /api/dyson/state`、`POST /api/login`、`POST /api/logout`。

## 许可证

MIT
