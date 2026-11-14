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
npx create-tx5dr-plugin my-contest --template ft8-contest
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

### 1.3 组装 FT8/FT4 比赛插件

比赛插件从 `@tx5dr/plugin-api/contest` 导入公开模块。规则模块可以单独替换，
`composeFT8ContestPlugin()` 只是连接 strategy runtime 和生命周期模块的便利入口，
并不是必须继承的基类。

```ts
import {
  cabrilloSubmission,
  composeFT8ContestPlugin,
  defineFT8Contest,
  distancePoints,
  fixedWeekendEdition,
  gridExchange,
  requireExchangeAndFinalAck,
} from '@tx5dr/plugin-api/contest';
import { createContestRuntime } from './runtime.js';

const contest = defineFT8Contest({
  id: 'example-ft8',
  rulesetVersion: '2026.1',
  edition: fixedWeekendEdition({
    id: '2026',
    startAt: '2026-08-29T00:00:00Z',
    endAt: '2026-08-30T00:00:00Z',
  }),
  bands: ['80M', '40M', '20M', '15M', '10M'],
  exchange: gridExchange(),
  completion: requireExchangeAndFinalAck(),
  scoring: distancePoints({ stepKm: 3000 }),
  submission: cabrilloSubmission({
    headers: () => [['CONTEST', 'EXAMPLE-FT8']],
    qsoLine: (qso) => `QSO: ${qso.callsign}`,
  }),
});

export default composeFT8ContestPlugin({
  name: 'example-ft8',
  version: '1.0.0',
  minPluginApiVersion: '2.6.0',
  contest,
  runtime: createContestRuntime,
});
```

对于固定分值短赛、前缀/DXCC/grid multiplier，或者需要“0 分但仍计 multiplier”的赛制，
可以把 `fixedPoints()`、`scoreBy()` 和 `multiplierKeysFrom()` 组合起来，再接上自己的
比赛元数据提取器。`distancePoints()` 只是距离赛的常见捷径，不是唯一写法。

默认规则为 FT8、人工发起、单 QSO、单发射信号、呼号加波段判重。完成条件必须
显式选择，因为它属于 RF fail-closed 边界。常见规则可使用构造器；特殊比赛可以
直接实现 `FT8ExchangeModule`、`CompletionModule`、`DupeModule`、
`ScoringModule` 或 `SubmissionModule`。组装器会把人工发起、并发 QSO 和同帧信号
上限映射为 Host capability；`cycleRelation` 仍由 runtime adapter 按比赛协议实现。
计分和导出应统一通过 `projectFT8ContestQsos()`、`scoreFT8ContestQsos()`、
`formatFT8ContestSubmission()`，避免各插件重复遗漏赛期、模式、波段、审核状态或判重。
`defaultContestSession()` 只保证当前
Host 进程内的配置/投影 KV update 原子性，必须 `flush()` 后才 durable；QSO 数据
则通过 Host plugin-session 的 revision-guarded batch 单独提交。
`defaultContestLogbook()` 的非 QSO 配置状态默认属于操作员；适配已有全局状态时，
应显式声明 `stateScope: 'global'`，并让 `stateKey` 与适配器已有的键一致。
设置保存与页面投影必须读取同一状态所有者，不能分别使用 global 和 operator store。

需要完整比赛应用层时，插件显式声明 `CONTEST_SESSION_PERMISSIONS`（即
`logbook:session + plugin:event-bus`），并将 `defaultContestSession()` 交给组装器。
它隐藏 session key、event topic 和 raw logbook handle，公开 health、query、snapshot、
通知/订阅，以及最多三次 revision-conflict 重试的 `transact()`：

```ts
import {
  createContestQsoEnvelopeAdapter,
  defaultContestSession,
} from '@tx5dr/plugin-api/contest';

const session = defaultContestSession({
  create: () => ({ schemaVersion: 1, revision: 0, settings: {} }),
});
const contestEnvelope = createContestQsoEnvelopeAdapter(contest);

// 必须在当前 Host callback 内绑定当前 ctx；不要缓存 invocation context。
await session.access(ctx).transact(
  (snapshot) => planImportMutations(parsedImport, snapshot),
  { reason: 'import' },
);
```

