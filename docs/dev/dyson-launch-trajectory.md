# Dyson 发射轨迹设计约束（dev）

> **强制约束文档**。修改 `src/games/dyson.html` 的发射/轨迹/选点/粒子源/注入逻辑前**必须**读本文档，并严格按其实现。偏离会导致弹道扭曲、横向射出、逆行入轨、与云环相交等问题。
>
> 与 [../DYSON_GAME_UI.md](../DYSON_GAME_UI.md) 的"发射几何"段配合阅读；本文档记录最新演进（每发独立选点、180° 对跖 maneuver、恒星重力仿抛物线、短顺行圆弧），与之冲突时以本文档为准。

## 1. 云环几何（圆柱体）

云环是一个**圆柱体**，不是平面圆环：

| 量 | 含义 | 值 |
|---|---|---|
| `CLOUD_RADIUS_MIN` | 内径 | 23 |
| `CLOUD_RADIUS_MAX` | 外径 | 54 |
| 云环高度 | y 范围 | ±`0.17 × radius`（约 ±5） |
| `CLOUD_ENTRY_RADIUS` | 机动点所在入轨壁半径 | `CLOUD_RADIUS_MAX + 3` = 57 |

云粒子按黄道角 `θ` 增长方向公转；Three.js 的 `rotation.y = +θ` 与其相反，因此戴森结构必须使用 `rotation.y = -ωt` 才能与云环同向。

## 2. 每发独立选点

**每发戴森云独立选点，禁止共享 `batchEntry.target`**（否则多发叠成一条线）。

每发选两个点：

1. **seed（最终目标点）**：云环外带一点 —— `radius ∈ [CLOUD_RADIUS_MAX - 8, CLOUD_RADIUS_MAX]`，`height ∈ ±0.15 × radius`
2. **机动点（第一段终点 / 入轨点）**：
   - 位于**入轨壁**（`radius = CLOUD_ENTRY_RADIUS`）
   - 黄道投影方向 = 行星黄道投影方向的**精确反向**（点积 `-1`，即绕恒星 180° 对面）
   - **高度 = seed 高度**，保证第二段运动平行黄道面
   - seed 位于 maneuver 的公转前方 `0.08–0.22 rad`（约 `4.6°–12.6°`）

## 3. 粒子源与初速度

- **无炮塔/炮口模型**（曾用 cylinder 炮口对齐 v0，但炮口粗、粒子细，角度差一点就显成"粒子穿炮壁"；已整体删除炮塔）。粒子**直接从星球球心出发**：`source = planetCenter`（无偏移）
- maneuver 直接由 `antipodalManeuver(source, seedHeight, 57)` 得出，禁止叠加预测角或候选角旋转
- `v0` 与有效恒星重力项 `g` 由 source、maneuver 和顺公转终速共同反解，不再用朝近处目标的启发式抬高
- 粒子在星球内部（不透明球面之后）自然被深度测试遮挡，穿出球面后显现，视觉上等同"从星球表面射出"

## 4. 第一段：仿抛物线（source → 机动点）

**抛物线 = 基础速度 `v0` + 有效恒星重力项 `g`**：

```
pos(t) = source + v0·t + g·t²
```

- **禁止**贝塞尔、圆弧、椭圆弧、七扭八歪的自由曲线
- `Δ = maneuver - source`
- 目标终速 `v_end = tangentFor(maneuver) × (sourceRadius + entryRadius) × TRANSFER_ARC_SCALE`
- 由 `pos(1)=maneuver`、`pos'(1)=v_end` 得：`g = v_end - Δ`、`v0 = 2Δ - v_end`
- 终点切线严格等于 maneuver 的顺公转切线，直接作为第二段起点切线，不倒车
- 全程黄道切线与当地顺公转切线点积为正，且曲线半径不得小于 57

## 5. 第二段：机动点 → seed

