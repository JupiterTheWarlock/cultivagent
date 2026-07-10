# Dyson 发射轨迹设计约束（dev）

> **强制约束文档**。修改 `src/games/dyson.html` 的发射/轨迹/选点/炮口/注入逻辑前**必须**读本文档，并严格按其实现。偏离会导致弹道扭曲、横向射出、逆行入轨、与云环相交等问题。
>
> 与 [../DYSON_GAME_UI.md](../DYSON_GAME_UI.md) 的"发射几何"段配合阅读；本文档记录最新演进（每发独立选点、仿抛物线、垂直选点、切线叉积为正），与之冲突时以本文档为准。

## 1. 云环几何（圆柱体）

云环是一个**圆柱体**，不是平面圆环：

| 量 | 含义 | 值 |
|---|---|---|
| `CLOUD_RADIUS_MIN` | 内径 | 23 |
| `CLOUD_RADIUS_MAX` | 外径 | 54 |
| 云环高度 | y 范围 | ±`0.17 × radius`（约 ±5） |
| `CLOUD_ENTRY_RADIUS` | 机动点所在入轨壁半径 | `CLOUD_RADIUS_MAX + 3` = 57 |

## 2. 每发独立选点

**每发戴森云独立选点，禁止共享 `batchEntry.target`**（否则多发叠成一条线）。

每发选两个点：

1. **seed（最终目标点）**：云环内一点 —— `radius ∈ [CLOUD_RADIUS_MIN, CLOUD_RADIUS_MAX]`，`height ∈ ±云环高度`，角度 `α_seed`
2. **机动点（第一段终点 / 入轨点）**：
   - 位于**入轨壁**（`radius = CLOUD_ENTRY_RADIUS`）
   - **高度 = seed 高度**（垂直选点：在最终目标点对应高度的外径壁上取点，保证第二段运动平行黄道面）
   - 角度 `α_m` 选在 seed 的公转前方，使第二段终点切线能顺接 seed 的公转切线

## 3. 粒子源与初速度

- **无炮塔/炮口模型**（曾用 cylinder 炮口对齐 v0，但炮口粗、粒子细，角度差一点就显成"粒子穿炮壁"；已整体删除炮塔）。粒子**直接从星球球心出发**：`source = planetCenter`（无偏移）
- 初速度 `v0` **随机动点变化**（每发独立）：`v0 = launchDirFor(source, maneuver)`，其中 `maneuver = entry.target`
- **机动点直接取 `entry.target`，禁止再叠加任何预测角旋转**（曾用 `applyAxisAngle(Y, keplerSpeed×duration)` 把机动点甩到行星前方 46°–99°，14 步候选角度全被打散，弹道看起来乱飞、落点不在圆环上）
- 粒子在星球内部（不透明球面之后）自然被深度测试遮挡，穿出球面后显现，视觉上等同"从星球表面射出"

## 4. 第一段：仿抛物线（source → 机动点）

**抛物线 = 基础速度 `v0` + 恒星重力**（重力方向指向恒星原点）：

```
pos(t) = source + a·t·v0 + b·t²·(指向恒星)
```

- **禁止**贝塞尔、圆弧、椭圆弧、七扭八歪的自由曲线
- 起点切线（t=0）= `v0`（即炮口方向，天然满足）
- `v0` 在目标方向上叠加**水平向外**的抬高量（朝 `source.xz.normalize()` 偏移 `distance × ARC_RISE`，**不含 y 分量**），保证弹道是半抛物线（不先升）、**开头沿炮口方向直出**；否则抬高含 y 会让开头斜向上扭
- 终点切线（t=1）由抛物线决定，作为第二段起点切线（顺接，不倒车）
- **切线叉积约束**：抛物线全程，切线在黄道面（xz 平面）的投影，与**该投影点距离最近的云环点**的切线方向，**叉积 y 分量为正**（即弹道切线在环切线的逆时针侧，与公转同向，不逆行）
- **不相交约束**：弹道曲线不得与云环圆柱体（`radius ∈ [CLOUD_RADIUS_MIN, CLOUD_RADIUS_MAX]` 且 `|y| ≤ 云环高度`）相交；通过调整 `v0` 方向/大小（抬高量、初速度权重）搜索最优路径

