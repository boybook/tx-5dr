# TX-5DR Plugin API v2 开发指南

本文面向 TX-5DR 插件作者，说明公开 API 的正确用法。类型定义以
`@tx5dr/plugin-api` 为准；不要从 `@tx5dr/contracts` 或 server 内部目录导入实现。

## 1. 快速开始

### 1.1 创建项目

推荐使用脚手架：

```bash
npx create-tx5dr-plugin my-plugin
npx create-tx5dr-plugin my-strategy --type strategy
npx create-tx5dr-plugin my-panel --template ui-react
```

也可以在现有 ESM 项目中安装 API：

```bash
npm install --save-dev @tx5dr/plugin-api@^2
```

编译结果放在一个独立插件目录中。Host 按以下顺序查找入口：
`plugin.js`、`plugin.mjs`、`index.js`、`index.mjs`。

```text
my-plugin/
├── plugin.js
├── locales/
│   ├── zh.json
│   └── en.json
└── ui/                 # 可选：iframe 页面静态资源
```

### 1.2 最小 utility 插件

```ts
import { definePlugin } from '@tx5dr/plugin-api';

export default definePlugin({
  apiVersion: 2,
  name: 'decode-observer',
  version: '1.0.0',
  type: 'utility',
  permissions: [],

  hooks: {
    onDecode(messages, ctx) {
      ctx.log.debug('Decoded messages', { count: messages.length });
    },
  },
});
```

始终使用 `definePlugin()`。它会保留 `permissions` 的字面量类型，使 TypeScript
只提供已经声明的 capability；不要把定义或回调手动扩宽成宽泛的
`PluginDefinition` 或 `PluginContext`。

所有新插件都应写 `apiVersion: 2`。strategy 插件，以及请求
`operator:transmit-control`、`radio:control`、`radio:tuner-control`、
`radio:power`、`logbook:write` 或 `logbook:sync` 的 utility 插件必须使用 v2，
否则 Host 会以 `PLUGIN_API_INCOMPATIBLE` 拒绝加载。

## 2. 插件类型与实例作用域

### 2.1 插件类型

| 类型 | 用途 | 发射相关规则 |
|---|---|---|
| `strategy` | 每个操作员选择一个 QSO 自动化策略 | 通过 `StrategyRuntime.decide()` 返回声明式发射决策 |
| `utility` | 过滤、评分、监控、同步、UI 和外部集成 | 默认不能发射；需要高层操作员命令时声明 `operator:transmit-control` |

`type: 'strategy'` 与 `apiVersion: 2` 已经是 strategy 的声明式发射授权。
strategy 不需要 `operator:transmit-control`，也不会获得
`ctx.operatorCommands`。

### 2.2 实例作用域

- `instanceScope: 'operator'`：默认值，每个操作员一个实例。
- `instanceScope: 'global'`：整个 Host 一个实例，仅支持 utility。

global utility 适合站级同步服务和共享资源。它不能声明 operator-scope setting、
`quickSettings`、操作员面板或操作员相关 hook；需要访问特定日志本时使用
`ctx.logbook.forCallsign(callsign)`。`operator:transmit-control` 只允许 operator scope。

### 2.3 Host 与 Plugin 的职责边界

Plugin 负责功能特定的策略、设置、评分、交换规则、外部服务行为和
自定义界面。Host 只提供与具体插件无关的通用机制，例如生命周期、权限、
隔离存储、事件传递、状态快照、仲裁以及受控的电台/日志本/网络端口。

新插件需求如果暴露了 Host 能力缺口，先把插件策略与底层机制分开。策略仍留在
Plugin；Host 只增加最小的通用能力。该能力必须具有中性语义、显式 permission、
运行时校验、类型化公共接口、明确的生命周期和不依赖原插件的测试。

禁止 Host 根据插件名或内置身份走特殊分支，也禁止使用只有一个插件和 Host 知道的
私有事件名、魔法存储键、未公开设置字段、隐藏 context 属性或绕过权限的调用。
内置插件也必须通过与外部插件相同的公共契约使用 Host 能力。通用性不等于为
未来假设建立庞大框架；当前只需保持语义中性、边界公开和实现最小。

