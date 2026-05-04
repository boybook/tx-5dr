# TX-5DR 插件系统开发指南

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
   - 4.6 [QuickActions 与 QuickSettings](#46-quickactions-与-quicksettings)
   - 4.7 [Panels](#47-panels)
   - 4.8 [持久化存储](#48-持久化存储)
   - 4.9 [自定义 UI（iframe 页面与面板）](#49-自定义-uiiframe-页面与面板)
   - 4.10 [文件存储](#410-文件存储)
   - 4.11 [日志同步 Provider](#411-日志同步-provider)
   - 4.12 [宿主设置访问](#412-宿主设置访问)
   - 4.13 [插件市场](#413-插件市场)
5. [编写你的第一个插件](#5-编写你的第一个插件)
   - 5.1 [最简工具插件（JS）](#51-最简工具插件js)
   - 5.2 [TypeScript 完整项目](#52-typescript-完整项目)
   - 5.3 [策略插件示例](#53-策略插件示例)
6. [内置插件参考](#6-内置插件参考)
7. [插件系统架构](#7-插件系统架构)
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

### 实例作用域

- **`instanceScope: 'operator'`**（默认）：为每个操作员分别创建一个实例
- **`instanceScope: 'global'`**：整个应用只创建一个共享实例（仅 utility 支持）

`global` 实例的设计目标，是承载"全局资源 + 按呼号分发"的插件，例如日志同步 Provider。此类插件通常需要：

- 共享一份证书、登录态或远端客户端
- 面向多个操作员/多个呼号工作
- 通过 `ctx.logbook.forCallsign(callsign)` 显式访问目标日志本

`global` 实例当前只支持 `utility` 插件，并受到以下约束：

- 不能声明 operator-scope `settings`
- 不能声明 `quickSettings`
- 不能声明 operator 面板 `panels`
- 不能实现依赖单个操作员运行时语义的 hooks（如 `onDecode`、`onQSOComplete`、`onAutoCallCandidate` 等）

### 设置作用域

- **`global` scope**：所有操作员共享，在"插件设置"全局面板中显示（如 API Key、黑名单）
- **`operator` scope**：每个操作员独立，在操作员配置面板中显示（如 autoReplyToCQ）

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

### 内置插件目录

内置插件与用户插件遵循**相同的目录结构**，位于独立包 `packages/builtin-plugins/src/`：

```
packages/builtin-plugins/src/
├── standard-qso/           # 策略插件：标准 QSO 流程
├── snr-filter/             # 工具插件：SNR 过滤
├── no-reply-memory-filter/ # 工具插件：无回复记忆过滤
├── callsign-filter/        # 工具插件：呼号过滤
├── worked-station-bias/    # 工具插件：已通联偏置评分
├── watched-callsign-autocall/  # 工具插件：守候呼号自动起呼
├── watched-novelty-autocall/   # 工具插件：守候新类型自动起呼
├── autocall-idle-frequency/    # 工具插件：自动起呼择频
├── lotw-sync/              # 工具插件：LoTW 日志同步
├── qrz-sync/               # 工具插件：QRZ 日志同步
├── wavelog-sync/           # 工具插件：WaveLog 日志同步
└── qso-udp-broadcast/      # 工具插件：QSO UDP 广播
```

内置插件的翻译通过 `import ... with { type: 'json' }` 编译进 bundle，无运行时 I/O。

每个插件目录下的结构示例：

```
standard-qso/
├── index.ts                # 导出 PluginDefinition + locales + 命名常量
├── StandardQSOPluginRuntime.ts  # 策略运行时（仅策略插件）
└── locales/
    ├── zh.json
    └── en.json
```

带自定义 UI 的插件：

```
lotw-sync/
├── index.ts
├── provider.ts             # LogbookSyncProvider 实现
├── locales/
│   ├── zh.json
│   └── en.json
└── ui/                     # iframe 页面静态资源
    ├── settings.html
    ├── settings.css
    ├── settings.js
    └── download-wizard.html
```

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
> 对于独立插件项目，`@tx5dr/plugin-api` 是唯一的公共开发入口。
> 请优先从这里导入插件定义、上下文、消息类型与常用枚举，而不要直接依赖 `@tx5dr/contracts`。

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

  /**
   * 插件实例作用域
   * - 'operator'：每个操作员一个实例（默认）
   * - 'global'：整个应用共享一个实例（仅 utility 支持）
   */
  instanceScope?: 'operator' | 'global';

  /** 可选：人类可读的描述 */
  description?: string;

  /** 可选：作者名 */
  author?: string;

  /** 可选：所需权限声明 */
  permissions?: (
    | 'network'
    | 'radio:read' | 'radio:control' | 'radio:power'
    | 'settings:ft8' | 'settings:decode-windows' | 'settings:realtime'
    | 'settings:frequency-presets' | 'settings:station'
    | 'settings:psk-reporter' | 'settings:ntp'
  )[];

  /**
   * 声明式设置项
   * 键名为 setting key，前端自动渲染对应的 UI 控件
   */
  settings?: Record<string, PluginSettingDescriptor>;

  /**
   * 快捷操作按钮
   * 出现在操作员面板的自动化下拉区域，点击触发 hooks.onUserAction
   */
  quickActions?: PluginQuickAction[];

  /**
   * 快捷设置
   * 引用 operator-scope setting，在自动化面板中渲染为紧凑控件
   */
  quickSettings?: PluginQuickSetting[];

  /**
   * 数据展示面板
   * 出现在操作员面板下方，通过 ctx.ui.send() 推送数据
   */
  panels?: PluginPanelDescriptor[];

  /** 声明需要哪些存储作用域 */
  storage?: { scopes: ('global' | 'operator')[] };

  /**
   * 自定义 UI 页面声明
   */
  ui?: {
    /** 静态资源目录（相对于插件根目录，默认 'ui'） */
    dir?: string;
    /** 注册的页面列表 */
    pages?: PluginUIPageDescriptor[];
  };

  /**
   * 策略运行时工厂
   * type='strategy' 时必填；type='utility' 时不得提供
   */
  createStrategyRuntime?(ctx: PluginContext): StrategyRuntime;

  /** 插件实例加载时调用 */
  onLoad?(ctx: PluginContext): void | Promise<void>;

  /** 插件实例卸载时调用，定时器自动清理 */
  onUnload?(ctx: PluginContext): void | Promise<void>;

  /** Hook 实现 */
  hooks?: PluginHooks;
}
```

权限说明：

| 权限 | 授予能力 |
|------|---------|
| `network` | `ctx.fetch()` HTTP 请求 |
| `radio:read` | `ctx.radio.capabilities.getSnapshot()` / `getState()` / `refresh()` |
| `radio:control` | `ctx.radio.capabilities.write()` |
| `radio:power` | `ctx.radio.power.*` |
| `settings:ft8` | `ctx.settings.ft8` |
| `settings:decode-windows` | `ctx.settings.decodeWindows` |
| `settings:realtime` | `ctx.settings.realtime` |
| `settings:frequency-presets` | `ctx.settings.frequencyPresets` |
| `settings:station` | `ctx.settings.station` |
| `settings:psk-reporter` | `ctx.settings.pskReporter` |
| `settings:ntp` | `ctx.settings.ntp` |

### 4.2 PluginContext

运行时注入的上下文对象，是插件与系统交互的唯一入口。

```typescript
interface PluginContext {
  /** 当前生效的设置值（global + operator 合并，只读） */
  readonly config: Readonly<Record<string, unknown>>;

  /**
   * 更新本插件实例的设置（自更新）
   * 浅合并后持久化，触发 onConfigChange，推送前端
   */
  updateConfig(patch: Record<string, unknown>): Promise<void>;

  /** 持久化 KV 存储 */
  readonly store: {
    readonly global: KVStore;    // 所有操作员共享
    readonly operator: KVStore;  // 当前实例独占
  };

  /** 日志接口（输出到系统日志 + 前端日志面板） */
  readonly log: PluginLogger;

  /** 命名定时器管理 */
  readonly timers: PluginTimers;

  /** 操作员控制 */
  readonly operator: OperatorControl;

  /** 物理电台控制 */
  readonly radio: RadioControl;

  /** 日志本访问（查询/写入/通知） */
  readonly logbook: LogbookAccess;

  /** 波段/解码数据访问 */
  readonly band: BandAccess;

  /** 向前端面板推送数据 + 自定义 iframe 页面通信 */
  readonly ui: UIBridge;

  /** 二进制文件持久化存储 */
  readonly files: PluginFileStore;

  /** 日志同步 Provider 注册入口 */
  readonly logbookSync: LogbookSyncRegistrar;

  /**
   * 宿主设置访问（权限门控）
   * 每个命名空间需要对应的 settings:* 权限
   */
  readonly settings: HostSettingsControl;

  /**
   * 受控 HTTP fetch
   * 仅声明 permissions: ['network'] 后可用，否则为 undefined
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
  /** 强制 flush 待写入数据到磁盘 */
  flush(): Promise<void>;
}
```

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

日志同时输出到：系统日志文件、前端设置页中的"插件日志"面板。

#### PluginTimers

```typescript
interface PluginTimers {
  set(id: string, intervalMs: number): void;
  clear(id: string): void;
  clearAll(): void;
}
```

定时器触发时调用 `hooks.onTimer(timerId, ctx)`。`clearAll()` 在 `onUnload` 时自动调用。

#### RadioControl

```typescript
interface RadioControl {
  readonly frequency: number;
  readonly band: string;
  readonly isConnected: boolean;
  readonly capabilities: RadioCapabilitiesControl;
  readonly power: RadioPowerControl;
  setFrequency(freq: number): Promise<void>;
}

interface RadioCapabilitiesControl {
  getSnapshot(): CapabilityList;                         // 需 radio:read
  getState(id: string): CapabilityState | null;          // 需 radio:read
  refresh(): Promise<CapabilityList>;                    // 需 radio:read
  write(payload: WriteCapabilityPayload): Promise<void>; // 需 radio:control
}

interface RadioPowerControl {
  getSupport(profileId?: string): Promise<RadioPowerSupportInfo>; // 需 radio:read
  getState(profileId?: string): RadioPowerStateEvent | null;      // 需 radio:read
  set(state, options?: { profileId?: string; autoEngine?: boolean }): Promise<RadioPowerResponse>; // 需 radio:power
}
```

`ctx.radio` 只在服务端插件上下文中可用。`power.set()` 的 `profileId` 缺省为当前 active profile，`autoEngine` 缺省为 `true`。

#### LogbookAccess

```typescript
interface LogbookAccess {
  // 只读查询
  hasWorked(callsign: string): Promise<boolean>;
  hasWorkedDXCC(dxccEntity: string): Promise<boolean>;
  hasWorkedGrid(grid: string): Promise<boolean>;

  // 高级查询
  queryQSOs(filter: QSOQueryFilter): Promise<QSORecord[]>;
  countQSOs(filter?: QSOQueryFilter): Promise<number>;

  // 呼号绑定访问器（global 实例用）
  forCallsign(callsign: string): CallsignLogbookAccess;

  // 写入
  addQSO(record: QSORecord): Promise<void>;
  updateQSO(qsoId: string, updates: Partial<QSORecord>): Promise<void>;

  // 通知
  notifyUpdated(): Promise<void>;
}

interface CallsignLogbookAccess {
  readonly callsign: string;
  getLogBookId(): Promise<string | null>;
  queryQSOs(filter: QSOQueryFilter): Promise<QSORecord[]>;
  countQSOs(filter?: QSOQueryFilter): Promise<number>;
  addQSO(record: QSORecord): Promise<void>;
  updateQSO(qsoId: string, updates: Partial<QSORecord>): Promise<void>;
  getStatistics(): Promise<LogBookStatistics | null>;
  notifyUpdated(operatorId?: string): Promise<void>;
}
```

```typescript
interface QSOQueryFilter {
  callsign?: string;
  timeRange?: { start: number; end: number };
  frequencyRange?: { min: number; max: number };
  mode?: string;
  band?: string;
  qslStatus?: 'confirmed' | 'uploaded' | 'none';
  limit?: number;
  offset?: number;
  orderDirection?: 'asc' | 'desc';
}
```

#### BandAccess

```typescript
interface BandAccess {
  getActiveCallers(): ParsedFT8Message[];
  getLatestSlotPack(): SlotPack | null;
  findIdleTransmitFrequency(options?: IdleTransmitFrequencyOptions): number | null;
  evaluateAutoTargetEligibility(message: ParsedFT8Message): {
    eligible: boolean;
    reason: string;
    modifier?: string;
  };
}
```

#### UIBridge

```typescript
interface UIBridge {
  /** 推送结构化面板数据 */
  send(panelId: string, data: unknown): void;

  /** 更新面板运行期 meta（标题、可见性等） */
  setPanelMeta(panelId: string, meta: PanelMeta): void;

  /** 替换一个运行期 UI Contribution group */
  setPanelContributions(groupId: string, panels: PluginPanelDescriptor[]): void;

  /** 清空一个运行期 UI Contribution group */
  clearPanelContributions(groupId: string): void;

  /** 注册 iframe 页面消息处理器（每实例一个） */
  registerPageHandler(handler: PluginUIHandler): void;

  /** 推送到指定 page session */
  pushToSession(pageSessionId: string, action: string, data?: unknown): void;

  /** 列出当前实例下某 pageId 的活跃 session */
  listActivePageSessions(pageId: string): PluginUIPageSessionInfo[];

  /** 推送到 iframe 页面（仅当该 pageId 恰好有一个 session 时可用） */
  pushToPage(pageId: string, action: string, data?: unknown): void;
}

interface PanelMeta {
  title?: string | null;
  titleValues?: Record<string, unknown>;
  visible?: boolean;
}

interface PluginUIHandler {
  onMessage(
    pageId: string,
    action: string,
    data: unknown,
    requestContext: PluginUIRequestContext,
  ): Promise<unknown>;
}
```

`requestContext` 由宿主基于页面 session 注入，包含：

- `pageSessionId` — 页面 session ID
- `user` — 当前用户信息（tokenId, role, operatorIds, permissionGrants）
- `instanceTarget` — 插件实例目标（global 或 operatorId）
- `resource` — 绑定的资源（如 callsign）
- `page` — 页面上下文（含 `push()` 快捷方法）
- `files` — 页面 scope 的文件存储

### 4.3 OperatorControl

```typescript
interface OperatorControl {
  readonly id: string;
  readonly isTransmitting: boolean;
  readonly callsign: string;
  readonly grid: string;
  readonly frequency: number;
  readonly mode: ModeDescriptor;
  readonly transmitCycles: number[];
  /** 当前自动化运行时快照 */
  readonly automation: StrategyRuntimeSnapshot | null;

  startTransmitting(): void;
  stopTransmitting(): void;
  call(callsign: string, lastMessage?: { message: FrameMessage; slotInfo: SlotInfo }): void;
  setTransmitCycles(cycles: number | number[]): void;
  hasWorkedCallsign(callsign: string): Promise<boolean>;
  isTargetBeingWorkedByOthers(targetCallsign: string): boolean;
  recordQSO(record: QSORecord): void;
  notifySlotsUpdated(slots: OperatorSlots): void;
  notifyStateChanged(state: string): void;
}
```

### 4.4 Hook 分类与语义

#### Pipeline Hooks（活跃插件链式处理）

链式执行，前一个插件的输出是下一个插件的输入。

| Hook | 参数 | 返回 | 安全网 |
|------|------|------|--------|
| `onFilterCandidates` | `candidates: ParsedFT8Message[], ctx` | 过滤后的列表 | 若返回空数组且输入非空，跳过此插件 |
| `onScoreCandidates` | `candidates: ScoredCandidate[], ctx` | 评分后的列表 | 无 |
| `onAutoCallCandidate` | `slotInfo, messages, ctx` | `AutoCallProposal \| null` | 多插件按优先级仲裁 |
| `onConfigureAutoCallExecution` | `request, plan, ctx` | 更新后的 plan | 链式修改执行计划 |

#### Strategy Runtime（仅活跃策略插件）

每个操作员只有一个活跃策略插件。策略插件必须显式创建 `StrategyRuntime`：

| 方法 | 触发时机 | 说明 |
|------|---------|------|
| `decide(messages, meta?)` | 每个时隙开始 | 核心决策，返回 `StrategyDecision` |
| `getTransmitText()` | 编码时机 | 返回要发射的文本，null 表示不发射 |
| `requestCall(callsign, lastMessage?)` | 用户手动点击呼叫 | 处理用户主动呼叫 |
| `patchContext(patch)` | 用户修改上下文 | 更新 target/report 等策略上下文 |
| `setState(state)` | 用户手动切换 TX 状态 | 直接切换策略运行时状态 |
| `setSlotContent({ slot, content })` | 用户编辑槽位文本 | 直接更新指定槽位文本 |
| `getSnapshot()` | 服务端同步状态给客户端 | 返回当前状态/槽位/上下文快照 |
| `reset(reason?)` | 插件重载、策略切换等 | 重置策略运行时 |
| `onTransmissionQueued?(text)` | 发射内容进入编码队列 | 可选通知 |

`StrategyDecision` 接口：

```typescript
interface StrategyDecision {
  stop?: boolean;        // 停止自动化；isReDecision 时还会中断当前发射
  qsoFailure?: QSOFailureInfo;
}

interface StrategyDecisionMeta {
  isReDecision?: boolean; // 是否为晚到解码的重决策
}
```

#### Broadcast Hooks（所有活跃插件并发接收）

Fire-and-forget，不阻塞主流程。

| Hook | 签名 | 典型用途 |
|------|------|---------|
| `onSlotStart` | `(slotInfo, messages, ctx)` | 定时统计、状态检查 |
| `onDecode` | `(messages, ctx)` | 监听模式、发现目标自动唤醒 |
| `onQSOStart` | `(info: { targetCallsign, grid? }, ctx)` | 记录 QSO 开始时间 |
| `onQSOComplete` | `(record: QSORecord, ctx)` | 统计、推送通知、外部上传 |
| `onQSOFail` | `(info: QSOFailureInfo, ctx)` | 记录失败原因 |
| `onTimer` | `(timerId, ctx)` | Band hopping、定时停止 |
| `onUserAction` | `(actionId, payload, ctx)` | 响应用户点击 QuickAction |
| `onConfigChange` | `(changes: Record<string, unknown>, ctx)` | 热更新内部状态 |

`onConfigChange` 接收一个 `changes` 对象，只包含本次变更的 key/value。

#### Autocall Proposal Hook

对于"守候型" utility 插件，推荐实现 `onAutoCallCandidate(slotInfo, messages, ctx)`，返回 `AutoCallProposal | null`：

```typescript
{
  callsign: string;
  priority?: number;     // 优先级，越大越优先
  lastMessage?: { message: FrameMessage; slotInfo: SlotInfo };
}
```

- Host 收集所有 proposal 后统一仲裁：`priority` 高者优先 → 命中消息顺序 → 插件名稳定排序
- 仲裁完成后最多执行一次 `requestCall()`
- 触发源是 CQ 时，proposal 仍受宿主统一的 directed CQ / modifier 过滤

#### Autocall Execution Hook

proposal 胜出后，Host 串行调用 `onConfigureAutoCallExecution(request, plan, ctx)` 来修改执行计划：

```typescript
interface AutoCallExecutionRequest {
  sourcePluginName: string;
  callsign: string;
  slotInfo: SlotInfo;
  sourceSlotInfo?: SlotInfo;
  lastMessage?: LastMessageInfo;
}

interface AutoCallExecutionPlan {
  audioFrequency?: number;
}
```

### 4.5 设置系统

#### PluginSettingDescriptor

```typescript
interface PluginSettingDescriptor {
  type: 'boolean' | 'number' | 'string' | 'string[]' | 'object[]' | 'info';
  default: unknown;
  label: string;         // i18n key
  description?: string;
  scope?: 'global' | 'operator';  // 默认 'global'
  min?: number;
  max?: number;
  options?: Array<{ label: string; value: string }>;
  /** type='object[]' 时用于生成编辑器字段 */
  itemFields?: Array<{
    key: string;
    type?: 'string' | 'number' | 'boolean';
    label: string;
    description?: string;
    placeholder?: string;
    required?: boolean;
  }>;
  /** 隐藏设置（持久化但不显示在 UI） */
  hidden?: boolean;
}
```

- `info` 类型是纯展示节点，不参与持久化和脏数据比较
- `hidden` 设置仍然持久化和注入 `ctx.config`，只是不在生成的 UI 中显示
- `object[]` 适合简单的全局共享列表；复杂交互建议用 iframe 设置页面

#### ctx.config 的合并规则

```
最终值 = operator-scope 配置 覆盖 global-scope 配置 覆盖 defaults
```

同一个 key 不能同时是 global 和 operator scope。`info` 和 `hidden` 类型不参与上述合并中的 scope 覆盖逻辑。

#### 持久化位置

- **Global settings**：`config.plugins.configs[pluginName].settings`（在 `config.json` 中）
- **Operator settings**：`config.plugins.operatorSettings[operatorId][pluginName]`（在 `config.json` 中）

#### 配置自更新

插件可通过 `ctx.updateConfig(patch)` 修改自身设置：

```typescript
await ctx.updateConfig({ lastSyncTime: Date.now() });
```

此时会走完整的 validate → persist → onConfigChange → 推送前端流程。

### 4.6 QuickActions 与 QuickSettings

#### QuickActions

QuickActions 出现在操作员面板右上角的自动化下拉面板中，点击触发 `hooks.onUserAction`。

```typescript
interface PluginQuickAction {
  id: string;
  label: string;  // i18n key 或直接文本
  icon?: string;  // 图标名
}
```

#### QuickSettings

QuickSettings 引用一个 operator-scope setting，在自动化面板中渲染为紧凑的开关控件。

```typescript
interface PluginQuickSetting {
  settingKey: string;  // 必须是 operator-scope boolean setting
}
```

**工作原理**：
1. 前端读取 `operatorSettings[pluginName][settingKey]` 决定开关状态
2. 用户切换后直接更新对应 operator-scope setting
3. 服务端触发 `onConfigChange`，`ctx.config` 动态反映新值

**与 QuickAction 的区别**：
- QuickAction（button）：点击 → `hooks.onUserAction`
- QuickSetting（toggle）：切换 → 更新 setting → `onConfigChange`

### 4.7 Panels

```typescript
interface PluginPanelDescriptor {
  id: string;
  title: string;  // i18n key 或直接文本
  component: 'table' | 'key-value' | 'chart' | 'log' | 'iframe';
  /** 仅 component='iframe' 时需要，引用 ui.pages 中的页面 id */
  pageId?: string;
  /** 可选字符串参数，传入 iframe */
  params?: Record<string, string>;
  /** 渲染位置，默认 'operator' */
  slot?: 'operator' | 'automation' | 'main-right' | 'voice-left-top' | 'voice-right-top';
  /** 宽度偏好，默认 'half' */
  width?: 'half' | 'full';
}
```

#### 数据格式

| component | 期望的 data 格式 |
|-----------|--------------|
| `key-value` | `{ [key: string]: string \| number }` |
| `table` | `Array<Record<string, unknown>>` |
| `log` | `string[]` |
| `chart` | 自定义（JSON 格式原样显示） |
| `iframe` | 不需要 `ctx.ui.send()` 推送，iframe 通过 Bridge SDK 通信 |

#### 数据推送

```typescript
ctx.ui.send('panel-id', { '总通联': 42, '今日': 5 });
```

数据通过 WebSocket `pluginData` 事件实时推送。

#### 运行期 UI Contribution

`PluginDefinition.panels` 是静态面板声明。运行时动态增减面板使用：

```typescript
ctx.ui.setPanelContributions('my-group', [
  { id: 'tab-1', title: 'Tab 1', component: 'iframe', pageId: 'my-page', slot: 'voice-right-top' },
]);

ctx.ui.clearPanelContributions('my-group');
```

`groupId` 不能使用保留的 `manifest`。`setPanelContributions` 是替换整个 group 的语义。

### 4.8 持久化存储

```typescript
// global scope
ctx.store.global.set('blacklist', ['BG5DRB', 'BG5CAM']);
const blacklist = ctx.store.global.get<string[]>('blacklist', []);

// operator scope
ctx.store.operator.set('qsoCount', 42);
```

**存储文件路径**：
- Global：`{dataDir}/plugin-data/{name}/global.json`
- Operator：`{dataDir}/plugin-data/{name}/operator-{operatorId}.json`

写入有 300ms debounce；卸载时自动 flush。需要立即持久化时调用 `await ctx.store.global.flush()`。

### 4.9 自定义 UI（iframe 页面与面板）

插件可以通过 iframe 托管自定义 HTML 页面。

#### 声明页面

```typescript
const plugin: PluginDefinition = {
  name: 'my-plugin',
  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'settings',
        title: 'Settings',
        entry: 'settings.html',
        accessScope: 'operator',           // 'admin' | 'operator', 默认 'admin'
        resourceBinding: 'callsign',       // 'none' | 'callsign' | 'operator', 默认 'none'
      },
    ],
  },
};
```

- `accessScope`: `admin` 仅管理员可访问；`operator` 操作员也可访问
- `resourceBinding`: 宿主据此校验请求中是否携带对应资源并做访问控制

#### 将 iframe 面板嵌入 UI

```typescript
panels: [
  { id: 'live-view', title: 'liveView', component: 'iframe', pageId: 'dashboard' },
  { id: 'controls', title: 'controls', component: 'iframe', pageId: 'settings', slot: 'automation' },
],
```

#### Bridge SDK

宿主自动在每个 iframe 页面中注入 Bridge SDK，通过 `window.tx5dr` 访问：

| 方法/属性 | 说明 |
|-----------|------|
| `tx5dr.params` | 只读参数对象 |
| `tx5dr.theme` | 当前主题：`'dark'` / `'light'` |
| `tx5dr.locale` | 当前语言：`'zh'` / `'en'` |
| `tx5dr.pageSessionId` | 宿主分配的页面 session ID |
| `tx5dr.ready` | Promise，首次宿主 init 后 resolve |
| `tx5dr.getState()` | 返回 Bridge 状态快照 |
| `tx5dr.onStateChange(cb)` | 监听状态变化，返回取消函数 |
| `tx5dr.onLocaleChange(cb)` | 监听语言变化，返回取消函数 |
| `tx5dr.onThemeChange(cb)` | 监听主题变化，返回取消函数 |
| `tx5dr.invoke(action, data)` | 发送请求到服务端 → `registerPageHandler` |
| `tx5dr.onPush(action, cb)` | 监听服务端主动推送 |
| `tx5dr.offPush(action, cb)` | 取消推送监听 |
| `tx5dr.resize(height)` | 报告内容高度 |
| `tx5dr.requestClose()` | 请求关闭当前页面 |
| `tx5dr.storeGet(key, default?)` | 读取页面 scope KV |
| `tx5dr.storeSet(key, value)` | 写入页面 scope KV |
| `tx5dr.storeDelete(key)` | 删除页面 scope KV |
| `tx5dr.fileUpload(path, file)` | 上传文件到页面 scope |
| `tx5dr.fileRead(path)` | 读取页面 scope 文件 |
| `tx5dr.fileDelete(path)` | 删除页面 scope 文件 |
| `tx5dr.fileList(prefix?)` | 列出页面 scope 文件 |

#### invoke / onPush 通信

**iframe → 服务端**：

```javascript
// iframe
const result = await tx5dr.invoke('getState', { key: 'counter' });
```

```typescript
// 服务端（onLoad 中注册）
ctx.ui.registerPageHandler({
  async onMessage(pageId, action, data) {
    if (action === 'getState') {
      return { counter: ctx.store.operator.get('counter', 0) };
    }
  },
});
```

**服务端 → iframe**：

```typescript
// 服务端
ctx.ui.pushToPage('dashboard', 'dataUpdated', { value: 42 });

// 或者精确推送到特定 session
for (const session of ctx.ui.listActivePageSessions('dashboard')) {
  ctx.ui.pushToSession(session.sessionId, 'refresh', { reason: 'timer' });
}
```

```javascript
// iframe
tx5dr.onPush('dataUpdated', (data) => {
  document.getElementById('value').textContent = data.value;
});
```

#### CSS Design Tokens

宿主自动注入 CSS 变量，适配明暗主题：

| 变量 | 说明 |
|------|------|
| `--tx5dr-bg` / `--tx5dr-bg-content` / `--tx5dr-bg-hover` | 背景色 |
| `--tx5dr-text` / `--tx5dr-text-secondary` | 文字颜色 |
| `--tx5dr-primary` | 主题色 |
| `--tx5dr-success` / `--tx5dr-warning` / `--tx5dr-danger` | 状态色 |
| `--tx5dr-border` | 边框颜色 |
| `--tx5dr-radius-sm` / `-md` / `-lg` | 圆角 |
| `--tx5dr-spacing-xs` / `-sm` / `-md` / `-lg` / `-xl` | 间距 |
| `--tx5dr-font` / `--tx5dr-font-mono` | 字体 |
| `--tx5dr-font-size-sm` / `-md` / `-lg` | 字号 |

#### 固定宿主路由

- `GET /api/plugins/:name/ui/*`：返回静态页面，自动注入 Bridge SDK
- `POST /api/plugins/:name/ui-invoke`：`tx5dr.invoke()` 转发
- `POST /api/plugins/:name/ui-store`：`tx5dr.store*()` 请求
- `POST /api/plugins/:name/ui-files`：`tx5dr.file*()` 请求
- `POST /api/plugins/:name/ui-session/heartbeat`：刷新 session TTL

iframe 页面应通过 Bridge SDK 调用，不应自行手写 fetch 伪造 session。

### 4.10 文件存储

```typescript
interface PluginFileStore {
  write(path: string, data: Buffer): Promise<void>;
  read(path: string): Promise<Buffer | null>;
  delete(path: string): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
}
```

**存储路径**：`{dataDir}/plugin-data/{pluginName}/files/`

**安全约束**：所有路径禁止目录穿越（`..`、绝对路径等被拒绝）。

### 4.11 日志同步 Provider

工具插件可以通过 `ctx.logbookSync.register()` 注册日志同步 Provider。

#### LogbookSyncProvider 接口

```typescript
interface LogbookSyncProvider {
  readonly id: string;
  readonly displayName: string;
  readonly icon?: string;
  readonly color?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  readonly accessScope?: 'admin' | 'operator';
  readonly settingsPageId: string;
  readonly actions?: SyncAction[];

  testConnection(callsign: string): Promise<SyncTestResult>;
  upload(callsign: string, options?: SyncUploadOptions): Promise<SyncUploadResult>;
  download(callsign: string, options?: SyncDownloadOptions): Promise<SyncDownloadResult>;
  isConfigured(callsign: string): boolean;
  isAutoUploadEnabled(callsign: string): boolean;

  /** 可选：上传前检查 */
  getUploadPreflight?(callsign: string): Promise<SyncUploadPreflightResult>;
}
```

#### SyncAction

```typescript
interface SyncAction {
  id: string;
  label: string;
  description?: string;
  icon?: 'download' | 'upload' | 'sync';
  operation?: 'upload' | 'download' | 'full_sync';  // 直接执行
  pageId?: string;                                    // 打开 iframe 页面
}
```

#### 注册流程

```typescript
onLoad(ctx) {
  const provider = new MyProvider(ctx);
  ctx.logbookSync.register(provider);

  ctx.ui.registerPageHandler({
    async onMessage(pageId, action, data) {
      // 处理设置页面的 invoke 请求
    },
  });
},
```

推荐声明为 `type: 'utility'` + `instanceScope: 'global'`，使用 `ctx.logbook.forCallsign(callsign)` 访问日志本。

### 4.12 宿主设置访问

插件可通过 `ctx.settings` 访问宿主级设置，每个命名空间需要对应的 `settings:*` 权限：

```typescript
interface HostSettingsControl {
  readonly ft8: HostSettingsNamespace<HostFT8Settings, HostFT8SettingsPatch>;
  readonly decodeWindows: HostSettingsNamespace<DecodeWindowSettings, DecodeWindowSettings>;
  readonly realtime: HostSettingsNamespace<RealtimeSettings, RealtimeSettings>;
  readonly frequencyPresets: HostFrequencyPresetsSettingsNamespace;
  readonly station: HostSettingsNamespace<StationInfo, HostStationInfoPatch>;
  readonly pskReporter: HostSettingsNamespace<PSKReporterConfig, HostPSKReporterSettingsPatch>;
  readonly ntp: HostSettingsNamespace<NtpServerListSettings, UpdateNtpServerListRequest>;
}

interface HostSettingsNamespace<TValue, TPatch> {
  get(): Promise<TValue>;
  update(patch: TPatch): Promise<TValue>;
}
```

### 4.13 插件市场

系统内置官方插件市场，支持从远端 catalog 安装、更新和卸载插件。

#### REST API

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/api/plugins/market/catalog` | 获取市场插件索引 |
| `GET` | `/api/plugins/market/catalog/:name` | 获取单个市场条目 |
| `POST` | `/api/plugins/market/:name/install` | 从市场安装插件 |
| `POST` | `/api/plugins/market/:name/update` | 从市场更新插件 |
| `DELETE` | `/api/plugins/market/:name` | 卸载市场插件（保留 plugin-data） |

市场条目包含 `name`、`latestVersion`、`minHostVersion`、`artifactUrl`、`sha256`、`size`、`channel`（`stable`/`nightly`）、`categories`、`keywords` 等字段。

---

## 5. 编写你的第一个插件

### 5.1 最简工具插件（JS）

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

放入插件目录后，在前端「设置 → 插件」中重载即可生效。

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
    "@tx5dr/plugin-api": "^1.6.0",
    "typescript": "^5.0.0"
  }
}
```

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

### 5.3 策略插件示例

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
          if (attempts > 5) target = undefined;
        }

        return { stop: false };
      },

      getTransmitText() {
        if (!target) return `CQ ${ctx.operator.callsign} ${ctx.operator.grid}`;
        return `${target} ${ctx.operator.callsign} -01`;
      },

      requestCall(callsign) { target = callsign; attempts = 0; },
      patchContext() {},
      setState() {},
      setSlotContent() {},
      reset() { target = undefined; attempts = 0; },
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

内置插件位于 `packages/builtin-plugins/src/`，共 12 个。均为 `@tx5dr/builtin-plugins` 包的一部分，由 `PluginManager` 在启动时自动加载。

### standard-qso

内置标准 FT8/FT4 QSO 策略。所有操作员默认使用此策略。

**Settings**（均为 operator scope）：

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `strategyOverview` | info | `''` | 策略说明节点 |
| `autoReplyToCQ` | boolean | false | 自动回复 CQ |
| `autoResumeCQAfterFail` | boolean | false | 失败后自动恢复 CQ |
| `autoResumeCQAfterSuccess` | boolean | false | 成功后自动恢复 CQ |
| `replyToWorkedStations` | boolean | false | 回复已通联电台 |
| `targetSelectionPriorityMode` | string | `'dxcc_first'` | 优先级：`dxcc_first` / `new_callsign_first` / `balanced` |
| `maxQSOTimeoutCycles` | number | 6 | 超时周期数 |
| `maxCallAttempts` | number | 5 | TX1 最大呼叫次数 |

**QuickSettings**：`autoReplyToCQ`、`autoResumeCQAfterFail`、`autoResumeCQAfterSuccess`、`replyToWorkedStations`

### snr-filter

展示 `onFilterCandidates` 的最简工具插件。默认未启用。

| Key（global） | 类型 | 默认值 |
|------|------|--------|
| `minSNR` | number | -15 |

### no-reply-memory-filter

无回复记忆过滤插件。默认未启用。跟踪哪些呼号在过去一段时间内未回复自己的呼叫，在下一次决策时过滤。

### callsign-filter

展示 `string[]` 设置和 `onFilterCandidates` 的过滤插件。默认未启用。

### worked-station-bias

展示 `onScoreCandidates` 和日志本查询的评分插件。对未通联过的呼号加分，对已通联过的减分，影响候选排序但不直接控制起呼。

### watched-callsign-autocall

守候指定呼号列表自动起呼。支持精确匹配和正则语法，`#` 开头行为注释。

| Key（operator scope） | 类型 | 默认值 |
|------|------|--------|
| `watchList` | string[] | `[]` |
| `triggerMode` | string | `'cq'` |
| `autocallPriority` | number | `100` |

### watched-novelty-autocall

守候新 DXCC / 新网格 / 新呼号自动起呼。依赖 `ParsedFT8Message.logbookAnalysis`。

| Key（operator scope） | 类型 | 默认值 |
|------|------|--------|
| `watchNewDxcc` | boolean | `false` |
| `watchNewGrid` | boolean | `false` |
| `watchNewCallsign` | boolean | `false` |
| `autocallPriority` | number | `80` |

### autocall-idle-frequency

自动起呼执行层插件：在自动起呼前挑选更空闲的发射音频频率。通过 `onConfigureAutoCallExecution` 实现。默认启用。

| Key（operator scope） | 类型 | 默认值 |
|------|------|--------|
| `autoSelectIdleFrequency` | boolean | `false` |

### lotw-sync

ARRL Logbook of The World 日志同步插件。展示完整 Provider 实现：证书管理、TQ8 上传、ADIF 下载。默认启用。`instanceScope: 'global'`。

### qrz-sync

QRZ.com 日志同步插件。最简 Provider 实现。默认启用。`instanceScope: 'global'`。

### wavelog-sync

WaveLog 自托管日志服务同步插件。支持多步配置和站台选择。默认启用。`instanceScope: 'global'`。

### qso-udp-broadcast

QSO 完成时通过 UDP 广播通联记录。服务端插件，无前端 UI。默认启用。

---

## 7. 插件系统架构

### 7.1 生命周期

```
应用启动 / 插件子系统启动（独立于引擎是否成功启动）
  └─ PluginManager.start()
       ├─ 注册所有内置插件（@tx5dr/builtin-plugins 中的 BUILTIN_PLUGINS 数组）
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
       ├─ 把插件系统状态切到 reloading 并广播快照
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

插件子系统与引擎运行状态解耦：电台未连接、引擎未成功启动，都不影响插件的加载、重载、设置管理和客户端同步。

### 7.2 Hook 分发机制

```
onFilterCandidates（Pipeline）：
  active-plugin-A → active-plugin-B → ... → 最终候选列表
  每步：200ms 超时 + 空列表安全网

strategy runtime：
  仅活跃策略插件 → runtime.decide() / runtime.getTransmitText()
  用户编辑上下文 / 状态 / 槽位 → 直接调用 runtime

onQSOComplete（Broadcast）：
  utility-A, utility-B, strategy 并发执行（Promise.allSettled）
  单个出错不影响其他
```

所有 hook 调用都有 **200ms 超时**。显式 strategy runtime 方法不受此超时约束。

### 7.3 策略运行时实现

策略插件在插件目录内直接实现自己的运行时，不再通过 bridge / adapter 复用旧策略系统：

```
PluginContext.operator (OperatorControl)
    │
    ▼
standard-qso/StandardQSOPluginRuntime.ts
    │    直接读取 ctx.operator.* 和 ctx.config.*
    │    直接维护状态机、槽位文本与 QSO 生命周期
    │
    ▼
StrategyRuntime methods（decide / getTransmitText / patchContext / setState ...）
```

当前系统内部的核心控制链路：

- WebSocket：`setOperatorRuntimeState` / `setOperatorRuntimeSlotContent` / `setOperatorTransmitCycles`
- Server：`PluginManager.patchOperatorRuntimeContext()` / `setOperatorRuntimeState()` / `setOperatorRuntimeSlotContent()`
- Runtime：`patchContext()` / `setState()` / `setSlotContent()` / `getSnapshot()`

### 7.4 错误隔离

```
单次 hook 执行
  ├─ 200ms 超时 → 超时报错
  ├─ 抛出异常 → 捕获，记录错误
  └─ 正常返回

错误追踪（PluginErrorTracker）
  ├─ 每个插件每个 hook 独立计数
  ├─ 连续 5 次错误 → 自动禁用该插件
  └─ 广播 pluginStatusChanged 事件通知前端

Pipeline 额外安全网
  └─ onFilterCandidates 返回空数组（输入非空）→ 跳过该插件
```

### 7.5 多插件冲突处理

| 情景 | 处理方式 |
|------|---------|
| 两个工具插件同时定义 `onFilterCandidates` | Pipeline 链式执行 |
| 两个工具插件同时定义 `onQSOComplete` | 并发 fire-and-forget |
| 两个自动起呼工具插件同时定义 `onAutoCallCandidate` | Host 统一收集提议后仲裁 |
| 两个策略插件（理论上不可能）| 每个操作员只能选择一个策略 |
| 工具插件过滤器把候选清空 | 安全网保留上一步结果 |

---

## 8. REST API 与 WebSocket 事件

### REST API

所有接口挂载在 `/api/plugins`：

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/api/plugins` | 获取插件系统完整快照 |
| `GET` | `/api/plugins/runtime-info` | 获取插件宿主目录与运行形态 |
| `POST` | `/api/plugins/:name/enable` | 启用插件 |
| `POST` | `/api/plugins/:name/disable` | 禁用插件 |
| `POST` | `/api/plugins/:name/reload` | 重载单个插件 |
| `POST` | `/api/plugins/reload` | 重载全部插件 |
| `POST` | `/api/plugins/rescan` | 重扫插件目录 |
| `GET` | `/api/plugins/:name/settings` | 获取 global-scope 设置 |
| `PUT` | `/api/plugins/:name/settings` | 更新 global-scope 设置 |
| `GET` | `/api/plugins/:name/operator/:id/settings` | 获取 operator-scope 设置 |
| `PUT` | `/api/plugins/:name/operator/:id/settings` | 更新 operator-scope 设置 |
| `PUT` | `/api/plugins/operators/:id/strategy` | 设置操作员策略插件 |
| `GET` | `/api/plugins/:name/ui/*` | iframe 静态页面（自动注入 Bridge SDK） |
| `GET` | `/api/plugins/_bridge/bridge.js` | Bridge SDK 脚本 |
| `GET` | `/api/plugins/_bridge/tokens.css` | CSS Design Tokens |
| `POST` | `/api/plugins/:name/ui-invoke` | iframe invoke 转发 |
| `POST` | `/api/plugins/:name/ui-store` | iframe KV store 桥接 |
| `POST` | `/api/plugins/:name/ui-files` | iframe 文件操作桥接 |
| `POST` | `/api/plugins/:name/ui-session/heartbeat` | 页面 session 心跳 |
| `GET` | `/api/plugins/sync-providers` | 获取同步 Provider 列表 |
| `GET` | `/api/plugins/sync-providers/configured` | 获取 Provider 配置状态 |
| `POST` | `/api/plugins/sync-providers/:id/test-connection` | 测试同步连接 |
| `POST` | `/api/plugins/sync-providers/:id/upload-preflight` | 上传前检查 |
| `POST` | `/api/plugins/sync-providers/:id/upload` | 触发上传 |
| `POST` | `/api/plugins/sync-providers/:id/download` | 触发下载 |
| `GET` | `/api/plugins/market/catalog` | 获取市场插件索引 |
| `GET` | `/api/plugins/market/catalog/:name` | 获取单个市场条目 |
| `POST` | `/api/plugins/market/:name/install` | 从市场安装 |
| `POST` | `/api/plugins/market/:name/update` | 从市场更新 |
| `DELETE` | `/api/plugins/market/:name` | 卸载市场插件 |

管理类接口（启用/禁用/重载/全局设置）要求 `admin` 角色。运行期接口（日志同步、iframe、ui-invoke）可允许 `operator`，取决于插件的 `accessScope` 和 `resourceBinding` 声明。

### WebSocket 事件

| 事件 | 方向 | 说明 |
|------|------|------|
| `pluginListUpdated` | Server → Client | 插件系统完整快照 |
| `pluginStatusChanged` | Server → Client | 单个插件状态变更 |
| `pluginData` | Server → Client | `ctx.ui.send()` 推送的面板数据 |
| `pluginLog` | Server → Client | `ctx.log.*` 日志条目 |
| `pluginPagePush` | Server → Client | `ctx.ui.pushToPage()` 推送 |
| `pluginPanelMeta` | Server → Client | 面板 meta 更新 |
| `pluginPanelContribution` | Server → Client | 运行期面板贡献变更 |
| `pluginUserAction` | Client → Server | 自定义用户动作 |

操作员 runtime 核心控制命令走系统级 WebSocket 命令：
- `setOperatorRuntimeState`
- `setOperatorRuntimeSlotContent`
- `setOperatorTransmitCycles`

### 数据结构

```typescript
interface PluginSystemSnapshot {
  state: 'ready' | 'reloading' | 'error';
  generation: number;
  plugins: PluginStatus[];
  panelMeta: PluginPanelMetaPayload[];
  panelContributions: PluginUIPanelContributionGroup[];
  lastError?: string;
}

interface PluginStatus {
  name: string;
  type: 'strategy' | 'utility';
  instanceScope: 'operator' | 'global';
  version: string;
  description?: string;
  isBuiltIn: boolean;
  loaded: boolean;
  enabled: boolean;
  autoDisabled: boolean;
  errorCount: number;
  lastError?: string;
  assignedOperatorIds?: string[];
  settings?: Record<string, PluginSettingDescriptor>;
  quickActions?: PluginQuickAction[];
  quickSettings?: PluginQuickSetting[];
  panels?: PluginPanelDescriptor[];
  permissions?: string[];
  capabilities?: string[];
  ui?: PluginUIConfig;
  locales?: Record<string, Record<string, string>>;
  source?: PluginSource;
}
```

---

## 9. 前端 UI 集成

### 插件出现的 UI 位置

| 位置 | 内容 |
|------|------|
| 设置 → 插件 Tab | utility 插件启用状态 + global-scope 设置 |
| 设置 → 插件 Tab | 插件日志面板 |
| 设置 → 操作员配置 | 策略插件选择器 + operator-scope 设置 |
| 操作员面板右上角 | QuickActions + QuickSettings |
| 操作员卡片下方 | 插件声明的 Panels |
| 日志本 → 同步设置 | 同步 Provider 设置页面（iframe） |

### 翻译动态注册

前端收到 `pluginListUpdated` 快照时，自动调用 `registerPluginLocales(name, locales)` 将翻译注册到 `i18next` 的 `plugin:{name}` 命名空间。

### 设置保存模型

- **插件管理页**：utility 启用状态与 global-scope 设置先进入草稿态，统一保存
- **操作员插件设置**：按插件卡片局部保存
- **QuickSetting toggle**：直接写入 operator-scope setting → `onConfigChange`

---

## 10. 新增内置插件指南

如需将新插件作为内置插件随系统发布：

**1. 创建插件目录**

```
packages/builtin-plugins/src/my-new-plugin/
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

export const BUILTIN_MY_NEW_PLUGIN_NAME = 'my-new-plugin';

export const myNewPlugin: PluginDefinition = {
  name: BUILTIN_MY_NEW_PLUGIN_NAME,
  // ...
};

export const myNewPluginLocales = { zh: zhLocale, en: enLocale };
```

**3. 在 `packages/builtin-plugins/src/index.ts` 注册**

```typescript
// 添加 import
import {
  myNewPlugin,
  myNewPluginLocales,
  BUILTIN_MY_NEW_PLUGIN_NAME,
} from './my-new-plugin/index.js';

// 在 BUILTIN_PLUGINS 数组中追加
{
  definition: myNewPlugin,
  locales: myNewPluginLocales,
  enabledByDefault: false,
},
```

如果插件包含 UI 静态文件，还需提供 `dirPath`（通过 `import.meta.url` 计算）。

---

## 11. 代码文件导航

| 关注点 | 文件路径 |
|--------|---------|
| 插件类型定义（TypeScript 接口）| `packages/plugin-api/src/` |
| 插件 Schema（Zod 验证）| `packages/contracts/src/schema/plugin.schema.ts` |
| WebSocket 协议 | `packages/contracts/src/schema/websocket.schema.ts` |
| 插件管理器（中央编排）| `packages/server/src/plugin/PluginManager.ts` |
| 插件加载器 | `packages/server/src/plugin/PluginLoader.ts` |
| Hook 分发引擎 | `packages/server/src/plugin/PluginHookDispatcher.ts` |
| PluginContext 工厂 | `packages/server/src/plugin/PluginContextFactory.ts` |
| UI 桥接 | `packages/server/src/plugin/PluginUIBridge.ts` |
| 错误追踪 | `packages/server/src/plugin/PluginErrorTracker.ts` |
| 存储 Provider | `packages/server/src/plugin/PluginStorageProvider.ts` |
| 文件存储 Provider | `packages/server/src/plugin/PluginFileStoreProvider.ts` |
| 页面 Session 管理 | `packages/server/src/plugin/PluginPageSessionStore.ts` |
| 日志同步 Host | `packages/server/src/plugin/LogbookSyncHost.ts` |
| REST API 路由 | `packages/server/src/routes/plugins.ts` |
| 内置插件包（全部 12 个）| `packages/builtin-plugins/src/` |
| standard-qso 运行时 | `packages/builtin-plugins/src/standard-qso/StandardQSOPluginRuntime.ts` |
| 前端插件组件 | `packages/web/src/components/plugins/` |
| iframe 宿主组件 | `packages/web/src/components/plugins/PluginIframeHost.tsx` |
| 面板渲染器 | `packages/web/src/components/plugins/PluginPanelRenderer.tsx` |
| Slot 宿主布局 | `packages/web/src/components/plugins/PluginSlotHosts.tsx` |
| 面板可见性逻辑 | `packages/web/src/components/plugins/pluginPanelSlots.ts` |
| 插件市场 UI | `packages/web/src/components/plugins/PluginMarketplace.tsx` |
| 插件管理列表 | `packages/web/src/components/plugins/PluginList.tsx` |
| 操作员插件设置 | `packages/web/src/components/settings/OperatorPluginSettings.tsx` |
| 前端插件辅助 API | `packages/web/src/utils/pluginApi.ts` |
| Bridge SDK 类型 | `packages/plugin-api/src/bridge.d.ts` |
| CSS Design Tokens 参考 | `packages/plugin-api/src/tokens.css` |