插件仍负责定义比赛字段、交换适配和审核策略，只需把这些策略交给
`standardFT8ContestLogbook()` 或 `defaultContestLogbook()`。标准 logbook 会统一
`get-state/save-settings/set-qso-status/preview-import/commit-import/export` 消息、
revision-guarded QSO 事务、ADIF/官方格式导出、实时分数和 review 状态；插件不再手写
导入 token、状态推送或日志页面 handler。

`standardFT8ContestLogbook()` 同时声明 operator-bound `contest-log` page 和
`operator-action` panel。`@tx5dr/plugin-api` 发布 canonical 静态页面，scaffold 和
Marketplace 插件构建时复制到插件自己的 `ui/` 目录，因此 Host 不需要按插件名提供比赛页面。
自定义 contest 字段通过 `ContestLogbookViewModel.columns`、settings fields 和
presentation locale bundle 描述；通用页面不会写死某一场比赛的字段。公开的
`ContestWorkbenchCommand` 仍是可扩展的推荐 union，插件只有在确有自定义动作时才需要
扩展 `ContestWorkbenchRequest`。

标准 FT8/FT4 runtime 也通过 `@tx5dr/plugin-api/ft8` 公开。外部比赛插件不得从
`@tx5dr/core` 或 Host 内部路径导入 runtime 实现；需要标准解码、频率匹配或 QSO
runtime 时使用该 public entrypoint。

插件可以通过 `ctx.lifecycle.scheduleAfterStartup()` 注册不应阻塞 Server ready 的初始化。
Host 会在核心服务 ready 后执行任务，并在实例重载或停止时通过 `AbortSignal` 取消任务；
任务失败只会进入插件运行日志和后台任务状态，不会反向阻塞或回滚核心服务启动。Contest
Logbook 使用这条机制打开历史日志、建立 snapshot 和 FrameTable 投影，页面在任务完成前
显示可读的 opening/degraded 状态。

比赛插件不再注册到 `@tx5dr/builtin-plugins`。本地联调时，在 Host worktree 执行：

```bash
TX5DR_PLUGINS_ROOT=/Users/fangyizhou/Documents/coding/tx-5dr-plugins \
  yarn dev:link-marketplace-plugins
TX5DR_PLUGINS_DIR=/Users/fangyizhou/Documents/coding/tx-5dr-ft8-contest-family-plugins/.dev/plugins \
  yarn dev
```

`.dev/plugins` 已被 Host 忽略，脚本只创建指向外部仓库 `dist` 的软链接；正式安装仍
通过 Marketplace artifact，不会把外部源码或依赖带入 Host。

默认 session 以 `contestId + editionId + rulesetVersion` 隔离，并且只创建 durable
Host session。runtime/practice session 不能由 cleanup context可靠销毁，必须通过
strategy action 的 `logbookSessionEffects` 管理。`createContestQsoEnvelopeAdapter()`
会把相同三元身份和 typed exchange codec 写入/校验 `ContestQsoEnvelope`，插件无需
重复手写 identity 与 encode/decode。

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
| `minPluginApiVersion` | 所需内置 `@tx5dr/plugin-api` 版本，按 `^` 语义匹配；所有插件都应声明（未声明时 Host 不做兼容检查），Marketplace 插件必填 |
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

### 3.1 版本边界

- TX-5DR `X.Y.Z` 或 `X.Y.Z-nightly.*` 是产品构建身份，只用于升级、诊断和 artifact 追踪；实际基础版本取自根 `package.json`。
- `@tx5dr/plugin-api` SemVer 是插件兼容轴，Host 通过 `pluginApiVersion` 暴露内置版本。
- `apiVersion: 2` 是运行时 ABI 代际，不是 npm package version。
- 插件自己的 `version` 只用于 Marketplace 更新。
- 数据 `schemaVersion` 与比赛 `rulesetVersion` 只服务各自迁移，不参与 Loader 兼容判断。

运行时构建身份只有一个权威文件：`packages/server/src/generated/buildInfo.json`。
Electron Main、嵌入 Server、Web bundle、遥测和诊断上报都消费这一份构建产物；其他模块不得维护版本副本。

兼容规则：内置 `pluginApiVersion` 满足 `^minPluginApiVersion` 时插件兼容，即不低于
声明版本，且不跨越下一个破坏性边界（`X>0` 时为主版本，`0.Y` 时为次版本）。
产品 Host version 不参与判断。