## 3. PluginDefinition

插件入口默认导出 `definePlugin({...})`。常用字段如下：

| 字段 | 说明 |
|---|---|
| `apiVersion` | 新插件使用 `2` |
| `name` | 稳定且唯一的插件 ID；发布后不要更改 |
| `version` | 插件版本 |
| `type` | `strategy` 或 `utility` |
| `instanceScope` | `operator`（默认）或 `global` |
| `description` | 插件管理页中的简短说明或翻译 key |
| `permissions` | 所需 capability 的最小集合 |
| `settings` | Host 生成表单并持久化的设置定义 |
| `quickActions` | 一次性操作按钮，触发 `hooks.onUserAction` |
| `quickSettings` | 暴露到快捷区的 operator-scope setting |
| `panels` | Host 渲染的声明式或 iframe 面板 |
| `storage` | 声明 `global` / `operator` 持久存储 scope |
| `ui` | 自定义 iframe 页面 |
| `onLoad` | 实例加载后的初始化 |
| `onUnload` | 实例卸载前的清理 |
| `hooks` | Host 事件和 pipeline hook |
| `createStrategyRuntime` | strategy 必填，utility 禁止提供 |

Host 会校验并冻结加载后的定义。不要在运行期修改 definition、permissions、hooks
或 UI descriptor。

## 4. Context 与 capability

### 4.1 基础 context

每次正常 invocation 的 `ctx` 都包含：

| 属性 | 用途 |
|---|---|
| `config` / `updateConfig()` | 读取或更新当前插件设置 |
| `store` | 插件私有的 `global` / `operator` KV 存储 |
| `log` | 结构化日志 |
| `timers` | Host 管理的命名 timer |
| `operator` | 当前操作员的只读快照和查询 |
| `radio` | 频率、波段、模式、连接状态的只读快照 |
| `band` | 当前解码环境和自动目标辅助查询 |
| `ui` | panel 数据和 iframe 通信 |
| `files` | 插件私有文件存储 |

普通数据与 Host capability 使用不同的所有权语义：配置、查询结果、QSO、解码消息
和消息 payload 都按值交给插件，可以缓存和自由修改；修改不会隐式写回 Host。socket、
logbook accessor、radio/operator view、Response 等 capability 是实时 Host handle，可以在
同一插件实例中保存，但只能在 Host 发起的有效 callback 内调用，并在插件卸载后失效。
需要修改系统状态时，始终调用对应的 `set`、`update` 或 command API。

### 4.2 permission 映射

未声明 permission 时，对应属性在 TypeScript 类型和运行时对象中都不存在。

| permission | 获得的 context capability |
|---|---|
| `operator:transmit-control` | `operatorCommands` |
| `radio:read` | `radioCapabilities`、只读 `radioPower` |
| `radio:control` | `radioCommands` |
| `radio:tuner-control` | `radioTunerCommands` |
| `radio:power` | `radioPowerCommands` |
| `logbook:read` | 只读 `logbook` |
| `logbook:write` | 可 durable 写入的 `logbook` |
| `logbook:sync` | `logbookSync` Provider 注册入口 |
| `settings:ft8` | `settings.ft8` |
| `settings:decode-windows` | `settings.decodeWindows` |
| `settings:realtime` | `settings.realtime` |
| `settings:frequency-presets` | `settings.frequencyPresets` |
| `settings:station` | `settings.station` |
| `settings:psk-reporter` | `settings.pskReporter` |
| `settings:ntp` | `settings.ntp` |
| `network` | `network`（含 UDP）和受控 `fetch` |
| `plugin:event-bus` | `eventBus` |
| `host:hamlib` | `hostDependencies.hamlib` |

这些 capability 是 Host 仲裁后的公开端口。它们不暴露 raw PTT、音频播放器、
Mixer、Encoder、physical lease 或全局紧急停止。

