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
后端: Fastify + Audify (RtAudio) + WSJTX + WebSocket
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

---

## i18n 规范

**前端所有面向用户的中文字符串禁止硬编码，必须通过翻译系统输出。**

```bash
# 修改前端代码后运行，AI 也应在完成前端修改后执行
node scripts/check-i18n.mjs
```

- React 组件：`useTranslation()` → `t('namespace:key')`
- 非组件文件（store/utils）：`import i18n from '../i18n'` → `i18n.t('...')`
- 模块级常量含中文：改为 `getXxx(t)` 工厂函数 + `useMemo`
- 动态字符串：`t('key', { name })` + 语言文件 `"key": "...{{name}}..."`
- 3 个 Vite 入口（main/spectrum/logbook）首行均须 `import './i18n/index'`
- 语言文件：`packages/web/src/i18n/locales/{zh,en}/`（7 个命名空间）
- 后端 `broadcastTextMessage` 必须传 `key` 参数（`ServerMessageKey` 枚举），AUTH_RESULT/ERROR 消息 error 字段用英文 code

## 日志规范

**所有包禁止裸 `console.log`，使用各包的 `createLogger`。日志消息必须为英文，不含 emoji。**

| 包 | 工具文件 | import 路径示例 |
|----|---------|---------------|
| server | `utils/logger.ts` | `'../utils/logger.js'` |
| core | `utils/logger.ts` | `'../utils/logger.js'` |
| web | `utils/logger.ts` | `'../utils/logger'`（无扩展名） |
| electron-main | `utils/logger.ts` | `'./utils/logger.js'` |

```typescript
import { createLogger } from '../utils/logger.js';
const logger = createLogger('MyModule');

logger.debug('slot started', { id });   // 高频路径 → 生产静默
logger.info('operator created', { id }); // 生命周期事件
logger.warn('encode timeout', { expected, actual }); // 告警
logger.error('PTT failed', err);         // 错误
```

**级别规则**：
- `debug`：高频路径（每时隙/每次 WS 事件/每次编解码）
- `info`：生命周期（启动/停止/连接/断开/配置变更）
- `warn`/`error`：始终输出

**架构说明（server）**：`ConsoleLogger` 通过 console 全局覆盖拦截所有输出写入日志文件；`createLogger` 做级别过滤后调用 `console.*`，由覆盖层统一持久化。`core` 包的日志经级别过滤后同样进入覆盖层写入 server 日志文件。

**server 级别控制**：`LOG_LEVEL=debug|info|warn|error`（production 默认 warn，development 默认 info）
