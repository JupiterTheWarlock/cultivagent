# Dyson 发射轨迹设计约束（dev）

> **强制约束文档**。修改 `src/games/dyson.html` 的发射/轨迹/选点/粒子源/注入逻辑前必须读本文档。与 [../DYSON_GAME_UI.md](../DYSON_GAME_UI.md) 冲突时以本文档为准。

## 1. 云环与旋转

| 量 | 值 |
|---|---|
| `CLOUD_RADIUS_MIN` | 23 |
| `CLOUD_RADIUS_MAX` | 54 |
| 云环高度 | `±0.17 × radius` |

云粒子按黄道角 `θ` 增长方向公转。Three.js 的 `rotation.y = +θ` 与其相反，因此戴森结构必须使用 `rotation.y = -ωt`，与云环同向。

## 2. 每发只选一个最终目标

每发独立选择一个 **seed（最终目标点）**，不再存在 maneuver 或第二段：

- `radius ∈ [CLOUD_RADIUS_MAX - 8, CLOUD_RADIUS_MAX]`
- `height ∈ ±0.15 × radius`
- seed 黄道投影方向 = 发射行星黄道投影方向的精确反向（点积 `-1`，即 180° 对面）
- 每发由 `batch seed + shot index` 独立派生，禁止共享目标

## 3. 单段仿抛物线

粒子从行星球心出发，沿唯一一段仿抛物线直接落入 seed：

```
pos(t) = source + v0·t + g·t²,  t ∈ [0, 1]
```

- 禁止贝塞尔、圆弧、Hermite、分段机动或中途重选点
- `Δ = seed - source`
- 目标终速 `v_end = tangentFor(seed) × (sourceRadius + seedRadius) × TRANSFER_ARC_SCALE`
- 由 `pos(1)=seed`、`pos'(1)=v_end` 反解：`g = v_end - Δ`、`v0 = 2Δ - v_end`
- 终点切线严格等于 seed 的顺公转切线
- 全程黄道切线与当地顺公转切线点积为正
- 曲线半径不得小于 seed 半径，禁止从云环内侧穿出后再落回
- 总飞行时间保持 `9.6s`，与服务端 `shot_duration_seconds` 一致

## 4. 视觉

- 单颗粒子和短拖尾贯穿整段，不销毁重建
- 飞行中不淡出、无机动红闪
- 到达前短暂变白
- 到达 seed 时生成独立白色扩散大闪：约 `0.3s`，尺度 `1.4 → 22`
- 到达后在 seed 对应位置注入云粒子

## 5. 验收清单

- [ ] source = 行星球心
- [ ] 每发只有 seed，没有 maneuver、第二段或 `SHOT_PHASE1_RATIO`
- [ ] seed 位于行星黄道投影的 180° 对面
- [ ] 单段仿抛物线精确命中 seed
- [ ] 终点速度等于 seed 顺公转切线
- [ ] 飞行全程不逆行、不穿过 seed 半径内侧
- [ ] 到达大闪白，无机动红闪
- [ ] 戴森结构与云环同向旋转
- [ ] 多发独立选点

## 6. 实现锚点

| 约束 | 代码位置 |
|---|---|
| 180° 最终目标 | `dyson-trajectory.mjs`：`antipodalTarget` |
| 初速度 / 重力反解 | `dyson-trajectory.mjs`：`parabolaCoefficients` |
| 抛物线位置 / 切线 | `parabolaPoint` / `parabolaTangent` |
| 每发选点 | `shotSeedFor` + `buildShotTrajectory` |
| 单段位置 | `shotPosition` |
| 到达大闪 | `spawnArrivalFlash` + `updateArrivalFlashes` |
| 结构同向旋转 | `updateDysonShell`（`structureGroup.rotation.y = -ωt`） |