### 4.3 utility 的操作员命令

需要影响操作员自动化的 utility 必须：

1. 声明 `operator:transmit-control`；
2. 使用 operator scope；
3. 实现 `isTransmitControlEnabled(ctx)` 或 `isAutoCallEnabled(ctx)`；
4. 只通过 `ctx.operatorCommands.submit(...)` 提交高层命令。

可提交的命令形状：

```ts
type PluginOperatorCommand =
  | { type: 'start-automation' }
  | { type: 'stop-automation' }
  | { type: 'request-call'; callsign: string; lastMessage?: LastMessageInfo }
  | {
      type: 'reply-to-decode';
      callsign: string;
      lastMessage: LastMessageInfo;
      modifiers?: number;
    }
  | { type: 'set-transmit-cycles'; cycles: number | number[] }
  | { type: 'remove-contribution' }
  | { type: 'clear-decodes'; window?: number }
  | { type: 'set-free-text'; text: string }
  | { type: 'send-free-text'; text?: string }
  | { type: 'set-temporary-location'; location: string }
  | {
      type: 'highlight-callsign';
      callsign: string;
      background?: string | null;
      foreground?: string | null;
      lastOnly?: boolean;
    };
```

示例：

```ts
export default definePlugin({
  apiVersion: 2,
  name: 'remote-call-integration',
  version: '1.0.0',
  type: 'utility',
  permissions: ['operator:transmit-control'],

  isTransmitControlEnabled: (ctx) => ctx.config.enabled === true,

  hooks: {
    async onUserAction(actionId, payload, ctx) {
      if (actionId !== 'call') return;
      const { callsign } = payload as { callsign: string };
      const result = await ctx.operatorCommands.submit({
        type: 'request-call',
        callsign,
      });
      ctx.log.info('Call command settled', {
        epoch: result.epoch,
        outcome: result.outcome,
      });
    },
  },
});
```

`isAutoCallEnabled(ctx)` 只用于真正会自主起呼的插件。它会让插件进入操作员卡片的
自动起呼状态和暂停控制。QSO UDP 广播、遥控桥等外部集成即使需要命令权限，也应
只实现 `isTransmitControlEnabled(ctx)`，不要实现 `isAutoCallEnabled(ctx)`。

### 4.4 电台、日志本与网络

- `radioCommands` 接受 Host 仲裁的 `set-frequency` 和 `switch-band`；后者可用
  `autoTune: true` 在同一物理空闲事务中完成切频与调谐。
- `radioTunerCommands` 只接受 `set-enabled` 和 `start-manual-tune`。这些写操作都会在
  Digital、Voice、CW、Tune 或人工 PTT 占用时拒绝，不会中断正在发射的帧。
- `radioPowerCommands` 只接受 `set-power`。
- `logbook:write` 的 Promise 在 Host 完成 durable commit 后才成功。
- `logbook:sync` 用于注册 `LogbookSyncProvider`，不要自行模拟 Host 同步状态。
- `network` 提供受控 HTTP 和 UDP；网络资源应在 unload 时关闭。
- `eventBus` topic 建议使用 `<plugin-name>.<domain>.<event>`，订阅函数会返回
  unsubscribe callback。

## 5. Utility hooks

常用 hook：

| hook | 用途 |
|---|---|
| `onFilterCandidates` | 过滤自动目标候选，返回新的数组 |
| `onScoreCandidates` | 调整候选 `score` |
| `onAutoCallCandidate` | 声明式提出一个自动起呼候选 |
| `onConfigureAutoCallExecution` | 调整 Host 已接受起呼的执行计划 |
| `onSlotStart` | 接收时隙开始与解析后的消息 |
| `onSlotActivity` | 接收时隙、原始 frame 和解析消息 |
| `onDecode` | 接收新解码消息 |
| `onFrequencyChange` | 接收频率或波段变化 |
| `onQSOStart` | QSO 开始通知 |
| `onQSOComplete` | 日志已经成功提交后的 QSO 完成通知 |
| `onQSOFail` | QSO 失败通知 |
| `onTimer` | `ctx.timers` 的命名 timer 触发 |
| `onUserAction` | quick action 或 Host 用户操作 |
| `onConfigChange` | 持久设置变化 |