- Marketplace 只安装兼容版本。
- Loader 另外接受上一个主版本的插件（`PLUGIN_API_LEGACY_MAJOR_WINDOW`），标记为
  `pluginApiCompatibility: 'legacy'` 并提示作者更新：这些插件在规则收紧前已在当前主版本
  的 Host 上运行，直接拒绝只会让现有安装失效。窗口外的旧主版本，以及要求更新
  Plugin API 的插件，以 `PLUGIN_API_VERSION_UNSUPPORTED` 拒绝加载。
- 未加载的插件目录进入插件快照的 `loadFailures`，设置页的插件列表显示原因与处理方式；
  不能只写入运行日志。

作者选择版本的规则：`minPluginApiVersion` 等于所安装并据以构建的
`@tx5dr/plugin-api` 版本，即依赖范围的下限；升级依赖以使用新 API 时同时提高二者；
只有在对应版本的 Host 上实测过才填写更低版本。发布前运行 `npm run check`
（scaffold 生成），或 `npm exec --package=@tx5dr/plugin-api@^2.7.0 -- tx5dr-plugin check`；它检查声明不低于构建依赖下限且主版本一致，
与 Marketplace 校验一致。不要使用 `npx tx5dr-plugin`：npm 上没有同名包。

`minPluginApiVersion` 必须不低于插件实际构建所依赖的 `@tx5dr/plugin-api` 下限，
包括它打包进去的共享包；声明偏低会把插件发给缺少这些 API 的 Host。
`create-tx5dr-plugin` 生成的依赖范围与声明使用同一个版本。

### 3.2 Marketplace 版本解析

官方市场没有发布频道。`https://dl.tx5dr.com/plugins/market/index.json`（schema v3）
列出每个插件的全部已发布版本；每个版本带有不可变的 artifact、校验和、
`minPluginApiVersion` 和可选的撤回标记 `yanked`。Host 选择未撤回、且与本机
Plugin API 兼容的最高版本；没有时说明原因：需要升级 TX-5DR，或插件尚未发布
适配当前 Plugin API 主版本的版本。安装请求可以固定用户确认过的版本，
Host 下载后仍会校验 archive 内的静态 manifest 与该版本一致。

已安装但不兼容的插件不会被加载，但其安装记录仍在磁盘上，市场页会列出它，
并提供安装兼容版本（可能低于已装版本，需要用户确认）或卸载。降级不会删除
plugin-data，但旧版本不保证能读取新版本写入的数据。

