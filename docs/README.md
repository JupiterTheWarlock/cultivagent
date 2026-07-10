# Cultivagent Docs

> [English](./README.md) · [中文](./README.zh.md)

Everything you need to install, deploy, connect, and understand Cultivagent.

## Start here

| Doc | What it covers |
|---|---|
| [Install Guide](./INSTALL.md) | Server setup, auth, Cloudflare Worker, and every agent plugin (Claude Code, Codex, OpenCode, Pi, OpenClaw, Locus). |
| [Ubuntu / systemd](./UBUNTU.md) | Minimal VPS deployment with a systemd unit and reverse proxy. |

## Concepts

| Doc | What it covers |
|---|---|
| [Product Spec](./SPEC.md) | Goals, the normalized event shape, and the token-counting rule. |
| [Loop Events](./LOOP_EVENTS.md) | The canonical agent loop and the vendor-hook → canonical mapping table. |
| [Dyson Game UI](./DYSON_GAME_UI.md) | Design spec for the gamified `/dyson` visualization — star, clouds, planets, structures, acceptance criteria. |

## Internals

| Doc | What it covers |
|---|---|
| [Plugin Architecture](./PLUGIN_SPEC.md) | Repo layout, auth hardening, `~/.cultivagent/config.json`, marketplace + install.sh contracts for each agent. |

## Other resources

- Plugin READMEs: [claude-code](../plugins/claude-code/README.md), [codex](../plugins/codex/README.md), [opencode](../plugins/opencode/README.md), [pi](../plugins/pi/README.md), [openclaw](../plugins/openclaw/README.md), [locus](../plugins/locus/README.md).
- API endpoints and examples: see the [main README](../README.md#api).