自动起呼优先使用 `onAutoCallCandidate()` 返回 proposal，让 Host 统一仲裁：

```ts
hooks: {
  onAutoCallCandidate(_slotInfo, messages) {
    const candidate = messages.find((entry) => entry.message.type === 'cq');
    if (!candidate || candidate.message.type !== 'cq') return null;
    return {
      callsign: candidate.message.senderCallsign,
      priority: 10,
    };
  },
}
```

上例不需要 frame 上下文。若要填写可选 `lastMessage`，应从
`onSlotActivity` 保存 Host 提供的 `FrameMessage` 与对应 `SlotInfo`，不要从
`ParsedFT8Message` 构造不存在的字段。

Hook 应尽快返回。耗时 I/O 应显式 `await`、处理失败，并允许 invocation 被取消；
不要在 hook 中启动无法追踪的后台 continuation。

## 6. StrategyRuntime v2

strategy 必须实现完整 v2 runtime：

术语边界：

- `slot` 表示 FT4/FT8 的物理收发时隙或 Host UI 扩展位置。
- `TX1` 至 `TX6` 是可选择的 Tx 消息，不应在用户界面称为“槽”。
- `stream` 表示同一操作员内独立推进的并行 QSO；协议实现内部可以使用 `lane`。
- `frame` 表示 Host 一次原子提交的物理混音发射，可以包含多个 QSO stream。

`StrategyRuntimeSlot` 和 `setSlotContent()` 是兼容既有插件保留的 API 名称；新插件的
用户可见文案必须使用“Tx 消息”，不要继续扩散旧称。

```ts
import {
  definePlugin,
  type ParsedFT8Message,
  type StrategyDecisionMetaV2,
  type StrategyDecisionResult,
  type StrategyPluginContext,
  type StrategyRuntime,
  type StrategyRuntimeCheckpoint,
  type StrategyRuntimeContext,
  type StrategyRuntimeSlot,
  type StrategyRuntimeSlotContentUpdate,
} from '@tx5dr/plugin-api';

class Runtime implements StrategyRuntime {
  private state: StrategyRuntimeSlot = 'TX6';
  private slots: Partial<Record<StrategyRuntimeSlot, string>> = {};
  private context: StrategyRuntimeContext = {};

  constructor(private readonly ctx: StrategyPluginContext) {}

  checkpoint(): StrategyRuntimeCheckpoint {
    return structuredClone({
      state: this.state,
      slots: this.slots,
      context: this.context,
    });
  }

  restore(checkpoint: StrategyRuntimeCheckpoint): void {
    const saved = checkpoint as {
      state: StrategyRuntimeSlot;
      slots: Partial<Record<StrategyRuntimeSlot, string>>;
      context: StrategyRuntimeContext;
    };
    this.state = saved.state;
    this.slots = { ...saved.slots };
    this.context = { ...saved.context };
  }

  decide(
    messages: ParsedFT8Message[],
    meta: StrategyDecisionMetaV2,
  ): StrategyDecisionResult {
    if (meta.signal.aborted) {
      throw meta.signal.reason ?? new Error('Decision aborted');
    }

    // 根据 messages 更新本 runtime 的 speculative state。
    return {
      transmission: this.getTransmitText(),
      snapshot: this.getSnapshot(),
    };
  }

  getTransmitText(): string | null {
    return this.slots[this.state] ?? null;
  }

  getSnapshot() {
    return {
      currentState: this.state,
      slots: { ...this.slots },
      context: { ...this.context },
    };
  }

  requestCall(callsign: string): void {
    this.context.targetCallsign = callsign;
    this.state = 'TX1';
    this.ctx.log.info('Call requested', { callsign });
  }

  patchContext(patch: Partial<StrategyRuntimeContext>): void {
    Object.assign(this.context, patch);
  }

  setState(state: StrategyRuntimeSlot): void {
    this.state = state;
  }

  setSlotContent(update: StrategyRuntimeSlotContentUpdate): void {
    this.slots[update.slot] = update.content;
  }

  reset(): void {
    this.state = 'TX6';
    this.slots = {};
    this.context = {};
  }
}

export default definePlugin({
  apiVersion: 2,
  name: 'my-strategy',
  version: '1.0.0',
  type: 'strategy',

  createStrategyRuntime(ctx) {
    return new Runtime(ctx);
  },
});
```

