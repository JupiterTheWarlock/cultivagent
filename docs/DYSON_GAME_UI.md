# Dyson Game UI Design

> [English](./DYSON_GAME_UI.en.md) · [中文](./DYSON_GAME_UI.md)

本文件记录 cultivagent 游戏化状态面板的产品和视觉要求。它是后续实现与验收标准，不是插件市场设计。

## 目标

cultivagent 需要一个游戏化面板，用来检视 agent 状态、token 消耗和 hook 驱动的状态机。

第一套画面是戴森球系统：

- 恒星代表 cultivagent 今日总体活动。
- 戴森云代表今日 token 消耗。
- 每个 agent 是一颗行星，围绕恒星公转。
- agent 行星从球心向恒星附近的戴森云环发射戴森云，球体自身负责遮挡内部段。
- hook 事件驱动 agent 状态机，状态机驱动行星表面、状态环、大气、光效和 UI 反馈。

工程上要模块化、可替换：以后可以把 Dyson 画面换成别的游戏画面。但这不是 marketplace plugin，也不是外部插件系统；它是 cultivagent 服务端内部的显示模块架构。

## 数据模型

数据根基来自 hook/OTel/adapter 记录。原始 hook 不直接等于产品状态，必须先归一化成 [LOOP_EVENTS.md](./LOOP_EVENTS.md) 中的 canonical loop event 和 agent status。

token 只来自完成的模型请求或官方 usage 面，不从生命周期 hook 编造。

当前 Dyson 换算：

- `100 tokens = 1 Dyson cloud`
- `10,000,000 tokens = 1 Dyson structure block`
- 一个 1w token 的测试请求应产生 `100` 个待发射 cloud。
- 待发射池按 agent 分开累计。
- 默认发射速率是 `10 clouds/s`，直到本批待发射池清空。
- 禁止无请求时自动匀速发射。

刷新页面或部署后，服务端已存储的 token、agent、状态、结构和发射批次数据不能丢失。飞行中粒子不逐颗存储，但必须能从服务端批次、时间戳、速率、入口种子重新构建同一条发射链。

## 服务端 Dyson 状态

Dyson 画面不应该自己发明真相。客户端只渲染服务端给出的状态：

- 今日总 tokens、总 Dyson clouds、free clouds、structure blocks。
- 每个 agent 的状态机状态、累计 clouds、待发射 clouds、当前批次。
- 当前批次的 `batch_id`、`started_at`、`cloud_count`、`shot_count`、`emitted_clouds`、`emit_rate`、`entry_seed`、`launch_seed`、`phase`。
- 服务端当前时间 `server_now`，客户端用它重建当前已经发射到哪一颗、飞行中粒子的位置和拖尾。

最小实现优先用现有 `events` + `agent_state` 计算 `GET /api/dyson/state?day=YYYY-MM-DD`，不先加后台 tick 进程。同一 agent 在 10 秒窗口内的 usage 合并为一个确定性批次，首个 `event_id + agent_key` 决定批次 ID 和随机种子；批次按时间顺序发射。每批最多使用 100 个加权视觉粒子，因此单批最多发射 10 秒，同时 `cloud_value` 保留完整 cloud 计数。发射阶段为 `queued → emitting → coasting → settled`，与 agent 工作状态分开。

非终态 agent 状态超过 5 分钟没有新事件时按 `idle` 渲染；延迟到达的旧事件不得覆盖较新的 `agent_state`。

只有当需要暂停、手动重放、跨天续播或修正批次几何时，才新增持久表，例如 `dyson_batches(day, agent_key, batch_id, event_id, cloud_count, started_at, emit_rate, entry_seed, launch_seed)`。不要逐颗存粒子；粒子是 `batch + index + server_now` 的派生表现。

## 模块边界

Dyson UI 是 cultivagent dashboard 的一个内部游戏视图。

要求：

- Node 本地服务和 Worker 部署都能访问，例如 `/dyson`。
- Three.js 渲染只负责表现，不负责 token 统计真相。
- 数据适配层负责把 server API/hook summary 转成 game state。
- game renderer 负责把 game state 映射成 Three.js 场景。
- 后续可增加其他 game renderer，但现在只做 Dyson。

非目标：

- 不接入 plugin marketplace。
- 不做 agent 可调用工具。
- 不做 MCP。
- 不为“以后可能有很多游戏”提前做复杂框架。

## 场景布局

恒星位于中心。

戴森云环在恒星附近，类比水星/金星轨道范围，不允许远到像奥尔特云。云环外径是行星轨道的内边界：离恒星最近的行星也必须在云环外径之外。

行星要求：

- 每个 agent 一颗行星。
- 行星绕恒星公转。
- 行星公转方向必须与戴森云环公转方向一致。
- 行星不要偏离黄道面太远，只允许轻微倾角。
- 行星之间可以分散一些，方便鼠标预览和选择。

云环要求：

- 云环整体是一片星环状、弥散的粒子云。
- 不允许变成一条条固定点线或轨道线。
- 新入轨的云应选择就近且适配当前粒子分布的目标点，让整体仍然像云团。

## 发射几何

这是硬性验收规则。

粒子源：

- 不使用炮塔/炮口模型。
- 粒子直接从行星球心出发，在不透明球体内部由深度测试遮挡，穿出球面后可见。
- 初速度由本发 maneuver 决定，禁止使用批次开始时的旧行星位置。