**第一段与第二段是同一个 obj 的连续移动**（一个 `shot`，progress `0 → 1`），**禁止"段一 obj 销毁 + 新建段二 obj"式的强制位移/重生**。段二在 progress 跨过 `SHOT_PHASE1_RATIO` 时切换：

- seed、maneuver、两端切线已在本发创建时固定；切换时禁止重新选点
- 机动闪红（见 §6）
- 位置函数从抛物线切到水平短圆弧

段二轨迹 = **水平面短顺行圆弧**（`horizontalOrbitArc`）：

- **同高度**（`y = maneuver.y = seed.y`，y 不变 → 平行黄道面）
- 黄道角从 maneuver 向顺公转方向线性增加 `0.08–0.22 rad`
- 半径从 57 用 `smoothstep` 收缩到 seed 半径；径向速度在起终点都为 0
- 起切线 = 段一终点切线，终切线 = seed 公转切线，**两端均 G1 连续**
- **禁止**直冲圆心、反向飞
- 总机动角度 < `30°`，禁止用 Hermite 强拽出掉头感

## 6. 颜色与视觉

- 机动瞬间（第一段→第二段切换）**闪烁红色** ~0.14s
- 到达 seed 瞬间生成独立白色扩散闪光：约 `0.3s`，尺度 `1.4 → 22`
- 飞行全程**颜色不变浅**（opacity 不淡出），仅闪烁时变色/提亮
- **单颗粒子 + 短拖尾贯穿两段**（同一个 `shot.projectile`/`shot.trail`，不销毁重建），非长轨迹线
- 入轨后云环在对应位置显现一颗云粒子（`commitCloudPoint`）

## 7. 验收清单

- [ ] 粒子从星球球心出发（无炮塔）
- [ ] 第一段是仿抛物线（v0 + 恒星重力），非贝塞尔/圆弧
- [ ] 第一段弹道不与云环圆柱体相交
- [ ] 第一段黄道切线全程顺公转，终速严格等于 maneuver 公转切线
- [ ] 机动点在入轨壁（半径 57）、位于行星 180° 对面、高度 = seed 高度
- [ ] 第二段终点速度水平、等于 seed 公转切线
- [ ] **同一个 obj 连续移动贯穿两段**，段一终点 = 段二起点，无销毁/重生/强制位移
- [ ] 第二段为 `0.08–0.22 rad` 的顺行短圆弧，无 Hermite 掉头
- [ ] 机动闪红 / 到达大闪白，飞行中不淡出
- [ ] 戴森结构与云环同向旋转
- [ ] 每发独立选点，多发不叠成一条线

## 8. 实现锚点

| 约束 | 代码位置 |
|---|---|
| 抛物线插值 | `dyson-trajectory.mjs`：`parabolaPoint` |
| 抛物线终点切线 | `dyson-trajectory.mjs`：`parabolaTangent(..., 1)` |
| 180° 对跖 maneuver | `dyson-trajectory.mjs`：`antipodalManeuver` |
| 初速度 / 重力反解 | `dyson-trajectory.mjs`：`parabolaCoefficients` |
| 粒子源（球心，无炮塔）| `spawnCloudShot`（`source = planetCenter`）|
| 每发选点 | `shotSeedFor` + `buildShotTrajectory` + `spawnCloudShot` |
| 行星视觉（颜色/状态环/大气/轨道）| `updatePlanetVisual` |
| 切线同向公转 | `dyson-trajectory.mjs`：`tangentFor`（`radial × (0,1,0)`） |
| 单 obj 两段位置 | `shotPosition`（段一抛物线 / 段二 `horizontalOrbitArc`） |
| 段二短顺行圆弧 | `dyson-trajectory.mjs`：`horizontalOrbitArc` |
| 切换段二 | `updateShots`（progress ≥ `SHOT_PHASE1_RATIO`，只切 phase + 闪红，不重选 seed） |
| 到达大闪 | `spawnArrivalFlash` + `updateArrivalFlashes` |
| 结构同向旋转 | `updateDysonShell`（`structureGroup.rotation.y = -ωt`） |
