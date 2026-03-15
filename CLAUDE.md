# CLAUDE.md

TX-5DR 数字电台项目指南。**请使用中文与用户沟通。**

## 项目概述
Node.js 后端 + React 前端 + Electron 桌面应用，Turborepo + Yarn 4 管理 monorepo。

## 包结构
- **contracts**: Schema 和类型 → 详见 `packages/contracts/CLAUDE.md`
- **core**: 通信客户端 → 详见 `packages/core/CLAUDE.md`
- **server**: 后端服务（DigitalRadioEngine Facade + 子系统）→ 详见 `packages/server/CLAUDE.md`
- **web**: React 前端 → 详见 `packages/web/CLAUDE.md`
- **electron-***: 桌面应用 → 详见各包 CLAUDE.md

依赖: contracts → core → web/electron, core ↔ server

## 常用命令
```bash
# 开发
yarn dev                    # 浏览器模式（启动 server + web，访问 http://localhost:5173）
yarn dev:electron           # Electron模式（启动 server + web + electron-main）

# 独立启动（用于调试）
yarn workspace @tx5dr/server dev    # 单独启动后端（4000端口）
yarn workspace @tx5dr/web dev       # 单独启动前端（5173端口）
yarn workspace @tx5dr/electron-main dev  # 单独启动Electron（需要先启动server和web）

# 构建
yarn build                  # 构建所有包
yarn build:package         # Electron打包
yarn lint                   # 代码检查
yarn test                   # 测试

# Docker
yarn docker:build          # Docker构建
docker-compose up -d        # 启动服务
```

## 技术栈
前端: React 18 + TypeScript + HeroUI + WebGL
后端: Fastify + naudiodon2 + WSJTX + WebSocket
工具: Piscina 工作池 + Turborepo + XState v5 状态机

## 核心架构

### Profile 系统
Profile 是电台配置 + 音频配置的原子单元，由 `ProfileManager` 管理 CRUD 和激活。

**数据结构** (`contracts/radio-profile.schema.ts`):
- `id` / `name` / `description` — 标识信息
- `radio: HamlibConfig` — 电台连接配置（type + network/icomWlan/serial 三种子配置共存）
- `audio: AudioDeviceSettings` — 音频设备配置
- `audioLockedToRadio` — ICOM WLAN 时自动锁定为 true

**激活流程** (`ProfileManager.activateProfile`):
1. 安全停止引擎（超时 10s 兜底）
2. 切换 activeProfileId（原子操作）
3. 广播 `profileChanged` 事件
4. 始终启动引擎（使用新 Profile 配置，启动失败不影响切换）

### 电台连接层

**三层架构**:
```
IRadioConnection (统一接口)       ← connect/disconnect/setFrequency/setPTT/...
  ├─ IcomWlanConnection           ← ICOM IC-705 等 WiFi 直连
  ├─ HamlibConnection             ← Hamlib 网络或串口（通用电台）
  └─ NullConnection               ← 无电台模式（测试/纯监听）
RadioConnectionFactory            ← 工厂：根据 HamlibConfig.type 创建实例
PhysicalRadioManager              ← 编排器：连接启停 + 状态机驱动 + 事件转发
```

**连接配置** (`contracts/radio.schema.ts` — `HamlibConfig`):
- `type`: `'none' | 'network' | 'serial' | 'icom-wlan'`
- `network` / `icomWlan` / `serial` — 三种子配置对象共存，按 type 读取对应配置
- `transmitCompensationMs` — 发射时序补偿 (-1000~1000ms)

### 双状态机架构 (XState v5)

系统使用两个 XState v5 状态机分别管理引擎生命周期和电台连接，代码位于 `server/src/state-machines/`。

**引擎状态机** (`engineStateMachine.ts`):
```
IDLE ──START──→ STARTING ──onDone──→ RUNNING ──STOP──→ STOPPING ──onDone──→ IDLE
                  │ onError→IDLE       │ RADIO_DISCONNECTED/FORCE_STOP→STOPPING
```
- 4 状态: IDLE / STARTING / RUNNING / STOPPING
- 启动/停止失败均回 IDLE（context.error 记录错误）
- 电台断线 (`RADIO_DISCONNECTED`) 触发强制停止
- `EngineLifecycle` 子系统管理 ResourceManager 按优先级启停资源

**电台状态机** (`radioStateMachine.ts`):
```
DISCONNECTED ──CONNECT──→ CONNECTING ──onDone──→ CONNECTED
     ↑ 重试耗尽                                    │ CONNECTION_LOST
     └──────────────── RECONNECTING ←───────────────┘ (仅 wasEverConnected=true)
```
- 4 状态: DISCONNECTED / CONNECTING / CONNECTED / RECONNECTING
- **首次连接失败**: 直接回 DISCONNECTED + 错误通知（不自动重连）
- **运行中断线**: 仅当 `wasEverConnected=true` 时进入 RECONNECTING
- **重连策略**: 指数退避 [2s, 4s, 8s, 16s, 30s]，最多 5 次
- **健康检查**: CONNECTED 状态下每 3s 检查一次，连续失败触发断线

**两个状态机的协作**:
```
DigitalRadioEngine (Facade)
  └─ EngineLifecycle (engineActor: 引擎状态机)
       └─ ResourceManager.startup() 按优先级启动资源
            └─ PhysicalRadioManager (radioActor: 电台状态机)
                 └─ RadioConnectionFactory → IRadioConnection 实现
```
- 引擎启动时 ResourceManager 按优先级启动资源，radio 是第一个
- 电台断线 → PhysicalRadioManager 通知 EngineLifecycle → 引擎强制停止
- 重连成功 → 恢复断线前的运行状态

### WebSocket 事件系统
- **直接订阅**: 组件通过 `radioService.wsClientInstance` 直接访问 WSClient 订阅事件
- **多监听器**: 同一事件支持多个监听器互不干扰
- **轻量 Service**: RadioService 仅封装命令方法，暴露 wsClient 实例
- **类型安全**: 基于 contracts 的 `DigitalRadioEngineEvents` 类型定义
- **内存安全**: 必须配对调用 `onWSEvent` / `offWSEvent` 避免内存泄漏

事件流：`WSClient → RadioProvider/Components (直接订阅)`

详见：`packages/web/CLAUDE.md` 和 `packages/core/CLAUDE.md`

## 开发规范
1. 各包有专门 CLAUDE.md，修改时参考对应文档
2. 新功能: contracts 定义 Schema → server 实现 → web 集成
3. 提交前: `yarn lint && yarn build`
