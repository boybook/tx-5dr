# Server 启动与电台链路架构

**适用范围**: `packages/server`
**目标**: 固定启动流程、电台 bootstrap 与事件投影的职责边界，避免职责漂移。

## 1. 分层

Server 启动与 radio 链路固定分成 4 层：

| 层 | 主入口 | 负责 | 不负责 |
|---|---|---|---|
| Facade | `DigitalRadioEngine` | 组装系统、阶段化初始化、对外 API、模式切换 | 资源细节、radio bootstrap、事件投影 |
| Lifecycle | `EngineLifecycle` | 资源蓝图、启动/停止顺序、引擎状态机、回滚 | 连接后预热、频率恢复、CAT 细节 |
| Radio Session | `PhysicalRadioManager` | 连接会话、bootstrap、后台任务激活、统一 radio 编排 | 资源排序、前端广播、协议细节散落到外层 |
| Physical Power | `RadioPowerController` | 电台物理电源事务、control-only 唤醒、可选引擎联动 | 表达 TX-5DR 软件引擎自身状态 |
| Projection | `RadioBridge` | 把 radio 状态投影到 `engineEmitter`、处理断线恢复 | 连接后写频、radio 预热、底层协议调用 |

快速判断：

- 组装系统 → `DigitalRadioEngine`
- 定义资源如何启动 → `EngineLifecycle`
- 连接成功后与电台对话 → `PhysicalRadioManager`
- 电台物理开机/关机/待机 → `RadioPowerController`
- 把状态通知外界 → `RadioBridge`

重要约束：`power` 永远指物理电台电源，不指 TX-5DR 软件引擎启停。软件引擎只有 `idle/starting/running/stopping`；电台电源、CAT 连接、软件引擎是三条独立轴线，只允许 `RadioPowerController` 做显式策略联动。

## 2. 启动时序

### 2.1 Server 初始化

1. `server.ts` 调用 `DigitalRadioEngine.initialize()`
2. `DigitalRadioEngine` 按 phase 初始化运行时、领域服务、子系统装配与模式恢复
3. `EngineLifecycle.start()` 才真正启动资源

### 2.2 Radio 资源启动

`radio` 永远是最高优先级资源，固定路径如下：

1. `EngineLifecycle` 调用 `radioManager.applyConfig()`
2. `PhysicalRadioManager` 驱动 radio state machine 进入 connecting
3. `PhysicalRadioManager.doConnect()` 固定分四段：
   - `prepareConnectionSession`
   - `openConnectionSession`
   - `bootstrapConnectedSession`
   - `activateConnectedSession`
4. 只有 `bootstrapConnectedSession()` 完成后，才允许启动后台任务与轮询
5. `PhysicalRadioManager` 发出 `connected`
6. `RadioBridge` 投影连接状态，并在需要时恢复运行态

## 3. Bootstrap 与 Activation

### 3.1 Bootstrap

`PhysicalRadioManager.bootstrapConnectedSession()` 是唯一合法的“连接后一次性初始化”入口。

当前顺序：

1. `waitForConnectionSettle`
2. `readTunerCapabilities`
3. `restoreSavedFrequencyIfAvailable`
4. `capabilityManager.onConnected`
5. `captureInitialFrequency`（仅在未恢复保存频率时）

适合放进 bootstrap 的动作必须同时满足：

- 只在连接成功后执行一次
- 会直接访问底层 radio
- 必须早于后台 polling

### 3.2 Activation

activation 负责长生命周期后台行为，只能在 bootstrap 完成后开始。

典型内容：

- `startBackgroundTasks()`
- meter polling
- frequency monitoring
- 其他周期性观察流

## 4. Radio I/O 规则

这些规则适用于所有 radio 实现，尤其是老机型或串口后端：

- 所有底层 CAT/CI-V 访问必须经过连接对象自己的串行队列
- `setFrequency`、`setMode`、`setPTT` 属于关键操作，必须保守串行执行
- “切频 + 切模式”必须走 `applyOperatingState(...)` 这类复合入口，不要在上层拆开调用
- meter、capability、frequency monitoring 属于低优先级观察流；关键操作期间应直接跳过
- 观察流失败默认只记日志，不单独作为断线依据
- `connect()` 只负责建链与最小初始化，不负责偷偷启动后台 polling
- `startBackgroundTasks()` 只能在 bootstrap 完成后调用

## 5. 新增逻辑时的放置规则

### 5.1 新增启动步骤

| 场景 | 放置位置 |
|---|---|
| 只是构造对象、接线依赖 | `DigitalRadioEngine.initialize*Phase()` |
| 是资源的一部分，需要 start/stop | `EngineLifecycle.build*ResourcePlan()` |
| 必须在 radio connect 后立即跑一次 | `PhysicalRadioManager.bootstrapConnectedSession()` |
| 只是广播已有状态 | `RadioBridge` |

### 5.2 新增 radio 能力

1. 在 `IRadioConnection` 定义接口
2. 在连接实现里完成协议适配与串行化
3. 如果需要连接后预热，由 `PhysicalRadioManager.bootstrapConnectedSession()` 编排
4. 如果只是状态广播，不要下沉到连接实现，交给 `RadioBridge`

### 5.3 电台物理电源

1. `on/off/standby/operate` 是物理电台 powerstat 目标，不得映射成 engine `start/stop`
2. 物理唤醒由 `RadioPowerController` 调用 `PhysicalRadioManager.wakeAndConnect()`；电台响应后，如 `autoEngine=true`，再显式调用 `EngineLifecycle.startAndWaitForRunning()`
3. `off/standby` 必须先确认物理电源命令成功，再停止 TX-5DR 资源并断开 CAT；命令 unsupported/invalid 时必须保持现有连接和引擎
4. `operate` 只是 Hamlib powerstat 的物理目标，不能当作“关机”或“停止引擎”
5. power 事务开始时必须停止 pending reconnect，并通过 session mutation gate 避免与 reconnect 同时打开同一串口

### 5.4 新增 radio 连接实现

至少满足以下约束：

1. `connect()` 只做建链和最小初始化
2. 后台 polling 统一通过 `startBackgroundTasks()` 启动
3. 所有控制类 I/O 必须经过串行队列
4. 复合切换必须支持 `applyOperatingState(...)`
5. `disconnect()` 必须能安全停止后台任务
6. 旧会话残留任务必须失效

## 6. 代码导航

- 启动 phase：`packages/server/src/DigitalRadioEngine.ts`
- 资源蓝图：`packages/server/src/subsystems/EngineLifecycle.ts`
- radio bootstrap：`packages/server/src/radio/PhysicalRadioManager.ts`
- physical power：`packages/server/src/radio/RadioPowerController.ts`
- 状态投影：`packages/server/src/subsystems/RadioBridge.ts`
- 连接契约：`packages/server/src/radio/connections/IRadioConnection.ts`

## 7. 守护测试

这些测试用于防止职责回流：

- `PhysicalRadioManager.test.ts`：bootstrap 在 `connected` 前完成，关键操作期间跳过监控
- `RadioPowerController.test.ts`：物理 power 目标不误触发 engine stop/start
- `EngineLifecycle.test.ts`：不同模式复用同一资源蓝图重建入口
- `RadioBridge.test.ts`：连接事件投影不执行连接期写频
- `HamlibConnection.test.ts` / `IcomWlanConnection.test.ts`：关键 I/O 串行化、复合切换与低优先级让路