## 5. 第二段：机动点 → seed

**第一段与第二段是同一个 obj 的连续移动**（一个 `shot`，progress `0 → 1`），**禁止"段一 obj 销毁 + 新建段二 obj"式的强制位移/重生**。段二在 progress 跨过 `SHOT_PHASE1_RATIO` 时切换：

- 解析 seed 落点（`nextCloudTarget`），得到 `shot.seed` 与 `shot.tangentSeed`
- 机动闪红（见 §6）
- 位置函数从抛物线切到水平 Hermite

段二轨迹 = **水平面 cubic Hermite**（`horizontalHermite`）：

- **同高度**（`y = maneuver.y = seed.y`，y 不变 → 平行黄道面）
- 起切线 = 段一终点切线投影到水平面（`tangentManeuver`）→ **与段一 G1 连续**，无折角
- 终切线 = seed 处公转切线（`tangentSeed = tangentFor(seedRadial)`，叉积为正，顺公转入轨）
- **禁止**直冲圆心、反向飞
- 机动角度 < `30°`（推进方向与该处云环切线速度方向的夹角）
- 若直线无法到达，Hermite 自然内弯到 seed（等价于"先并入公转半径再切到目标"）

## 6. 颜色与视觉

- 机动瞬间（第一段→第二段切换）**闪烁红色** ~0.14s
- 到达 seed 瞬间**闪烁白色** ~0.14s
- 飞行全程**颜色不变浅**（opacity 不淡出），仅闪烁时变色/提亮
- **单颗粒子 + 短拖尾贯穿两段**（同一个 `shot.projectile`/`shot.trail`，不销毁重建），非长轨迹线
- 入轨后云环在对应位置显现一颗云粒子（`commitCloudPoint`）

## 7. 验收清单

- [ ] 粒子从星球球心出发（无炮塔），初速度 = `v0` = `launchDirFor(球心, 机动点)`
- [ ] 第一段是仿抛物线（v0 + 恒星重力），非贝塞尔/圆弧
- [ ] 第一段弹道不与云环圆柱体相交
- [ ] 弹道切线（黄道面投影）与最近环切线叉积为正（顺公转）
- [ ] 机动点在入轨壁（半径 57）、高度 = seed 高度
- [ ] 第二段终点速度水平、等于 seed 公转切线
- [ ] **同一个 obj 连续移动贯穿两段**，段一终点 = 段二起点，无销毁/重生/强制位移
- [ ] **机动点不被预测角旋转**，落点在入轨壁圆环上
- [ ] 机动角度 < 30°
- [ ] 机动闪红 / 到达闪白，飞行中不淡出
- [ ] 每发独立选点，多发不叠成一条线

## 8. 实现锚点

| 约束 | 代码位置 |
|---|---|
| 抛物线插值 | `parabolaLerp(a, b, vDir, t)` |
| 抛物线终点切线 | `parabolaLerpEndTangent(a, b, vDir)` |
| 初速度抬高 | `launchDirFor(source, maneuver)` + `ARC_RISE` |
| 粒子源（球心，无炮塔）| `spawnCloudShot`（`source = planetCenter`）|
| 每发选点 | `cloudEntryFor` + `spawnCloudShot` |
| 行星视觉（颜色/状态环/大气/轨道）| `updatePlanetVisual` |
| 切线同向公转 | `tangentFor`（`radial × (0,1,0)`） |
| 单 obj 两段位置 | `shotPosition`（段一抛物线 / 段二 `horizontalHermite`） |
| 段二水平 Hermite | `horizontalHermite`（G1 顺接 + 终切线 = seed 公转切线） |
| 切换段二 + 解析 seed | `updateShots`（progress ≥ `SHOT_PHASE1_RATIO`）+ `nextCloudTarget` |
| 颜色闪烁 / 缩放 | `updateShotAppearance`（机动闪红 / 到达闪白 / 段二收尾缩小） |