必须实现：

```text
checkpoint / restore / decide / getTransmitText / getSnapshot
requestCall / patchContext / setState / setSlotContent / reset
```

### 6.1 speculative decision 规则

- `checkpoint()` 的返回值必须能被 `structuredClone()`；不要包含 Promise、函数、
  socket、文件句柄或 Host context。
- `decide(messages, meta)` 是 speculative phase。被新命令、晚到解码、reload 或
  shutdown 取代时，Host 可以 abort 并恢复 checkpoint。
- `meta` 包含 `epoch`、`source`、`isReDecision` 和 `signal`。异步逻辑必须传递并
  响应 `AbortSignal`。
- `decide()` 内不要写日志本、操作 PTT、提交 operator command 或产生不可撤销的
  外部副作用。
- `StrategyPluginContext` 仅包含 `config`、`log` 和只读 `operator`，不含命令端口。

### 6.2 decision result

每次 decision 必须返回准确的 `transmission` 和 `snapshot`：

```ts
return {
  transmission: 'CQ BA8BLK OM20', // 或 null
  snapshot: this.getSnapshot(),
  stop: false,                    // 可选：停止后续自动化，不是 RF 硬中断
  silentListen: undefined,        // 可选：QSO 后的声明式静默监听窗口
  qsoFailure: undefined,          // 可选：结构化失败信息
  qsoCompletion: undefined,       // 可选：durable QSO effect
};
```

完成 QSO 时，不要在 `decide()` 中直接写 ADIF。返回声明式 effect：

```ts
qsoCompletion: {
  record,
  lifecycleEpoch,
}
```

Host 完成持久化后，可通过可选的 `settleQSOCompletion({ lifecycleEpoch, recordId,
status })` 通知 runtime。旧 lifecycle 的结果不会成为新 QSO 的 RF 决策依据。

## 7. Settings、存储与 UI

### 7.1 Settings

```ts
settings: {
  enabled: {
    type: 'boolean',
    default: true,
    label: 'enabled',
    description: 'enabledDesc',
    scope: 'operator',
  },
  threshold: {
    type: 'number',
    default: -15,
    label: 'threshold',
    scope: 'global',
    min: -30,
    max: 10,
  },
},
quickSettings: [{ settingKey: 'enabled' }],
quickActions: [{ id: 'reset', label: 'reset' }],
```

支持的 setting type：`boolean`、`number`、`string`、`string[]`、`object[]`、
`keyedStringArrays`、`keyedObjectArrays`、`keyedObjects` 和 `info`。

- `scope: 'global'`：全站共享。
- `scope: 'operator'`：按操作员隔离。
- `quickSettings` 只能引用已声明、非 `info` 的 operator-scope setting。
- `ctx.config` 是已合并、只读的当前值；使用 `await ctx.updateConfig(patch)` 更新。
- `label`、`description` 可以使用 `locales/<locale>.json` 中的翻译 key。

### 7.2 KV 与文件

```ts
const count = ctx.store.operator.get<number>('count', 0);
ctx.store.operator.set('count', count + 1);
await ctx.store.operator.flush(); // 只在确需立即落盘时调用

await ctx.files.write('cache/data.bin', buffer);
const data = await ctx.files.read('cache/data.bin');
```