已发布的插件版本不可替换；修正问题需要发布新版本，或在插件仓库的
registry 中撤回旧版本。Plugin API 新增或改变公开能力时必须提升
`@tx5dr/plugin-api` 版本，否则 Host 无法区分带有新能力的构建。
`<channel>/index.json`（schema v2）只为读取旧频道目录的已发布 Host 保留。

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
  startedAt, // 可选：本次呼叫尝试开始时间（Unix ms）
}
```

`record.startTime` 是 ADIF 的建联时刻，不是尝试开始时刻。`startedAt` 让 Host 按
整段呼叫尝试重建 `messageHistory`，避免对方延迟回复时只保留完成时隙附近的报文；
省略时回退到 `record.startTime`。Host 对过旧的锚点做上限裁剪。

Host 完成持久化后，可通过可选的 `settleQSOCompletion({ lifecycleEpoch, recordId,
status })` 通知 runtime。旧 lifecycle 的结果不会成为新 QSO 的 RF 决策依据。

同一完成记录重投时应保留原始 record ID、lifecycle 和内容，不能为重发最终 73
创建新记录。Host 冻结已接受任务的日志本与记录，重复提交复用原任务；明确失败
后通过日志本恢复界面显式重试。保存缓慢不是失败，不会自动重试或启动下一笔。

保存确认与物理完成回执在操作员事务边界交付，不能与 checkpoint/restore 并发
修改 runtime。暂停时暂存结果，恢复同一实例后交付；新实例不继承旧实例的结果。
这些通知不授予发射权限，不得用于恢复已经被用户关闭的 TX。共享标准 QSO
runtime 将稳定记录身份、保存确认和最终回复确认分开，协议快照回滚不撤销事实。
辅助队列沿用同一交付边界；只有日志确认成功且协议已经释放目标，才能移除完成
条目。多路物理完成仍以一帧的回执批次交付，不拆成会改变插件观察顺序的独立调用。

操作员状态中的可选 `qsoPersistence` 来自 Host，可显示保存中、保存缓慢和恢复
需求。它不属于插件私有 context，也不代替 `transmitGate`。手动起呼被拒绝时，
Host 向该连接返回原因；插件命令端口则拒绝对应 Promise。

标准通联启用 `autoReplyToDirectCallWhenStopped` 时，停发且无目标的 TX6 操作员可由
可靠的入站直呼或后续协议报文唤醒：CALL、信号报告、R-report、RRR/RR73 必须明确
发给本呼号。Host 将报文交给 strategy 决定 TX2 至 TX5 的回复阶段，再对齐对方
报文的下一发射周期；已通联规则、目标冲突和持久化约束仍由标准 runtime 验证。
单独的 73、部分解码、发给其他台站的报文不触发这条路径；辅助队列仍由自己的
执行许可与入站队列规则处理，不使用停发直呼唤醒。

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
`voice-right-top`、`cw-left-top`、`cw-right-top`、`rtty-left-top`、`rtty-right-top`、`radio-control-toolbar`。
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
      styles: 'standard', // Optional namespaced controls; absent keeps legacy styling.
      dialogSize: 'lg', // Optional sync action modal size: md / lg / 3xl.
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
`ctx.ui.pushToPage`、`ctx.ui.pushToSession` 和请求内的 `requestContext.page.push`
统一交给 Host 的页面会话投递器：既写入有界 HTTP 拉取队列，也发出 WS 通知。
独立页面因此可以接收定时器和其他页面触发的推送；重载或卸载插件会使旧会话失效，
页面需要刷新后重新建立会话，不会自动恢复旧会话的权限。
页面入口、路由、鉴权和 bridge 都由通用插件 Host 负责，插件不应自行调用 Electron IPC 或判断平台。
需要打开官方网站等外部 HTTP(S) 链接时，页面应调用 `tx5dr.openExternal(url)`；Host 在 Electron
中转交系统默认浏览器，在普通 Web 中打开新标签页，并拒绝非 HTTP(S) 协议。

Host 始终注入主题 tokens；运行时 CSS、bridge 的主题切换和 SDK `tokens.css` 参考文件来自同一份定义。
页面可声明 `styles: 'standard'`，由 Host 注入 `/_bridge/ui.css`，复用 `tx5dr-button`、
`tx5dr-input`、`tx5dr-label`、`tx5dr-field`、`tx5dr-actions`、`tx5dr-chip`、
`tx5dr-muted`、`tx5dr-feedback`、`tx5dr-progress`、`tx5dr-spinner` 和 `tx5dr-switch`。
主按钮使用 `tx5dr-button--primary`，错误反馈使用 `tx5dr-feedback--danger`。这些基础样式仅依赖
现有 tokens，不包含业务布局、弹窗或主应用 CSS。插件继续拥有 DOM、业务布局和文案。
SDK 也导出 `@tx5dr/plugin-api/ui.css`，适合独立开发预览；与 Host 路由使用同一份源码。
旧页面不声明 `styles` 时不加载这些 class，外观保持兼容。

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

### 自动禁用诊断

#### 业务失败与运行异常

插件负责在自己的协议/业务边界分类失败，Host 不根据 `timeout` 等消息文本或
`ctx.log` 的日志级别猜测严重程度：

| 层次 | 处理方与行为 |
| --- | --- |
| 可预期业务失败，如连接超时、服务离线、认证拒绝、限流 | 插件识别错误码/协议结果，更新自身连接状态、面板或页面提示，并按自身策略重试；hook 正常返回，不进入禁用计数 |
| 未处理的程序异常或不满足约定的数据 | 异常逃出 hook 后进入 Host 连续错误追踪；同一 hook 连续失败达到阈值触发禁用 |
| 生命周期或安全边界失败 | Host invocation 超时后撤销能力；取消后仍不结束则隔离。启动未完成就抛错、runtime 不兼容也保持现有保护 |

`ctx.log.error()` 仅写日志，不表示 hook 执行失败。插件可以记录业务失败，但用户可见
的连接状态、提示去重、退避重试和恢复提示仍由插件负责。不能只修改日志级别来分类，
也不要用覆盖整个 hook 的无条件 `catch` 吞掉所有异常。

网络请求应设置短于观察 hook 预算（目前 5 秒）的自身截止时间，并 `await` 请求和
响应体读取。网络超时是业务结果；Host 的执行期限用于约束 callback 生命周期，两者
含义不同。已经超过 Host 期限的任务不能因为声明为业务失败而继续使用能力。
`onLoad` 应完成本地初始化并注册 Host timer，远端离线通常进入插件自身 degraded
状态，之后通过新 timer invocation 重试，不应无限等待远端上线。

例如，插件可在协议适配层将已知错误转换为自己的业务错误，再在 hook 内处理：

```ts
class RemoteUnavailable extends Error {}

