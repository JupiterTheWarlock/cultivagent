# Cultivagent 文档库

> [English](./README.md) · [中文](./README.zh.md)

安装、部署、接入、理解 Cultivagent 所需的一切。

## 从这里开始

| 文档 | 内容 |
|---|---|
| [安装指引](./INSTALL.zh.md) | 服务端、鉴权、Cloudflare Worker、以及每个 agent 插件（Claude Code、Codex、OpenCode、Pi、OpenClaw、Locus）。 |
| [Ubuntu / systemd](./UBUNTU.zh.md) | 最小化 VPS 部署：systemd 单元 + 反向代理。 |

## 概念

| 文档 | 内容 |
|---|---|
| [产品规格](./SPEC.zh.md) | 目标、规范化事件结构、token 计数规则。 |
| [Loop Events](./LOOP_EVENTS.zh.md) | 规范的 agent 循环，以及各厂商 hook → 规范事件的映射表。 |
| [Dyson 游戏面板](./DYSON_GAME_UI.zh.md) | 游戏化 `/dyson` 可视化的设计规格——恒星、云、行星、结构、验收标准。 |

## 内部实现

| 文档 | 内容 |
|---|---|
| [插件架构](./PLUGIN_SPEC.zh.md) | 仓库布局、鉴权加固、`~/.cultivagent/config.json`、各 agent 的 marketplace + install.sh 契约。 |

## 其他资源

- 插件 README：[claude-code](../plugins/claude-code/README.md)、[codex](../plugins/codex/README.md)、[opencode](../plugins/opencode/README.md)、[pi](../plugins/pi/README.md)、[openclaw](../plugins/openclaw/README.md)、[locus](../plugins/locus/README.md)。
- API 端点与示例：见 [主 README](../README.zh.md#api)。