小型 JSON 兼容数据使用 `store`；二进制或较大文件使用 `files`。`store` 按值读写：
修改 `get()` / `getAll()` 的返回值不会隐式更新存储，必须再次调用 `set()`。路径由
Host 限制在插件私有目录内。

### 7.3 Panels

声明式 panel 支持 `table`、`key-value`、`chart`、`log` 和 `iframe`：

```ts
panels: [
  {
    id: 'status',
    title: 'statusTitle',
    component: 'key-value',
    slot: 'operator',
    width: 'half',
  },
],

onLoad(ctx) {
  ctx.ui.send('status', { state: 'ready' });
},
```

可用 slot：`operator`、`automation`、`operator-action`、`main-right`、`voice-left-top`、
`voice-right-top`、`cw-left-top`、`cw-right-top`、`radio-control-toolbar`。
运行期 panel 使用 `setPanelContributions()` / `clearPanelContributions()` 管理。

### 7.4 iframe 页面

```ts
ui: {
  dir: 'ui',
  pages: [
    {
      id: 'settings',
      title: 'settingsTitle',
      entry: 'settings.html',
      accessScope: 'admin',
    },
  ],
},

onLoad(ctx) {
  ctx.ui.registerPageHandler({
    async onMessage(pageId, action) {
      if (pageId === 'settings' && action === 'read') {
        return { value: ctx.store.global.get('value', '') };
      }
      return null;
    },
  });
},
```

iframe 内由 Host 注入 `window.tx5dr`：

```js
await window.tx5dr.ready;
const result = await window.tx5dr.invoke('read');
window.tx5dr.onPush('updated', (data) => console.log(data));
```

需要较大工作区的操作员自定义 UI，可以声明为操作员卡片中的独立页面入口：

```ts
ui: {
  pages: [
    {
      id: 'history',
      title: 'historyTitle',
      entry: 'history.html',
      accessScope: 'operator',
      resourceBinding: 'operator',
    },
  ],
},

panels: [
  {
    id: 'history',
    title: 'historyTitle',
    component: 'iframe',
    pageId: 'history',
    slot: 'operator-action',
    openMode: 'page',
    icon: 'file-lines',
  },
],
```

`operator-action` 会把固定的图标加文字按钮横向追加到操作员卡片的日志入口旁，并且要求页面使用
`resourceBinding: 'operator'`。`openMode: 'page'` 由 Host 统一实现：Electron 打开应用窗口，普通
Web 打开新标签页，Android 在当前 WebView 中导航并使用系统返回栈。Host 会绑定按钮所属的
`operatorId`；不同操作员以及同一操作员重复打开的页面使用相互独立的 page session，插件应通过
`ctx.ui.listActivePageSessions(pageId)` 和 `ctx.ui.pushToSession(...)` 向所有需要更新的页面推送。
页面入口、路由、鉴权和 bridge 都由通用插件 Host 负责，插件不应自行调用 Electron IPC 或判断平台。

Host 注入的 `tokens.css` 只提供 CSS 变量，不提供按钮、Chip 或表格组件 class。插件自行组织 DOM 和
class，并使用 `--tx5dr-control-*` 组装尺寸与交互状态，使用语义色的 `*-soft`、`*-soft-hover` 和
`*-foreground` 组装 solid / flat / bordered / light 变体。紧凑状态、数据表格和反馈区域分别使用
`--tx5dr-chip-*`、`--tx5dr-table-*`、`--tx5dr-alert-*`；基础主题切换由 Host 自动更新。

启用类型补全：

```json
{
  "compilerOptions": {
    "types": ["@tx5dr/plugin-api/bridge"]
  }
}
```

页面只能通过 Bridge 与自己的 server-side handler 通信，不会直接获得 server
context capability。`requestContext.user`、resource binding 和 page session 都由
Host 验证；不要相信 iframe 自行提交的 operatorId、callsign 或权限信息。

## 8. Invocation 与生命周期

每个 hook、timer 和 page handler 都有 Host 管理的 invocation 生命周期。

