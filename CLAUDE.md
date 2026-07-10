# Cultivagent

Coding agent hook & token usage monitor。Node 本地服务 + Cloudflare Worker 部署。

## 开发约束

### Dyson 发射系统（强制）

修改 `src/games/dyson.html` 的**发射轨迹、选点、粒子源、注入、闪烁**逻辑前，**必须**先读 [docs/dev/dyson-launch-trajectory.md](docs/dev/dyson-launch-trajectory.md)，严格按其约束实现。

该文档固化了硬性几何约束：

- 仿抛物线弹道（基础速度 `v0` + 恒星重力），**非**贝塞尔/圆弧
- 每发独立选点（不共享 `batchEntry.target`）
- 机动点在入轨壁（半径 `CLOUD_ENTRY_RADIUS`）、高度 = seed 高度（垂直选点）
- 弹道切线（黄道面投影）与最近环切线**叉积为正**（顺公转入轨）
- 不与云环圆柱体相交
- 无炮塔/炮口模型，`source = planetCenter`，粒子在球体内部由深度测试遮挡
- 机动闪红 / 到达闪白，飞行中不淡出

偏离文档会复发：弹道扭曲、横向射出、逆行入轨、与云环相交、连成一线。

### 其他

- 通用开发约束见 [AGENTS.md](AGENTS.md)
- Dyson 产品/视觉要求见 [docs/DYSON_GAME_UI.md](docs/DYSON_GAME_UI.md)
- 部署：`npm run worker:deploy`（OAuth；若 env 有 stale `CLOUDFLARE_API_TOKEN` 会报 10000 鉴权错，清掉再用 OAuth）
