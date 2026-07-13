# Agent Notes

## Codex Session Collector

When fixing or installing the Codex adapter, keep the flow boring and identical:

1. Source files live under `plugins/codex/`; do not make repo changes directly in `~/.codex/plugins/cache`.
2. `plugins/codex/hooks/hooks.json` Stop must stay a single command:
   `node __CULTIVAGENT_PLUGIN_ROOT__/scripts/hook.mjs stop`.
   Do not add a second Stop hook for the collector; Codex skips new untrusted hook commands until the user reviews them.
3. `plugins/codex/scripts/hook.mjs` launches `session-collector.mjs` from inside that trusted Stop command with:
   `--delay-ms 3000 --lookback-minutes 60 --include-incomplete --batch-size 10`.
4. `plugins/codex/setup-helper/install.sh` must copy the plugin to `~/.cultivagent/codex-marketplace/codex`, render `__CULTIVAGENT_PLUGIN_ROOT__`, then `codex plugin remove` and `codex plugin add` to refresh Codex's versioned cache.
5. Checks before claiming fixed:
   `bash -n plugins/codex/setup-helper/install.sh`
   `node --check plugins/codex/scripts/hook.mjs`
   `node --check plugins/codex/scripts/session-collector.mjs`
   `npm run smoke`

Do not commit local tokens, `~/.cultivagent/config.json`, `.wrangler/`, or Codex cache files.

## Dyson 发射系统

修改 `src/games/dyson.html` 的发射轨迹、选点、粒子源、注入、闪烁逻辑前，**必须**先读 [docs/dev/dyson-launch-trajectory.md](docs/dev/dyson-launch-trajectory.md) 并严格按其约束实现。

文档固化了硬性约束：每发只选一个位于行星黄道投影 180° 对面的最终 seed；粒子从行星球心沿单段仿抛物线直接命中，终速顺公转；禁止 maneuver、第二段机动、圆弧/Hermite 和红闪；到达大闪白。

改完跑 `npm run smoke` 验证加载，再 `npm run worker:deploy` 部署。
