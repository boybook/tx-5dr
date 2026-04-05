# Server 启动与电台链路架构

**适用范围**: `packages/server`
**目标**: 让启动流程、电台连接 bootstrap、事件投影的职责边界稳定且可复用。

## 1. 总览

Server 侧的启动与电台链路固定分成 4 层：

| 层 | 主入口 | 负责 | 不负责 |
|---|---|---|---|
| Facade | `DigitalRadioEngine` | 装配组件、阶段化初始化、对外 API、模式切换 | 资源细节、电台 bootstrap、UI 事件投影 |
| Lifecycle | `EngineLifecycle` | 资源蓝图、启动/停止顺序、状态机、回滚 | 连接后的频率恢复、能力初始化 |
| Radio Session | `PhysicalRadioManager` | 连接会话、保守 bootstrap、后台任务激活、统一电台控制 | 引擎资源顺序、前端状态广播 |
| Projection | `RadioBridge` | 把电台状态投影到 `engineEmitter`、断线恢复运行态 | 连接后写频、连接预热、底层 CAT 命令 |

一句话判断：

- “这段逻辑是在组装系统吗？”→ `DigitalRadioEngine`
- “这段逻辑是在定义资源怎么启动吗？”→ `EngineLifecycle`
- “这段逻辑是在连接刚建立后和电台对话吗？”→ `PhysicalRadioManager`
- “这段逻辑是在把状态告诉外界吗？”→ `RadioBridge`

## 2. 启动时序

### 2.1 Server 初始化

1. `server.ts` 调用 `DigitalRadioEngine.initialize()`
2. `DigitalRadioEngine` 按固定 phase 初始化：
   - `runtime`: 时钟、调度器、频谱底座
   - `domain-services`: operator / PSKReporter 等领域服务
   - `subsystem-assembly`: `ClockCoordinator` / `VoiceSessionManager` / `EngineLifecycle`
   - `restore-mode`: 恢复上次 engine mode 与 digital sub-mode
   - `lifecycle`: 生成资源蓝图并初始化引擎状态机
3. 后续 `EngineLifecycle.start()` 才真正启动资源

### 2.2 Radio 资源启动

`EngineLifecycle` 的资源蓝图中，`radio` 永远是最高优先级资源：

1. `EngineLifecycle` 调用 `radioManager.applyConfig()`
2. `PhysicalRadioManager` 驱动 radio state machine 进入 connecting
3. `PhysicalRadioManager.doConnect()` 固定分四段：
   - `prepareConnectionSession`
   - `openConnectionSession`
   - `bootstrapConnectedSession`
   - `activateConnectedSession`
4. 只有在 `bootstrapConnectedSession` 完成后，才允许：
   - `startBackgroundTasks()`
   - 频率监控
   - 其他后台轮询
5. `PhysicalRadioManager` 发出 `connected`
6. `RadioBridge` 投影 `radioStatusChanged`，必要时恢复断线前运行状态

## 3. Radio bootstrap 规范

`PhysicalRadioManager.bootstrapConnectedSession()` 是唯一合法的“连接后一次性初始化”入口。

当前固定顺序：

1. `waitForConnectionSettle`
2. `readTunerCapabilities`
3. `restoreSavedFrequencyIfAvailable`
4. `capabilityManager.onConnected`
5. `captureInitialFrequency`（仅在未恢复保存频率时）

### 什么时候放到 bootstrap？

放到 bootstrap 的动作必须同时满足：

- 只在连接成功后做一次
- 会直接访问底层 radio
- 必须早于后台 polling

例子：

- 读取一次 capability / tuner capability
- 恢复上次频率
- 建立初始 known frequency

### 什么时候放到 activation？

放到 activation 的动作通常是：

- 周期性轮询
- 长生命周期后台任务
- 允许连接稳定后再启动

例子：

- `startBackgroundTasks()`
- meter polling
- 频率监控定时器

## 4. 新增逻辑时怎么放

### 4.1 新增一个启动步骤

| 问题 | 放置位置 |
|---|---|
| 只是构造对象、接线依赖 | `DigitalRadioEngine.initialize*Phase()` |
| 是资源的一部分，需要 start/stop | `EngineLifecycle.build*ResourcePlan()` |
| 必须在 radio connect 后立即跑一次 | `PhysicalRadioManager.bootstrapConnectedSession()` |
| 只是把已有状态广播给前端/事件总线 | `RadioBridge` |

### 4.2 新增一种 radio 连接能力

1. 在 `IRadioConnection` 定义接口
2. 在连接实现里保证通过自身串行队列执行
3. 若需要连接后预热，只能由 `PhysicalRadioManager.bootstrapConnectedSession()` 编排
4. 若只是 UI 状态广播，不要在连接实现里直接操作，交给 `RadioBridge`

### 4.3 新增一个新的 radio 连接实现

最少要检查：

1. `connect()` 内只做“建立连接”与实现内部最小初始化
2. 不要在 `connect()` 里偷偷启动后台 polling；统一走 `startBackgroundTasks()`
3. 所有控制类 I/O 必须走串行队列
4. `disconnect()` 必须能安全停止后台任务
5. 如果存在会话切换风险，旧会话任务必须失效

## 5. 代码导航

- 启动 phase：`packages/server/src/DigitalRadioEngine.ts`
- 资源蓝图：`packages/server/src/subsystems/EngineLifecycle.ts`
- 连接 bootstrap：`packages/server/src/radio/PhysicalRadioManager.ts`
- 状态投影：`packages/server/src/subsystems/RadioBridge.ts`
- 连接实现契约：`packages/server/src/radio/connections/IRadioConnection.ts`

## 6. 守护测试

以下测试用于防止职责回流：

- `PhysicalRadioManager.test.ts`: 保证 bootstrap 在 `connected` 之前完成
- `EngineLifecycle.test.ts`: 保证不同模式复用同一资源蓝图重建入口
- `RadioBridge.test.ts`: 保证连接事件投影不再执行连接期写频