- 使用 `ctx.timers.set(id, intervalMs)`，在 `hooks.onTimer` 中处理；不要使用 raw
  timer 保存长期可写 context。
- invocation timeout、plugin disable、reload、unload 或 shutdown 后，旧异步
  continuation 再调用命令型 capability 会得到 `PLUGIN_INVOCATION_EXPIRED`。
- strategy 收到 `AbortSignal` 后应立即停止；其他 invocation 失效后不要继续提交
  operator、radio、logbook 或 UI 命令。
- hook throw/reject 会被隔离到当前插件实例；仍应捕获可预期错误并写清晰日志。
- `onUnload(ctx)` 只提供 `store`、`log`、`timers`、`files` 和只读 `operator`，
  用于识别当前实例并清理插件资源。
- UDP socket、event bus subscription 和外部客户端应保存自己的 cleanup handle，
  在 unload 时关闭；Host timer 会自动清理。

## 9. 测试与发布检查

测试工具从 `@tx5dr/plugin-api/testing` 导入：

```ts
import {
  createMockContext,
  createMockParsedMessage,
  createMockSlotInfo,
} from '@tx5dr/plugin-api/testing';
```

发布前至少检查：

1. `definePlugin()` 能在 strict TypeScript 下通过，未使用任何未声明 capability。
2. strategy checkpoint 可 `structuredClone()`，abort 后不会继续产生副作用。
3. utility 只使用公开 command port，没有 raw PTT 或 server 内部 import。
4. `isAutoCallEnabled` 只用于真正的自动起呼插件。
5. operator/global setting 与 instance scope 合法。
6. hook、network、timer、page handler 的失败和 unload 都能正确清理。
7. iframe 的 access scope、resource binding 和服务端输入校验符合实际权限需求。
8. 插件目录只包含发布所需入口、UI、locales 和依赖产物。

## 10. 从 v1 迁移到 v2

- 改用 `definePlugin({ apiVersion: 2, ... })`。
- strategy 实现完整 `StrategyRuntime` v2，尤其是 `checkpoint()`、`restore()` 和
  `decide(messages, meta)`。
- 将 strategy 中的直接日志写入改成 `qsoCompletion` effect。
- 将旧 operator mutation 改成 utility 的 `operator:transmit-control` +
  `operatorCommands.submit()`；strategy 本身不要申请该 permission。
- 将 radio/logbook/settings/network 使用改成对应 capability，并从 permissions
  删除未使用项。
- 将直接 PTT、音频、Mixer、Encoder 和 server 内部调用删除。
- 将 raw timer 改成 `ctx.timers`，并处理 `AbortSignal` 与
  `PLUGIN_INVOCATION_EXPIRED`。
- 将旧 `onUnload` 逻辑限制到 cleanup context。
- 真正自动起呼实现 `isAutoCallEnabled`；遥控、UDP 或外部协议桥只实现
  `isTransmitControlEnabled`。

## 11. 公共源码导航

| 内容 | 路径 |
|---|---|
| 定义与 `definePlugin()` | `packages/plugin-api/src/definition.ts` |
| capability context | `packages/plugin-api/src/context.ts`、`capabilities.ts` |
| utility hooks | `packages/plugin-api/src/hooks.ts` |
| strategy runtime v2 | `packages/plugin-api/src/runtime.ts` |
| context helper 接口 | `packages/plugin-api/src/helpers.ts` |
| settings capability | `packages/plugin-api/src/settings.ts` |
| logbook sync Provider | `packages/plugin-api/src/sync.ts` |
| iframe Bridge | `packages/plugin-api/src/bridge.d.ts` |
| 测试 helper | `packages/plugin-api/src/testing/index.ts` |
| 脚手架模板 | `packages/create-tx5dr-plugin/src/index.ts` |
| 完整 strategy 参考 | `packages/builtin-plugins/src/standard-qso/` |

插件作者应以这些公开类型和实际导出为准。Host 内部 Coordinator、Manager、REST、
WebSocket 与硬件实现不属于 Plugin API，不应被插件直接依赖。