批次规则：

- 每发使用 `batch seed + shot index` 独立选 seed 和 maneuver，禁止共享批次入口。
- 先固定 seed，再反推同高度、半径 57 的 maneuver。
- 大批次可用加权视觉粒子，但逻辑 cloud 总数必须守恒。

第一段飞行：

- 第一段从行星球心开始，到达半径 57 的 maneuver。
- 第一段是 `v0 + t² × 恒星方向重力` 的仿抛物线，禁止贝塞尔和圆弧。
- 第一段必须精确命中 maneuver，全程位于云环外壁之外，不与云环圆柱体相交。
- 第一段全程切线的黄道面投影与最近环切线叉积 y 必须为正；候选失败必须换点，禁止无约束 fallback。

入轨点：

- maneuver 固定在 `CLOUD_ENTRY_RADIUS = 57`。
- maneuver 高度必须严格等于本发 seed 高度。

第二段飞行：

- 粒子到达入轨点后进入二次推进。
- 二段推进方向在黄道面投影上，也必须与该处云环切线速度方向夹角小于 `30°`。
- 二段推进必须向公转前方走，不允许直冲圆心，也不允许反向飞。
- 第二段使用水平 cubic Hermite，起切线承接第一段终点，终切线等于 seed 公转切线。
- 同一个 projectile/trail 连续通过两段，禁止销毁重建或瞬移。

入云表现：

- 发射粒子是单颗粒子，带短拖尾。
- 拖尾不是持续绘制的长轨迹线。
- 飞行中不淡出；机动闪红，到达闪白。
- 粒子进入云环后，云环粒子系统在对应射入位置生成/显现一颗云粒子。
- 这个显现过程要 lerp，看起来像粒子切线入轨并加入公转。

## 戴森云与结构

戴森云：

- 一个 cloud 代表 100 tokens。
- 粒子数量要可承受大量数据。
- 云环最大表现目标是百万级粒子；当数据继续增长时，通过结构凝结避免无限增长。

结构块：

- 一个 structure block 代表 10,000,000 tokens。
- 结构块来自戴森云凝结，不是随便画的轨道线。
- 结构视觉参考《戴森球计划》的戴森球结构。
- 结构要围绕恒星生成。
- 每个结构块都必须面向恒星。
- 结构块之间必须相邻、严丝合缝，不能散乱拼接。
- 结构整体可采用足球/蜂巢式拓扑。
- 每个结构中间需要镂空，形成蜂巢孔状块。
- 禁止用绕恒星的细线/轨道线冒充结构。

## 状态机表现

状态来源是 hook 构建的 agent 状态机。

基础状态沿用 [LOOP_EVENTS.md](./LOOP_EVENTS.md)：

- `idle`
- `receiving_input`
- `loading_context`
- `thinking`
- `streaming`
- `tool_calling`
- `waiting_approval`
- `waiting_user`
- `compacting`
- `delegating`
- `finalizing`
- `done`
- `error`

视觉要求：

- 状态表现不能只靠丑陋的文字或单色环。
- 行星表面、状态环和大气应通过颜色、脉冲节奏或活动效果表达状态。
- `thinking` 可以表现为工厂预热/脉冲。
- `streaming` 可以表现为稳定能流。
- `tool_calling` 可以表现为工厂高亮或多点活动。
- `waiting_approval` / `waiting_user` 要有明确的等待/阻塞感。
- `error` 要明显区别于正常高活动状态。

## 交互

鼠标操作要适合空间预览：

- 悬浮恒星显示总体信息和 agent 状态摘要。
- 悬浮行星显示该 agent 名字、来源 agent、模型/状态、token/云/待发射数据。
- 左键常规旋转视角。
- 右键或常用手势平移视角。
- 中键/滚轮自由缩放。
- 双击或明确操作可重置视角。

调试窗口必须保留：

- 选择 agent。
- 输入 token 数。
- 触发一次 usage 请求，例如 1w token。
- 触发纯视觉发射测试。
- 触发结构凝结测试。
- 切换 agent 状态机状态。
- 显示当前测试批次、待发射云数量和发射速率。

## 验收清单

发射验收：

- 点击 1w token 请求后，对应 agent 产生 100 个待发射 cloud。
- 发射速率约为 10 clouds/s。
- 没有请求时不自动发射。
- 每发独立选点，多发不叠成同一条线。
- 粒子从行星球心出发，穿出球面后可见。
- 第一段为仿抛物线，精确命中半径 57 且不穿过云环圆柱。
- 第一段全程叉积为正，第二段起始推进与云环切线夹角小于 30°。
- 粒子入轨方向与云环公转方向一致。

布局验收：

- 行星与云环同向公转。
- 行星基本贴近黄道面。
- 最近行星仍在云环外径之外。
- 戴森云是一片弥散星环，不是固定线阵。

结构验收：

- 结构块面向恒星。
- 结构块相邻拼合。
- 结构中间镂空。
- 视觉上是蜂巢/足球式壳层，不是散乱片或轨道线。

持久化验收：

- 刷新页面后，历史 token、cloud、structure、agent 状态从服务端恢复。
- 刷新不应该把已统计数据清零。