async function pollRemote(ctx) {
  let state;
  try {
    // 此适配器必须设置网络 deadline，且只将已知协议/网络失败转换为
    // RemoteUnavailable；未知异常直接向上抛出。使用具备 network 权限的 ctx。
    await requestRemoteStatus(ctx);
    state = { connected: true };
  } catch (error) {
    if (!(error instanceof RemoteUnavailable)) throw error;
    ctx.log.warn('Remote service unavailable');
    state = { connected: false, reason: 'remote-unavailable' };
  }
  // 插件面板通过自身 locale 解释状态；不要把凭据或原始远端响应发给前端。
  ctx.ui.send('connection-status', state);
}

// hooks.onTimer 中 return pollRemote(ctx)，不要脱离 invocation 后台执行。
```

这沿用现有 hook 契约，不增加绕过禁用的错误标记，也不由 Host 替插件执行自动重连。

#### 禁用证据

Host 在同一 hook 连续失败 5 次、`onLoad` 失败、取消后任务未在宽限期内结束，
或 strategy runtime 创建/校验失败时记录自动禁用原因。`PluginStatus.autoDisableInfo`
是可选的运行时诊断快照，包含原因、时间、失败操作、来源操作员及触发禁用的错误；
连续失败保留该 hook 的这 5 次错误，成功调用会重置该 hook 的计数和记录。
禁用后的迟到回调不能清除禁用状态或覆盖诊断证据。消息沿用服务器日志脱敏规则。

每次 hook 失败及最终禁用事件都会进入插件运行日志。诊断快照独立于滚动日志缓存，
保留到实例被重建；重载/重启会创建新实例，不作为持久故障审计存储。
连续错误仍按插件名停用全部实例，各实例携带相同的来源故障快照；其他失败保持
现有实例隔离范围。插件列表优先投影被禁用的实例，前端通过状态标签查看该快照，
无需根据日志文本推断原因。诊断快照及 `lastError` 仅管理员可读，HTTP 查询、
WebSocket 初始快照和后续推送使用相同的服务端权限投影；操作员仅接收基础状态。
插件运行日志实时推送和历史查询仍要求管理员权限。此诊断字段不改变配置启用状态与运行状态的区别，
也不新增自动恢复或重试机制。

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
9. `minPluginApiVersion`、运行时 definition 与 `@tx5dr/plugin-api` 依赖下限一致；
   修改已发布插件的打包内容时提升插件 `version`。

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

### Logbook sync status projection

`LogbookSyncProvider.getStatus(callsign)` is optional. It returns a detached,
credential-free `SyncStatus` snapshot or `null` when no valid state is available.
A status read must not start synchronization, perform remote I/O, or wait for an
upload queue. The Host validates the runtime schema and authorizes the callsign
before projecting it through `/api/plugins/sync-providers/status`. Invalid,
expired, missing, or timed-out projections are unavailable, not successful idle
states. Older providers without this method retain their existing UI behavior.

Plugins own operation identities, progress revisions, results, retries and
checkpoints. The Host does not infer completion or schedule work from this
projection. Optional automatic-upload summaries can coexist with a resumable
manual operation. Frontends retain the last snapshot on a read failure, mark it
stale, and discard lower revisions for the same operation.

Wavelog uses the existing callsign-bound iframe bridge to advance one remote
page or upload batch per invocation. Its short page execution lease is distinct
from the Host page session lifetime. Closing the page stops further advances;
an already accepted batch finishes its durable commit. Reopening resumes from
the plugin checkpoint. Neither page capabilities nor Host handles escape the
invocation that owns a batch.

A paused operation retains its type: an upload request cannot resume a download
or full sync. The plugin page exposes paged operation-specific error details,
while the shared status projection carries only a bounded summary.

A record the remote refuses permanently — a duplicate or a same-minute collision
— is recorded in the plugin checkpoint and counted as `rejected` instead of
failing the operation. A rejection stays terminal until the local QSO identity
changes or an explicit reconcile re-verifies it, so re-running a sync cannot
surface the same record as a new error. Failures with no definitive remote
answer — network loss, timeouts, 5xx, or a successful status whose body cannot be
parsed (a proxy or PHP error page) — keep their records pending and end the run
as a retryable failure; they are never recorded as rejections.

A remote record that cannot be parsed is skipped and reported as a bounded
failure while the download cursor advances, so one malformed contact cannot pin
the operation. Contact identity compares the ADIF spelling, treating `MFSK` with
an `FT8` submode as `FT8`; FT4 keeps its existing projection so stored
checkpoints stay valid.

The automatic-upload queue is capped per provider and callsign and evicts the
oldest QSOs first; an unreadable queue file is quarantined and the queue starts
empty instead of blocking engine startup. When a provider cannot be evaluated
(plugin reloading or unavailable), a completed QSO is reported as *not* queued
rather than silently dropped. A provider id belongs to the plugin that registered
it: another plugin cannot claim an active id, and a reused id starts without the
previous owner's backlog.

Sync actions can opt into `pageParams` to open the same page for different operations.
The Host supplies a stable `launchId` for each click, including across iframe reloads;
plugin-declared parameters cannot override resource bindings, credentials or reserved
Host parameters. `launchId` is a correlation/idempotency key, never authorization.
Page handlers must use the Host-authorized `requestContext` resource. Page descriptors
may declare `dialogSize` (`md`, `lg`, `3xl`); the container owns its title, close action,
focus and scrolling. Business content uses `resize()` and `requestClose()`.

Providers may project `trigger` and `launchId` with their status. The frontend first
establishes a quiet baseline and notifies a locally initiated manual result once.
Automatic success and historical success are quiet; automatic failure and pending
historical work mark the entry. Client dismissal/notification memory is isolated by
callsign, provider and operation, and never modifies plugin checkpoints. A stale
active snapshot remains visible with an unavailable marker, never a fabricated
completion. Inspecting a result does not renew an execution lease or advance work.

Built-in sync providers serialize execution per provider instance and normalized
callsign. Competing manual work returns a retryable `sync_busy`; automatic callers
await the gate inside their invocation and refresh queued record state after entry.
Configuration/certificate mutations are rejected while relevant execution is active.
Different services may perform network I/O concurrently. Local commits use
`reconcileLogbookBatch` with `expectedRevision`, rebuilding minimal patches after a
revision conflict without repeating remote uploads. QRZ and LoTW persist remote
acceptance IDs/dates until local sent-state patches commit, so a local conflict does
not force retransmission. No Host task scheduler or cross-provider network lock is
involved; these guarantees do not extend to independent TX-5DR processes.

### Automatic sync performance boundary

`QSOQueryFilter.ids` optionally selects at most 1,000 exact IDs through the local
record index. An empty list returns no records and a current revision; missing
IDs are omitted. Other filters still apply. Use the same filtered
`readQsoSnapshot()` when replanning a sent-state patch after a revision conflict.
A moved record keeps its ID; a deleted record must not be reconstructed from an
old automatic queue snapshot. The Host still authorizes the bound logbook and
validates the ID input. Returned snapshots remain detached and capability-checked;
a Host-marked detached result avoids a redundant Guard copy.

Built-in QRZ and LoTW automatic backlogs refresh and commit at most 100 records at
a time inside the awaited provider invocation. Remote acceptance receipts survive
local commit failures, and repair reads only the corresponding IDs. A failed
batch leaves the existing Host queue available for retry; local replanning does
not repeat successful remote POSTs.

Wavelog keeps its checkpoint file format and durability ordering. Automatic writes
encode large collections in short event-loop slices; the last accepted batch and
terminal status share one commit. Club Log caches its ledger within the provider
instance and invalidates the cache on persistence failure. Its existing KV key,
JSON format and synchronous KV costs remain. No migration, new worker, or new
Host task mechanism is involved. Cold loading, native IPC and whole-file writes
are measured separately from cooperative CPU work.

## Declarative audio peers

Plugins may declare `simulationScenarios` for FT8/FT4 and RTTY peer exchanges.
The Host validates and freezes these declarations and owns decoding, scheduling,
encoding and audio. An RTTY peer has no transmit slots: a received message is the
text of one complete station transmission, and cycle counts in rules and timeouts
count those transmissions. Built-in standard exchanges use the same contract as external
plugins. Scenarios do not receive station strategy state or device handles.
See [Station testing](architecture/station-testing.md) for evidence and lifetime.
