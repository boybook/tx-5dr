# TX-5DR 插件系统开发指南

> 适用版本：当前主分支  
> 面向读者：希望为 TX-5DR 编写插件或对插件系统进行二次开发的开发者

---

## 目录

1. [产品概述](#1-产品概述)
2. [核心概念](#2-核心概念)
3. [插件结构规范](#3-插件结构规范)
4. [完整 API 参考](#4-完整-api-参考)
   - 4.1 [PluginDefinition](#41-plugindefinition)
   - 4.2 [PluginContext](#42-plugincontext)
   - 4.3 [OperatorControl](#43-operatorcontrol)
   - 4.4 [Hook 分类与语义](#44-hook-分类与语义)
   - 4.5 [设置系统](#45-设置系统)
   - 4.6 [QuickActions](#46-quickactions)
   - 4.7 [Panels](#47-panels)
   - 4.8 [持久化存储](#48-持久化存储)
5. [编写你的第一个插件](#5-编写你的第一个插件)
   - 5.1 [最简工具插件（JS）](#51-最简工具插件js)
   - 5.2 [TypeScript 完整项目](#52-typescript-完整项目)
   - 5.3 [策略插件示例](#53-策略插件示例)
6. [内置插件参考](#6-内置插件参考)
   - 6.1 [standard-qso（内置策略）](#61-standard-qso内置策略)
   - 6.2 [snr-filter（内置示例工具）](#62-snr-filter内置示例工具)
   - 6.3 [callsign-prefix-filter（字符串数组过滤示例）](#63-callsign-prefix-filter字符串数组过滤示例)
   - 6.4 [worked-station-bias（评分示例）](#64-worked-station-bias评分示例)
   - 6.5 [qso-session-inspector（广播 Hook + 面板示例）](#65-qso-session-inspector广播-hook--面板示例)
   - 6.6 [watched-callsign-autocall（待机守候自动起呼）](#66-watched-callsign-autocall待机守候自动起呼)
   - 6.7 [watched-novelty-autocall（守候新类型自动起呼）](#67-watched-novelty-autocall守候新类型自动起呼)
   - 6.8 [heartbeat-demo（timer + button quickAction 示例）](#68-heartbeat-demotimer--button-quickaction-示例)
7. [插件系统架构](#7-插件系统架构)
   - 7.1 [生命周期](#71-生命周期)
   - 7.2 [Hook 分发机制](#72-hook-分发机制)
   - 7.3 [策略运行时实现](#73-策略运行时实现)
   - 7.4 [错误隔离](#74-错误隔离)
   - 7.5 [多插件冲突处理](#75-多插件冲突处理)
8. [REST API 与 WebSocket 事件](#8-rest-api-与-websocket-事件)
9. [前端 UI 集成](#9-前端-ui-集成)
10. [新增内置插件指南](#10-新增内置插件指南)
11. [代码文件导航](#11-代码文件导航)

---

## 1. 产品概述

TX-5DR 的插件系统允许开发者通过编写单个 JavaScript（或 TypeScript）文件来扩展、替换或增强数字电台的自动化通联逻辑，无需修改核心代码。

### 设计目标

| 目标 | 体现 |
|------|------|
| **低门槛** | 单个 `.js` 文件即可运行，通过 JSDoc 获得 IDE 补全 |
| **高上限** | 完整 TypeScript 项目，可实现任意复杂的通联策略 |
| **高自由** | 策略插件可完全替换内置 QSO 决策逻辑 |
| **清晰直观** | 声明式 settings/quickActions/panels，UI 自动生成 |
| **IDE 友好** | `@tx5dr/plugin-api` 提供统一的公共开发接口与自动补全 |

### 什么时候需要插件？

- **偏好筛选**：只回复特定前缀或 DXCC 的电台
- **自动唤醒**：监听到目标电台时自动开始发射
- **定时任务**：每隔 N 分钟切换波段（Band Hopping）
- **竞赛模式**：完全替换 QSO 流程以适配特定竞赛规则
- **数据展示**：实时统计并在面板中展示通联数据
- **外部集成**：查询 DX Cluster、上传日志到外部服务

---

## 2. 核心概念

### 插件类型

系统定义了两种互不冲突的插件类型：

#### 策略插件（`type: 'strategy'`）

- **每个操作员只能选择一个活跃策略**（互斥）
- 通过 `createStrategyRuntime(ctx)` 显式创建 `StrategyRuntime`
- 活跃策略运行时直接决定 QSO 状态机、槽位内容、上下文和发射文本
- 内置的 `standard-qso` 就是一个策略插件

#### 工具插件（`type: 'utility'`）

- **可以多个同时激活**（叠加）
- 通过 Pipeline Hooks 过滤/评分候选目标
- 通过 Broadcast Hooks 监听事件并做旁路处理
- 不干预核心决策流程，只辅助增强

### 操作员维度

每个操作员（Operator）都有**独立的插件实例**。一个应用可以同时运行多个操作员（不同呼号/频率），每个操作员独立持有自己的 operator-scope 配置。

- `PluginManager` 会为每个操作员创建一套插件实例
- 对于策略插件，运行时对象也会按操作员维度创建
- 但真正参与自动化决策和发射流程的，始终只有当前选中的那一个活跃策略

### 设置作用域

- **`global` scope**：所有操作员共享，在"插件设置"全局面板中显示（如 API Key、黑名单）
- **`operator` scope**：每个操作员独立，在操作员配置面板中显示（如 autoReplyToCQ）

### 设置节点类型

插件设置既可以是可编辑字段，也可以是纯展示说明节点：

- **`boolean`**：布尔开关
- **`number`**：数字输入
- **`string`**：字符串输入或下拉选择
- **`string[]`**：字符串数组
- **`info`**：纯说明文字节点，只用于 UI 展示，不参与持久化、脏数据比较或保存

`info` 适合描述某组设置的用途、策略边界、依赖前提或行为说明，而不是伪装成一个“假的设置项”。

---

## 3. 插件结构规范

### 用户插件目录

用户插件始终放置在应用数据目录下的 `plugins/` 子目录中：

```
{dataDir}/plugins/
└── my-plugin/
    ├── plugin.js        # 主入口（ESM），或 index.js
    ├── locales/         # 可选：插件自带的 i18n 翻译
    │   ├── zh.json
    │   └── en.json
    └── README.md        # 可选：说明文档
```

> **常见目录位置**：
> - Electron / macOS：`~/Library/Application Support/TX-5DR/plugins`
> - Electron / Windows：`%LOCALAPPDATA%\TX-5DR\plugins`
> - Linux（桌面 / 开发环境）：`~/.local/share/TX-5DR/plugins`
> - Linux server 包：`/var/lib/tx5dr/plugins`
> - Docker 容器内：`/app/data/plugins`
>
> **补充说明**：
> - Docker 官方 `docker-compose.yml` 默认将宿主机 `./data/plugins` 映射到容器内 `/app/data/plugins`
> - 若自定义了 `TX5DR_DATA_DIR`，插件目录随之变为 `{TX5DR_DATA_DIR}/plugins`
> - 在应用内可直接从「设置 → 插件」查看当前运行时实际使用的绝对路径

### 内置插件目录（开发者参考）

内置插件与用户插件遵循**相同的目录结构**，位于：

```
packages/server/src/plugin/builtins/
├── standard-qso/
│   ├── index.ts         # 插件定义 + createStrategyRuntime 工厂
│   ├── StandardQSOPluginRuntime.ts
│   └── locales/
│       ├── zh.json
│       └── en.json
├── snr-filter/
    ├── index.ts         # 工具插件 hooks 实现
    └── locales/
        ├── zh.json
        └── en.json
├── callsign-prefix-filter/
│   ├── index.ts
│   └── locales/
│       ├── zh.json
│       └── en.json
├── worked-station-bias/
│   ├── index.ts
│   └── locales/
│       ├── zh.json
│       └── en.json
├── qso-session-inspector/
│   ├── index.ts
│   └── locales/
│       ├── zh.json
│       └── en.json
├── heartbeat-demo/
│   ├── index.ts
│   └── locales/
│       ├── zh.json
│       └── en.json
├── watched-callsign-autocall/
│   ├── index.ts
│   └── locales/
│       ├── zh.json
│       └── en.json
└── watched-novelty-autocall/
    ├── index.ts
    └── locales/
        ├── zh.json
        └── en.json
```

内置插件的翻译通过 `import ... with { type: 'json' }` 编译进 bundle，无运行时 I/O。

### 插件入口规范

插件入口文件必须是 **ESM 格式**，默认导出一个 `PluginDefinition` 对象：

```js
// plugin.js
export default {
  name: 'my-plugin',
  version: '1.0.0',
  type: 'utility',
  // ...
};
```

系统会按以下顺序查找入口文件：`plugin.js` → `plugin.mjs` → `index.js` → `index.mjs`

### i18n 翻译规范

插件的 `settings[key].label` 字段是 i18n key，前端会从插件自带的翻译命名空间（`plugin:{pluginName}`）中查找对应文本。

```json
// locales/zh.json
{
  "minSNR": "最低信噪比 (dB)",
  "myToggle": "启用某功能"
}
```

```js
// plugin.js
settings: {
  minSNR: { type: 'number', default: -15, label: 'minSNR', scope: 'global' }
}
```

若翻译文件中找不到 key，直接显示 label 原文作为 fallback。

---

## 4. 完整 API 参考

> **获取类型支持**：`npm install --save-dev @tx5dr/plugin-api`
>
> 对于独立插件项目，`@tx5dr/plugin-api` 是推荐的唯一公共开发入口。
> 请优先从这里导入插件定义、上下文、消息类型与常用枚举，而不要直接依赖 `@tx5dr/contracts`。
> `@tx5dr/contracts` 仍可被 TX-5DR monorepo 内部使用，但不作为外部插件的稳定公共接口。

### 4.1 PluginDefinition

插件的顶层定义对象，即 `export default` 的内容。

```typescript
interface PluginDefinition {
  /** 插件唯一标识符，全局不可重复 */
  name: string;

  /** 语义化版本号，如 "1.0.0" */
  version: string;

  /** 插件类型：策略（互斥）或工具（叠加） */
  type: 'strategy' | 'utility';

  /** 可选：人类可读的描述 */
  description?: string;

  /** 可选：所需权限声明 */
  permissions?: ('network')[];

  /**
   * 声明式设置项
   * 键名为 setting key，前端自动渲染对应的 UI 控件
   */
  settings?: Record<string, PluginSettingDescriptor>;

  /**
   * 快捷操作按钮
   * 出现在操作员面板的自动化下拉区域
   */
  quickActions?: PluginQuickAction[];

  /**
   * 数据展示面板
   * 出现在操作员面板下方，通过 ctx.ui.send() 推送数据
   */
  panels?: PluginPanelDescriptor[];

  /** 声明需要哪些存储作用域（当前主要作为元数据暴露，不做运行时裁剪） */
  storage?: PluginStorageConfig;

  /**
   * 策略运行时工厂
   * type='strategy' 时必填；type='utility' 时不得提供
   */
  createStrategyRuntime?(ctx: PluginContext): StrategyRuntime;

  /** 插件实例加载时调用（插件子系统启动、重载或为操作员创建实例时） */
  onLoad?(ctx: PluginContext): void | Promise<void>;

  /** 插件实例卸载时调用（插件重载、移除操作员或插件子系统关闭时），定时器自动清理 */
  onUnload?(ctx: PluginContext): void | Promise<void>;

  /** Hook 实现 */
  hooks?: PluginHooks;
}
```

### 4.2 PluginContext

运行时注入的上下文对象，是插件与系统交互的唯一入口。

```typescript
interface PluginContext {
  /** 当前生效的设置值（global + operator 合并，只读） */
  readonly config: Readonly<Record<string, unknown>>;

  /** 持久化 KV 存储 */
  readonly store: {
    readonly global: KVStore;    // 所有操作员共享
    readonly operator: KVStore;  // 当前操作员独占
  };

  /** 日志接口（输出到系统日志 + 前端日志面板） */
  readonly log: PluginLogger;

  /** 命名定时器管理 */
  readonly timers: PluginTimers;

  /** 操作员控制（见 4.3 节） */
  readonly operator: OperatorControl;

  /** 物理电台控制 */
  readonly radio: RadioControl;

  /** 日志本查询 */
  readonly logbook: LogbookAccess;

  /** 波段/解码数据访问 */
  readonly band: BandAccess;

  /** 向前端面板推送数据 */
  readonly ui: UIBridge;

  /**
   * 受控 HTTP fetch
   * 仅声明 `permissions: ['network']` 后可用，否则为 undefined
   */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}
```

#### KVStore

```typescript
interface KVStore {
  get<T = unknown>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  getAll(): Record<string, unknown>;
}
```

#### 常用定义类型

`@tx5dr/plugin-api` 还会统一导出一批插件定义层常用类型，便于在 helper/builder 中复用，而无需直接依赖内部 contracts：

- `PluginSettingType`
- `PluginSettingScope`
- `PluginSettingDescriptor`
- `PluginSettingOption`
- `PluginStorageScope`
- `PluginStorageConfig`
- `TargetSelectionPriorityMode`

此外，插件在处理解码结果和日志本分析时，通常也可以直接从 `@tx5dr/plugin-api` 获取这些运行时类型：

- `LogbookAnalysis`
- `DxccStatus`
- `ParsedFT8Message`
- `QSORecord`

写入操作有 300ms debounce；插件实例卸载或插件子系统关闭时会强制 flush。

#### PluginLogger

```typescript
interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}
```

日志同时输出到：系统日志文件、前端设置页 `Settings -> Plugins` 中的“插件日志”面板（通过 `pluginLog` 事件实时显示，当前仅保留本次前端会话内的内存缓冲）。

#### PluginTimers

```typescript
interface PluginTimers {
  /** 设置命名间隔定时器，重复调用同一 id 会替换旧的 */
  set(id: string, intervalMs: number): void;
  /** 清除指定定时器 */
  clear(id: string): void;
  /** 清除此插件的所有定时器（onUnload 时自动调用） */
  clearAll(): void;
}
```

定时器触发时调用 `hooks.onTimer(timerId, ctx)`。

#### RadioControl

```typescript
interface RadioControl {
  readonly frequency: number;     // 电台当前频率（Hz）
  readonly band: string;          // 当前波段（如 "20m"）
  readonly isConnected: boolean;  // 电台是否已连接
  setFrequency(freq: number): Promise<void>;
}
```

#### LogbookAccess

```typescript
interface LogbookAccess {
  hasWorked(callsign: string): Promise<boolean>;
  hasWorkedDXCC(dxccEntity: string): Promise<boolean>;
  hasWorkedGrid(grid: string): Promise<boolean>;
}
```

> 当前实现说明：`hasWorked()` 已可用；`hasWorkedDXCC()` 与 `hasWorkedGrid()` 仍作为预留接口返回占位结果，尚未接入真实日志本查询。

#### BandAccess

```typescript
interface BandAccess {
  getActiveCallers(): ParsedFT8Message[];  // 当前时隙的 CQ 台列表
  getLatestSlotPack(): SlotPack | null;   // 最新解码包
}
```

#### UIBridge

```typescript
interface UIBridge {
  send(panelId: string, data: unknown): void;
}
```

`panelId` 必须与 `PluginDefinition.panels[].id` 匹配。数据通过 `pluginData` 事件推送到前端对应面板。

### 4.3 OperatorControl

操作员控制接口，提供对当前操作员的完整访问能力。

```typescript
interface OperatorControl {
  // ===== 只读属性 =====

  /** 操作员唯一 ID */
  readonly id: string;

  /** 是否正在发射 */
  readonly isTransmitting: boolean;

  /** 呼号 */
  readonly callsign: string;

  /** 网格定位符（如 "PL09"） */
  readonly grid: string;

  /** 音频偏移频率（Hz，在通带内，通常 200-3000） */
  readonly frequency: number;

  /** 当前模式（FT8/FT4，含时隙信息） */
  readonly mode: ModeDescriptor;

  /** 发射周期配置（0=偶数时隙，1=奇数时隙） */
  readonly transmitCycles: number[];

  // ===== 控制方法 =====

  /** 启用发射 */
  startTransmitting(): void;

  /** 停止发射 */
  stopTransmitting(): void;

  /**
   * 呼叫指定呼号
   * lastMessage 为触发呼叫的解码消息（用于确定发射时隙）
   */
  call(callsign: string, lastMessage?: { message: FrameMessage; slotInfo: SlotInfo }): void;

  /** 设置发射周期（0=偶数，1=奇数，[0,1]=双向） */
  setTransmitCycles(cycles: number | number[]): void;

  // ===== 查询方法 =====

  /** 查询是否已与某呼号通联（异步查询日志本） */
  hasWorkedCallsign(callsign: string): Promise<boolean>;

  /**
   * 检查是否有其他同呼号操作员正在与该目标通联
   * 用于防止多操作员重复呼叫同一目标
   */
  isTargetBeingWorkedByOthers(targetCallsign: string): boolean;

  // ===== 通知方法 =====

  /** 记录 QSO 到日志本 */
  recordQSO(record: QSORecord): void;

  /** 通知前端更新 TX1-TX6 时隙内容显示 */
  notifySlotsUpdated(slots: OperatorSlots): void;

  /** 通知前端状态机状态变更 */
  notifyStateChanged(state: string): void;
}
```

### 4.4 Hook 分类与语义

#### Pipeline Hooks（活跃插件链式处理）

链式执行，前一个插件的输出是下一个插件的输入。

| Hook | 参数 | 返回 | 安全网 |
|------|------|------|--------|
| `onFilterCandidates` | `candidates: ParsedFT8Message[]` | 过滤后的列表 | 若返回空数组且输入非空，跳过此插件 |
| `onScoreCandidates` | `candidates: ScoredCandidate[]` | 评分后的列表 | 无 |

`ScoredCandidate` 是 `ParsedFT8Message` 的扩展，附加 `score: number` 字段。通常由工具插件做前置过滤和评分；活跃策略插件如果也声明了这些 hook，同样会参与这条链路。

#### Strategy Runtime（仅活跃策略插件）

每个操作员只有一个活跃策略插件。策略插件不再通过黑盒字符串命令参与内部控制，而是必须显式创建 `StrategyRuntime`：

| 方法 | 触发时机 | 说明 |
|------|---------|------|
| `decide(messages, meta)` | 每个时隙开始（仅对正在发射的操作员） | 核心决策：接收解码消息，决定下一步动作 |
| `getTransmitText()` | 编码时机（仅当前周期需要发射时） | 返回本时隙要发射的文本，null 表示不发射 |
| `requestCall(callsign, lastMessage?)` | 用户手动点击呼叫 | 处理用户主动呼叫某呼号的请求 |
| `patchContext(patch)` | 用户修改上下文 | 更新 target/report 等策略上下文 |
| `setState(state)` | 用户手动切换 TX 状态 | 直接切换策略运行时状态 |
| `setSlotContent({ slot, content })` | 用户编辑槽位文本 | 直接更新指定槽位文本 |
| `getSnapshot()` | 服务端同步状态给客户端 | 返回当前状态/槽位/上下文快照 |
| `reset(reason?)` | 插件重载、策略切换等 | 重置策略运行时 |
| `onTransmissionQueued(text)` | 发射内容进入编码队列 | 可选，用于记录“本次内容已排队” |

> **时序参考**（FT8 示例）：
> - T+0ms：`slotStart` → `runtime.decide(...)`（决策窗口）
> - T+780ms：`encodeStart` → `runtime.getTransmitText()`（获取发射文本）
> - T+1180ms：`transmitStart`（PTT 激活，音频播放）

> 注意：运行时的核心控制命令走系统的强类型接口（如 `setOperatorRuntimeState`、`setOperatorRuntimeSlotContent`、`setOperatorTransmitCycles`），而不是走 `pluginUserAction` 这类泛型插件消息。

#### Broadcast Hooks（所有活跃插件并发接收）

Fire-and-forget，不阻塞主流程，错误只记录不影响其他插件。

| Hook | 触发条件 | 典型用途 |
|------|---------|---------|
| `onSlotStart` | 每个时隙开始 | 定时统计、状态检查 |
| `onDecode` | 收到解码结果（即使未发射）| 监听模式、发现目标自动唤醒 |
| `onQSOStart` | 锁定目标呼号时 | 记录 QSO 开始时间 |
| `onQSOComplete` | QSO 成功完成时 | 统计、推送通知、外部上传 |
| `onQSOFail` | QSO 超时/失败时 | 记录失败原因 |
| `onTimer` | 命名定时器触发时 | Band hopping、定时停止 |
| `onUserAction` | 用户点击 QuickAction 按钮 | 响应用户操作（`actionId, payload, ctx`） |
| `onConfigChange` | 插件设置变更时 | 热更新内部状态 |

`onUserAction` 只用于**插件自定义交互**。系统内部的操作员状态切换、槽位编辑、发射周期切换等核心控制，不再通过这个入口传递。

#### Autocall Proposal Hook（自动起呼提议）

对于“守候型” utility 插件，推荐实现 `onAutoCallCandidate(slotInfo, messages, ctx)`，返回：

```typescript
{
  callsign: string;
  priority?: number;
  lastMessage?: { message: FrameMessage; slotInfo: SlotInfo };
}
```

- Host 会收集所有活跃 utility 插件的提议，而不是允许它们在广播 Hook 中直接抢占 `ctx.operator.call(...)`
- 仲裁顺序为：`priority` 高者优先 → 命中消息在当前时隙中的顺序 → 插件名稳定排序
- 仲裁完成后，Host 最多只会执行一次统一的 `requestCall(...)`
- 旧插件仍可继续在 `onSlotStart` / `onDecode` 中直接 `call()`，但新的内置自动起呼插件都应优先改用 proposal hook，以获得可组合、可预测的兼容行为

### 4.5 设置系统

#### PluginSettingDescriptor

```typescript
interface PluginSettingDescriptor {
  /** 值类型 */
  type: 'boolean' | 'number' | 'string' | 'string[]' | 'info';

  /** 默认值。type='info' 时通常传空字符串即可 */
  default: unknown;

  /**
   * i18n key，从插件自带的翻译命名空间查找
   * 找不到则直接显示此字符串
   */
  label: string;

  /** 可选：补充描述。type='info' 时通常作为正文说明显示 */
  description?: string;

  /**
   * 作用域
   * 'global'：所有操作员共享，显示在"插件设置"Tab
   * 'operator'：每个操作员独立，显示在操作员配置面板
   * 默认为 'global'
   */
  scope?: 'global' | 'operator';

  /** 数值范围（type='number' 时有效） */
  min?: number;
  max?: number;

  /** 枚举选项（type='string' 时显示为下拉） */
  options?: Array<{ label: string; value: string }>;
}
```

#### `info` 类型的语义

- `info` 是一个纯展示节点，不代表真实配置值
- 不会写入 `ctx.config`
- 不参与前端脏数据比较
- 不会进入保存请求
- 可用于 `global` 和 `operator` 两种 scope

示例：

```typescript
settings: {
  strategyOverview: {
    type: 'info',
    default: '',
    label: 'strategyOverview',
    description: 'strategyOverviewDesc',
    scope: 'operator',
  },
  autoReplyToCQ: {
    type: 'boolean',
    default: false,
    label: 'autoReplyToCQ',
    scope: 'operator',
  },
}
```

对应翻译：

```json
{
  "strategyOverview": "策略说明",
  "strategyOverviewDesc": "该策略负责标准通联流程，包括自动回复、目标选择与超时控制。"
}
```

#### ctx.config 的合并规则

`ctx.config` 是只读的合并视图：

```
最终值 = operator-scope 配置 覆盖 global-scope 配置 覆盖 defaults
```

同一个 key 不能同时是 global 和 operator scope。
`info` 类型不参与上述合并。

#### 持久化位置

- **Global settings**：`config.plugins.configs[pluginName].settings`（在 `config.json` 中）
- **Operator settings**：`config.plugins.operatorSettings[operatorId][pluginName]`（在 `config.json` 中）

对于 operator-scope 的 utility 插件，推荐把“是否启用”隐含在配置内容里，而不是额外再做一个单独开关。例如黑名单为空、守候名单为空，都可以自然表示“当前操作者未启用该功能”。

### 4.6 QuickActions

QuickActions 出现在操作员面板右上角的自动化下拉面板中。

```typescript
interface PluginQuickAction {
  /** 唯一 ID */
  id: string;

  /** 显示文本（i18n key 或直接文本） */
  label: string;

  /** 可选图标名 */
  icon?: string;

  /**
   * 'button'：点击触发 hooks.onUserAction(id, payload, ctx)
   * 'toggle'：开关，绑定到一个 operator-scope boolean setting
   */
  type?: 'button' | 'toggle';

  /**
   * type='toggle' 时必填
   * 绑定的 setting key，必须是 operator-scope boolean 类型
   */
  settingKey?: string;
}
```

**Toggle 工作原理**：
1. 前端读取当前 `pluginOperatorSettings[pluginName][settingKey]` 的值决定开关状态
2. QuickAction toggle 属于插件定义的快捷交互，用户点击后会直接更新对应 operator-scope setting
3. 服务端触发 `onConfigChange`，`ctx.config` 动态反映新值

**与设置页保存框架的区别**：
- 设置 → 插件 Tab 中的 utility 插件启用状态和 global-scope settings，会先进入前端草稿态
- 这些草稿由设置弹窗底部统一“保存设置”后才提交
- 操作员设置页中的 operator-scope 设置当前仍按插件区块分别保存

### 4.7 Panels

```typescript
interface PluginPanelDescriptor {
  id: string;
  title: string;  // i18n key 或直接文本
  component: 'table' | 'key-value' | 'chart' | 'log';
}
```

#### 数据格式规范

| component | 期望的 data 格式 |
|-----------|--------------|
| `key-value` | `{ [key: string]: string \| number }` |
| `table` | `Array<Record<string, unknown>>` |
| `log` | `string[]` |
| `chart` | 自定义（当前以 JSON 格式原样显示） |

#### 数据推送

```typescript
// 在任意 hook 中
ctx.ui.send('panel-id', { '总通联': 42, '今日': 5 });
```

数据通过 WebSocket `pluginData` 事件实时推送，无需轮询。

### 4.8 持久化存储

```typescript
// global scope — 所有操作员共享
ctx.store.global.set('blacklist', ['BG5DRB', 'BG5CAM']);
const blacklist = ctx.store.global.get<string[]>('blacklist', []);

// operator scope — 每个操作员独立
ctx.store.operator.set('qsoCount', 42);
const count = ctx.store.operator.get<number>('qsoCount', 0);
```

**存储文件路径**：
- Global：`{dataDir}/plugin-data/{name}/global.json`
- Operator：`{dataDir}/plugin-data/{name}/operator-{operatorId}.json`

这样插件源码目录（`{dataDir}/plugins/{name}`）只用于放置插件入口与资源文件，不会再被运行时状态文件污染。

写操作有 300ms debounce；插件实例卸载或插件子系统关闭时自动 flush。

---

## 5. 编写你的第一个插件

### 5.1 最简工具插件（JS）

适合快速验证想法，无需编译步骤：

```js
// {pluginDir}/snr-guard/plugin.js

/** @type {import('@tx5dr/plugin-api').PluginDefinition} */
export default {
  name: 'snr-guard',
  version: '1.0.0',
  type: 'utility',
  description: 'Block candidates below minimum SNR',

  settings: {
    minSNR: {
      type: 'number',
      default: -15,
      label: 'Minimum SNR (dB)',
      scope: 'global',
      min: -30,
      max: 10,
    },
  },

  hooks: {
    onFilterCandidates(candidates, ctx) {
      const minSNR = /** @type {number} */ (ctx.config.minSNR ?? -15);
      return candidates.filter(c => c.snr >= minSNR);
    },
  },
};
```

将其放入当前插件目录下的 `snr-guard/` 子目录后，在前端「设置 → 插件」中重载即可生效，无需重编译。

### 5.2 TypeScript 完整项目

```
my-plugin/
├── src/
│   └── index.ts
├── locales/
│   ├── zh.json
│   └── en.json
├── package.json
├── tsconfig.json
└── README.md
```

**package.json**

```json
{
  "name": "my-plugin",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch --outDir ../path/to/TX-5DR/plugins/my-plugin"
  },
  "devDependencies": {
    "@tx5dr/plugin-api": "^1.0.0",
    "typescript": "^5.0.0"
  }
}
```

这里的输出目录应当指向你本机当前 TX-5DR 运行时实际使用的插件目录；在开发环境下，默认也是系统用户数据目录下的 `TX-5DR/plugins`。如需切换基础目录，可通过 `TX5DR_DATA_DIR` 调整。

**tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ESNext",
    "outDir": "dist",
    "strict": true
  },
  "include": ["src"]
}
```

**src/index.ts**

```typescript
import type { PluginDefinition, PluginContext, ParsedFT8Message } from '@tx5dr/plugin-api';

const plugin: PluginDefinition = {
  name: 'my-plugin',
  version: '1.0.0',
  type: 'utility',

  settings: {
    targetPrefix: {
      type: 'string',
      default: 'JA',
      label: 'targetPrefix',
      scope: 'operator',
    },
  },

  onLoad(ctx: PluginContext) {
    ctx.log.info('Plugin loaded', { operatorId: ctx.operator.id });
  },

  hooks: {
    onFilterCandidates(candidates: ParsedFT8Message[], ctx: PluginContext) {
      const prefix = ctx.config.targetPrefix as string;
      if (!prefix) return candidates;
      return candidates.filter(c =>
        c.message.senderCallsign?.startsWith(prefix)
      );
    },

    onQSOComplete(record, ctx) {
      const count = ctx.store.operator.get<number>('qsoCount', 0) + 1;
      ctx.store.operator.set('qsoCount', count);
      ctx.log.info('QSO completed', { callsign: record.callsign, total: count });
    },
  },
};

export default plugin;
```

**开发工作流**

```bash
# 终端 1：插件项目，直接编译到 TX-5DR 的插件目录
npm run dev

# 终端 2：TX-5DR，启动应用
yarn dev

# 修改插件代码 → tsc 自动编译 → 在 TX-5DR 界面点「重载插件」
```

### 5.3 策略插件示例

策略插件需要实现 `createStrategyRuntime(ctx)`，直接返回一个显式运行时对象，完整控制 QSO 流程：

```typescript
import type { PluginDefinition, StrategyRuntime, ParsedFT8Message } from '@tx5dr/plugin-api';

const plugin: PluginDefinition = {
  name: 'simple-strategy',
  version: '1.0.0',
  type: 'strategy',

  createStrategyRuntime(ctx): StrategyRuntime {
    let target: string | undefined;
    let attempts = 0;

    return {
      async decide(messages: ParsedFT8Message[]) {
        const call = messages.find(m =>
          m.message.targetCallsign === ctx.operator.callsign
        );

        if (call) {
          target = call.message.senderCallsign;
          attempts = 0;
        } else if (target) {
          attempts++;
          if (attempts > 5) {
            target = undefined;
          }
        }

        return { stop: false };
      },

      getTransmitText() {
        if (!target) {
          return `CQ ${ctx.operator.callsign} ${ctx.operator.grid}`;
        }
        return `${target} ${ctx.operator.callsign} -01`;
      },

      requestCall(callsign) {
        target = callsign;
        attempts = 0;
      },

      patchContext() {},
      setState() {},
      setSlotContent() {},
      reset() {
        target = undefined;
        attempts = 0;
      },
      getSnapshot() {
        return {
          currentState: target ? 'TX2' : 'TX6',
          context: { targetCallsign: target },
          availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6'],
        };
      },
    };
  },
};

export default plugin;
```

---

## 6. 内置插件参考

### 6.1 standard-qso（内置策略）

**位置**：`packages/server/src/plugin/builtins/standard-qso/`

这是系统内置的标准 FT8/FT4 QSO 策略，实现了完整的 TX1-TX6 状态机。所有操作员默认使用此策略。

#### Settings（均为 operator scope）

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `strategyOverview` | info | `''` | 纯说明节点，介绍该策略插件负责的标准通联流程 |
| `autoReplyToCQ` | boolean | false | 自动回复 CQ 呼叫 |
| `autoResumeCQAfterFail` | boolean | false | QSO 失败后自动恢复 CQ |
| `autoResumeCQAfterSuccess` | boolean | false | QSO 成功后自动恢复 CQ |
| `replyToWorkedStations` | boolean | false | 允许回复已通联过的电台 |
| `targetSelectionPriorityMode` | string | `'dxcc_first'` | 目标优先级：`dxcc_first` / `new_callsign_first` / `balanced` |
| `maxQSOTimeoutCycles` | number | 6 | QSO 超时的最大周期数 |
| `maxCallAttempts` | number | 5 | TX1 状态最大呼叫次数 |

#### QuickActions

以下开关出现在右上角自动化下拉面板中（均为 toggle 类型）：

- `autoReplyToCQ`
- `autoResumeCQAfterFail`
- `autoResumeCQAfterSuccess`
- `replyToWorkedStations`

#### 架构说明

`standard-qso` 插件在插件目录内直接维护自己的 `StandardQSOPluginRuntime`。它通过插件上下文直接读取和驱动运行时，不再依赖 core 中的旧策略类、桥接层或适配器：

- `ctx.operator.callsign/grid/frequency/mode` → 组装为运行时 `OperatorConfig`
- `ctx.config.autoReplyToCQ` 等 → 组装为运行时 `OperatorConfig`（**来自 plugin settings，不再来自 RadioOperatorConfig**）
- `ctx.operator.hasWorkedCallsign()` → `runtime.hasWorkedCallsign()`
- `ctx.operator.recordQSO()` → `runtime.recordQSOLog()`

### 6.2 snr-filter（内置示例工具）

**位置**：`packages/server/src/plugin/builtins/snr-filter/`

最简工具插件示例，展示 `onFilterCandidates` 的用法。**默认未启用**，需在设置面板手动启用。

#### Settings（global scope）

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `filterOverview` | info | `''` | 纯说明节点，介绍该工具插件会在主策略前先做 SNR 过滤 |
| `minSNR` | number | -15 | 最低信噪比（dB），低于此值的候选被过滤 |

### 6.3 callsign-prefix-filter（字符串数组过滤示例）

**位置**：`packages/server/src/plugin/builtins/callsign-prefix-filter/`

展示 `string[]` 设置和 global-scope utility 配置的最小示例。它按前缀或精确名单过滤候选呼号，适合验证：

- `string[]` 类型设置
- global-scope utility settings
- `onFilterCandidates` 与其他过滤插件的叠加执行

### 6.4 worked-station-bias（评分示例）

**位置**：`packages/server/src/plugin/builtins/worked-station-bias/`

展示 `onScoreCandidates` 和日志本查询的示例。该插件不会过滤任何候选，只会：

- 对未通联过的呼号加分
- 对已通联过的呼号减分

它适合和 `snr-filter`、`callsign-prefix-filter` 同时启用，用于验证 filter → score 的组合链路。

### 6.5 qso-session-inspector（广播 Hook + 面板示例）

**位置**：`packages/server/src/plugin/builtins/qso-session-inspector/`

这是一个纯观察型插件，用来验证广播 Hook、operator-scope 存储和面板推送：

- `onSlotStart`
- `onDecode`
- `onQSOStart`
- `onQSOComplete`
- `onQSOFail`
- `ctx.store.operator`
- `ctx.ui.send(...)`

它会在操作员卡片下方提供两个面板：统计面板和最近事件日志。

### 6.6 watched-callsign-autocall（待机守候自动起呼）

**位置**：`packages/server/src/plugin/builtins/watched-callsign-autocall/`

该插件用于验证“operator-scope 配置驱动的 utility 插件”这一真实场景：

- 插件默认不启用；启用后也没有额外的 operator 开关
- `watchList` 为空即表示当前操作者不启用
- 仅在操作者处于纯待机（未发射、策略处于待机且没有锁定目标）时生效
- 命中后复用现有 `requestCall(...)` 流程自动设定目标并开始发射
- `watchList` 纯文本默认按完整呼号精确匹配；只要写入正则语法，就按正则规则匹配，例如 `^JA` 可实现前缀守候
- `watchList` 允许保留以 `#` 开头的注释行，便于维护大名单
- 所有触发模式都会额外包含“直接对我呼叫”的情况

#### Settings（均为 operator scope）

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `watchOverview` | info | `''` | 场景说明：适合守候 DX、朋友台、稀有实体或 sked |
| `watchList` | string[] | `[]` | 守候规则列表，按顺序决定优先级；纯文本为精确匹配，正则语法可直接使用，`#` 开头行为注释 |
| `triggerMode` | string | `'cq'` | 触发条件：`cq` / `cq-or-signoff` / `any` |
| `autocallPriority` | number | `100` | 自动起呼优先级；多个自动起呼插件同槽命中时，值越大越优先 |

### 6.7 watched-novelty-autocall（守候新类型自动起呼）

**位置**：`packages/server/src/plugin/builtins/watched-novelty-autocall/`

该插件展示如何基于 operator 自己的日志本分析结果，在纯待机时自动守候“新类型”目标：

- 只要启用了任一守候项（新 DXCC / 新网格 / 新呼号），命中任意一个已启用类型就会提议自动起呼
- 仅在操作者处于纯待机（未发射、策略处于待机且没有锁定目标）时生效
- 依赖 Host 在插件运行时为 `ParsedFT8Message.logbookAnalysis` 注入当前 operator 视角的日志本分析结果
- `watchNewDxcc` 会忽略 `dxccStatus='deleted'` 的实体
- 与其他自动起呼插件通过 `autocallPriority` 做确定性仲裁，而不是靠广播 Hook 的竞态先后

#### Settings（均为 operator scope）

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `noveltyOverview` | info | `''` | 场景说明：适合在待机时追逐新的实体、网格或呼号 |
| `watchNewDxcc` | boolean | `false` | 命中新 DXCC 时提议自动起呼 |
| `watchNewGrid` | boolean | `false` | 命中新网格时提议自动起呼 |
| `watchNewCallsign` | boolean | `false` | 命中新呼号时提议自动起呼 |
| `triggerMode` | string | `'cq'` | 触发条件：`cq` / `cq-or-signoff` / `any` |
| `autocallPriority` | number | `80` | 自动起呼优先级；默认低于守候呼号插件 |

### 6.8 heartbeat-demo（timer + button quickAction 示例）

**位置**：`packages/server/src/plugin/builtins/heartbeat-demo/`

该插件用于验证插件生命周期独立于引擎、电台是否连接，以及 button 型 quickAction：

- `onLoad` / `onUnload`
- `ctx.timers.set(...)`
- `hooks.onTimer`
- `ctx.store.global`
- `quickActions[type='button']`

它会周期性推送一个心跳状态面板，并提供一个“重置心跳计数”的按钮动作。

---

## 7. 插件系统架构

### 7.1 生命周期

```
应用启动 / 插件子系统启动（独立于引擎是否成功启动）
  └─ PluginManager.start()
       ├─ 注册所有内置插件（BUILTIN_PLUGINS 数组）
       ├─ 扫描 {dataDir}/plugins/ 加载用户插件
       ├─ 为当前所有操作员调用 initInstancesForOperator()
       └─ 广播插件系统快照

新增操作员
  └─ initInstancesForOperator(operatorId)
       ├─ 为该操作员上的所有插件创建 PluginContext
       ├─ 为策略插件创建 StrategyRuntime
       └─ 对已启用实例调用 onLoad()

移除操作员
  └─ removeInstancesForOperator(operatorId)
       └─ 为该操作员上的相关插件调用 onUnload()

插件重载 / 重扫
  └─ reloadPlugins() / reloadPlugin(name) / rescanPlugins()
       ├─ 先把插件系统状态切到 reloading 并广播快照
       ├─ 卸载受影响实例（onUnload）
       ├─ 重新加载插件定义
       ├─ 为相关操作员重新创建实例（onLoad）
       └─ 切回 ready / error 并广播新的插件系统快照

应用关闭
  └─ PluginManager.shutdown()
       └─ 为所有实例调用 onUnload()
            ├─ 清理所有定时器
            └─ flush 持久化存储
```

插件子系统与引擎运行状态解耦：电台未连接、引擎未成功进入解码状态，或引擎被停止，都不应影响插件的加载、重载、设置管理和客户端同步。

### 7.2 Hook 分发机制

`PluginHookDispatcher` 负责 Pipeline/Broadcast hooks；策略插件的核心决策则直接走显式 runtime：

```
onFilterCandidates（Pipeline）：
  active-plugin-A → active-plugin-B → ... → 最终候选列表
  每步：200ms 超时 + 空列表安全网

strategy runtime：
  仅活跃策略插件 → runtime.decide() / runtime.getTransmitText()
  用户编辑上下文 / 状态 / 槽位 → 直接调用 runtime.patchContext() / setState() / setSlotContent()
  用户切换发射周期 → 走核心 typed command，而不是插件消息桥

onQSOComplete（Broadcast）：
  utility-A, utility-B, strategy 并发执行（Promise.allSettled）
  单个出错不影响其他
```

所有 hook 调用都有 **200ms 超时**（`Promise.race`）。显式 strategy runtime 方法不走 `PluginHookDispatcher`，因此不受这个 hook 超时封装约束。

### 7.3 策略运行时实现

策略插件应当在插件目录内直接实现自己的运行时，不再通过 bridge / adapter 复用旧策略系统：

```
PluginContext.operator (OperatorControl)
    │
    ▼
standard-qso/StandardQSOPluginRuntime.ts
    │    直接读取 ctx.operator.* 和 ctx.config.*
    │    直接维护状态机、槽位文本与 QSO 生命周期
    │
    ▼
Strategy runtime methods（decide / getTransmitText / patchContext / setState ...）
```

这样可以确保迁移是彻底的：标准策略的实现、配置和行为都以内置插件为唯一真相源。

当前系统内部与策略运行时相关的核心控制链路已经是强类型直连：

- WebSocket：`setOperatorRuntimeState` / `setOperatorRuntimeSlotContent` / `setOperatorTransmitCycles`
- Server：`PluginManager.patchOperatorRuntimeContext()` / `setOperatorRuntimeState()` / `setOperatorRuntimeSlotContent()`
- Runtime：`patchContext()` / `setState()` / `setSlotContent()` / `getSnapshot()`

而 `pluginUserAction` 仅保留给插件自定义前后端交互，不再承担系统内部控制职责。

### 7.4 错误隔离

```
单次 hook 执行
  ├─ 200ms 超时 → 超时报错，记录错误
  ├─ 抛出异常 → 捕获，记录错误
  └─ 正常返回

错误追踪（PluginErrorTracker）
  ├─ 每个插件每个 hook 独立计数
  ├─ 连续 5 次错误 → 自动禁用该插件
  └─ 广播 pluginStatusChanged 事件通知前端

Pipeline 额外安全网
  └─ onFilterCandidates 返回空数组（输入非空）→ 跳过该插件，保留上一步结果
```

### 7.5 多插件冲突处理

| 情景 | 处理方式 |
|------|---------|
| 两个工具插件同时定义 `onFilterCandidates` | Pipeline 链式执行，A 的输出是 B 的输入 |
| 两个工具插件同时定义 `onQSOComplete` | 并发 fire-and-forget，互不干扰 |
| 两个自动起呼工具插件同时定义 `onAutoCallCandidate` | Host 统一收集提议后仲裁：优先级高者胜，再按命中顺序和插件名稳定排序 |
| 两个策略插件（理论上不可能）| 每个操作员只能选择一个策略，UI 层为单选 |
| 工具插件过滤器把候选清空 | 安全网保留上一步结果，跳过该插件 |

---

## 8. REST API 与 WebSocket 事件

### REST API

当前插件管理接口统一挂载在 `/api/plugins`：

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/api/plugins` | 获取插件系统完整快照（state / generation / plugins / lastError） |
| `POST` | `/api/plugins/:name/enable` | 启用插件 |
| `POST` | `/api/plugins/:name/disable` | 禁用插件 |
| `PUT` | `/api/plugins/:name/settings` | 更新 global-scope 设置 |
| `GET` | `/api/plugins/:name/operator/:id/settings` | 获取 operator-scope 设置 |
| `PUT` | `/api/plugins/:name/operator/:id/settings` | 更新 operator-scope 设置 |
| `PUT` | `/api/plugins/operators/:id/strategy` | 设置操作员使用的策略插件 |
| `POST` | `/api/plugins/reload` | 重载全部插件定义与实例，不重启引擎 |
| `POST` | `/api/plugins/:name/reload` | 重载单个插件 |
| `POST` | `/api/plugins/rescan` | 重新扫描插件目录并应用新增/删除/变更 |

### WebSocket 事件

| 事件 | 方向 | 说明 |
|------|------|------|
| `pluginList` | Server → Client | 插件系统完整快照（启动、重载、重扫或连接握手后推送） |
| `pluginStatusChanged` | Server → Client | 单个插件状态变更，载荷包含 `generation` 与最新 `plugin` |
| `pluginData` | Server → Client | 插件通过 `ctx.ui.send()` 推送的面板数据，载荷包含 `pluginName + operatorId + panelId + data` |
| `pluginLog` | Server → Client | 插件 `ctx.log.*` 的日志条目（前端显示于 Settings → Plugins 的日志面板） |
| `pluginUserAction` | Client → Server | 插件自定义用户动作（触发 `hooks.onUserAction`） |

> 补充：操作员 runtime 的核心控制命令不是插件专用事件，它们走系统级 WebSocket 命令：
> - `setOperatorContext`
> - `setOperatorRuntimeState`
> - `setOperatorRuntimeSlotContent`
> - `setOperatorTransmitCycles`

### PluginSystemSnapshot / PluginStatus 数据结构

```typescript
interface PluginSystemSnapshot {
  state: 'ready' | 'reloading' | 'error';
  generation: number;
  plugins: PluginStatus[];
  lastError?: string;
}

interface PluginStatus {
  name: string;
  type: 'strategy' | 'utility';
  version: string;
  description?: string;
  isBuiltIn: boolean;
  loaded: boolean;
  enabled: boolean;
  autoDisabled: boolean;   // 是否被自动禁用（连续错误）
  errorCount: number;
  lastError?: string;
  assignedOperatorIds?: string[];  // strategy 插件当前分配到的操作员
  settings?: Record<string, PluginSettingDescriptor>;
  quickActions?: PluginQuickAction[];
  panels?: PluginPanelDescriptor[];
  permissions?: string[];
  locales?: Record<string, Record<string, string>>;  // 插件自带翻译
}
```

---

## 9. 前端 UI 集成

### 插件出现的 UI 位置

| 位置 | 内容 |
|------|------|
| 设置 → 插件 Tab | **全局**：utility 插件启用状态草稿 + global-scope 设置草稿，由设置弹窗统一保存 |
| 设置 → 插件 Tab | **调试**：插件日志面板（当前前端会话态，支持按插件/级别过滤与清空） |
| 设置 → 操作员配置 | **每操作员**：策略插件选择器 + 当前相关插件的 operator-scope 设置 |
| 主界面右上角“自动化”入口 | 当前选中操作员的 QuickActions 镜像入口 |
| 操作员面板右上角 | 当前操作员所有活跃插件注册的 QuickActions（策略插件 + 已启用 utility 插件，立即生效） |
| 操作员卡片下方 | 当前操作员相关插件声明的 Panels（按 `operatorId` 隔离的实时数据展示） |

### 翻译动态注册

前端收到 `pluginList` 快照时，自动调用 `registerPluginLocales(name, locales)` 将插件翻译注册到 `i18next` 的 `plugin:{name}` 命名空间。`PluginSettingField` 组件使用 `resolvePluginLabel(label, pluginName)` 从对应命名空间查找翻译。

### 设置保存模型

- **插件管理页（全局）**：utility 插件启用状态与 global-scope 设置先进入前端草稿态，再由设置弹窗统一保存
- **操作员插件设置**：当前仍按插件卡片局部保存
- **QuickAction toggle**：直接写入对应 operator-scope setting，并立即触发 `onConfigChange`
- **QuickAction button**：通过 `pluginUserAction(pluginName, actionId, operatorId)` 触发 `hooks.onUserAction`

---

## 10. 新增内置插件指南

如需将新插件作为内置插件随系统发布（而不是用户手动安装）：

**1. 创建插件目录**

```
packages/server/src/plugin/builtins/my-new-plugin/
├── index.ts
└── locales/
    ├── zh.json
    └── en.json
```

**2. 实现 index.ts**

```typescript
import type { PluginDefinition } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

export const myNewPlugin: PluginDefinition = {
  name: 'my-new-plugin',
  // ...
};

export const myNewPluginLocales = { zh: zhLocale, en: enLocale };
```

**3. 在 `builtins/index.ts` 注册**

```typescript
// 添加 export
export { myNewPlugin, myNewPluginLocales } from './my-new-plugin/index.js';

// 在 BUILTIN_PLUGINS 数组中追加
export const BUILTIN_PLUGINS: BuiltinPluginEntry[] = [
  // ... 已有项
  {
    definition: myNewPlugin,
    locales: myNewPluginLocales,
    enabledByDefault: false,  // 默认不启用，用户手动开启
  },
];
```

`PluginManager` 会自动读取 `BUILTIN_PLUGINS` 数组，无需其他改动。

---

## 11. 代码文件导航

| 关注点 | 文件路径 |
|--------|---------|
| 插件类型定义（TypeScript 接口）| `packages/plugin-api/src/` |
| 插件 Schema（Zod 验证）| `packages/contracts/src/schema/plugin.schema.ts` |
| WebSocket 协议（插件事件 + runtime 控制命令）| `packages/contracts/src/schema/websocket.schema.ts` |
| 插件管理器（中央编排）| `packages/server/src/plugin/PluginManager.ts` |
| 插件加载器 | `packages/server/src/plugin/PluginLoader.ts` |
| Hook 分发引擎 | `packages/server/src/plugin/PluginHookDispatcher.ts` |
| PluginContext 工厂 | `packages/server/src/plugin/PluginContextFactory.ts` |
| standard-qso 运行时 | `packages/server/src/plugin/builtins/standard-qso/StandardQSOPluginRuntime.ts` |
| 内置插件目录 | `packages/server/src/plugin/builtins/` |
| standard-qso 完整实现 | `packages/server/src/plugin/builtins/standard-qso/index.ts` |
| snr-filter 示例 | `packages/server/src/plugin/builtins/snr-filter/index.ts` |
| callsign-prefix-filter 示例 | `packages/server/src/plugin/builtins/callsign-prefix-filter/index.ts` |
| worked-station-bias 示例 | `packages/server/src/plugin/builtins/worked-station-bias/index.ts` |
| qso-session-inspector 示例 | `packages/server/src/plugin/builtins/qso-session-inspector/index.ts` |
| watched-callsign-autocall 示例 | `packages/server/src/plugin/builtins/watched-callsign-autocall/index.ts` |
| watched-novelty-autocall 示例 | `packages/server/src/plugin/builtins/watched-novelty-autocall/index.ts` |
| heartbeat-demo 示例 | `packages/server/src/plugin/builtins/heartbeat-demo/index.ts` |
| REST API 路由 | `packages/server/src/routes/plugins.ts` |
| 前端插件组件 | `packages/web/src/components/plugins/` |
| 操作员插件面板聚合 | `packages/web/src/components/plugins/OperatorPluginPanels.tsx` |
| 操作员插件设置 | `packages/web/src/components/settings/OperatorPluginSettings.tsx` |
| 自动化下拉面板 | `packages/web/src/components/radio/automation/AutomationSettingsPanel.tsx` |
| 插件快照同步 Hook | `packages/web/src/hooks/usePluginSnapshot.ts` |
| 前端插件辅助 API | `packages/web/src/utils/pluginApi.ts` |
| 前端 API 方法 | `packages/core/src/api.ts`（`getPlugins`、`updatePluginOperatorSettings` 等） |

---

*文档生成于 2026-04，对应插件系统 v1.0 初始版本。*
