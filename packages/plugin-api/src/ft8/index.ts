import type { ModeDescriptor, OperatorConfig, PluginQuickSetting, PluginSettingDescriptor } from '@tx5dr/contracts';
import type { StrategyPluginContext } from '../context.js';
export {
  FT8MessageParser,
  CycleUtils,
  calculateGridDistance,
  getStandardDigitalFrequencyMatch,
  isUndecodedCallsignPlaceholder,
  isValidCallsign,
} from '@tx5dr/core';
import {
  buildStandardQSODefaultTx6Message,
  normalizeStandardQSOTx6MessageOverride,
  StandardQSOPluginRuntime,
  STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING,
  type StandardQSOOperatorConfig,
} from './StandardQSOPluginRuntime.js';

export {
  buildStandardQSODefaultTx6Message,
  normalizeStandardQSOTx6MessageOverride,
  StandardQSOPluginRuntime,
  STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING,
} from './StandardQSOPluginRuntime.js';
export type {
  StandardQSOOperatorConfig,
  StandardQSOPluginOperator,
  StandardQSOActivationRequest,
  StandardQSOActivationResult,
} from './StandardQSOPluginRuntime.js';

export function getStandardQSOConfig(ctx: {
  config: Record<string, unknown>;
  operator: {
    id: string;
    callsign: string;
    grid: string;
    frequency: number;
    mode: ModeDescriptor;
    transmitCycles: number[];
  };
}): StandardQSOOperatorConfig {
  const c = ctx.config;
  const baseConfig: OperatorConfig = {
    id: ctx.operator.id,
    myCallsign: ctx.operator.callsign,
    myGrid: ctx.operator.grid,
    frequency: ctx.operator.frequency,
    mode: ctx.operator.mode,
    transmitCycles: ctx.operator.transmitCycles,
    autoReplyToCQ: (c.autoReplyToCQ as boolean) ?? false,
    autoResumeCQAfterFail: (c.autoResumeCQAfterFail as boolean) ?? false,
    autoResumeCQAfterSuccess: (c.autoResumeCQAfterSuccess as boolean) ?? false,
    replyToWorkedStations: (c.replyToWorkedStations as boolean) ?? false,
    prioritizeNewCalls: true,
    targetSelectionPriorityMode: ((c.targetSelectionPriorityMode as string) ?? 'dxcc_first') as OperatorConfig['targetSelectionPriorityMode'],
    maxQSOTimeoutCycles: (c.maxQSOTimeoutCycles as number) ?? 6,
    maxCallAttempts: (c.maxCallAttempts as number) ?? 5,
  };
  const defaultTx6Message = buildStandardQSODefaultTx6Message(baseConfig);
  return {
    ...baseConfig,
    autoReplyToDirectCallWhenStopped: (c.autoReplyToDirectCallWhenStopped as boolean | undefined) ?? false,
    skipTx1: c.skipTx1 === true,
    distinguishWorkedStationsByBand: (c.distinguishWorkedStationsByBand as boolean | undefined) ?? true,
    tx6MessageOverride: normalizeStandardQSOTx6MessageOverride(
      c[STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING],
      defaultTx6Message,
    ),
  };
}

export const standardQSOSettings: Record<string, PluginSettingDescriptor> = {
  strategyOverview: { type: 'info', default: '', label: 'strategyOverview', description: 'strategyOverviewDesc', scope: 'operator' },
  autoReplyToCQ: { type: 'boolean', default: false, label: 'autoReplyToCQ', description: 'autoReplyToCQDesc', scope: 'operator' },
  autoReplyToDirectCallWhenStopped: { type: 'boolean', default: false, label: 'autoReplyToDirectCallWhenStopped', description: 'autoReplyToDirectCallWhenStoppedDesc', scope: 'operator' },
  autoResumeCQAfterFail: { type: 'boolean', default: false, label: 'autoResumeCQAfterFail', description: 'autoResumeCQAfterFailDesc', scope: 'operator' },
  autoResumeCQAfterSuccess: { type: 'boolean', default: false, label: 'autoResumeCQAfterSuccess', description: 'autoResumeCQAfterSuccessDesc', scope: 'operator' },
  replyToWorkedStations: { type: 'boolean', default: false, label: 'replyToWorkedStations', description: 'replyToWorkedStationsDesc', scope: 'operator' },
  distinguishWorkedStationsByBand: { type: 'boolean', default: true, label: 'distinguishWorkedStationsByBand', description: 'distinguishWorkedStationsByBandDesc', scope: 'operator' },
  skipTx1: { type: 'boolean', default: false, label: 'skipTx1', description: 'skipTx1Desc', scope: 'operator' },
  targetSelectionPriorityMode: {
    type: 'string',
    default: 'dxcc_first',
    label: 'targetSelectionPriorityMode',
    description: 'targetSelectionPriorityModeDesc',
    scope: 'operator',
    options: [
      { label: 'dxcc_first', value: 'dxcc_first' },
      { label: 'new_callsign_first', value: 'new_callsign_first' },
      { label: 'balanced', value: 'balanced' },
    ],
  },
  maxQSOTimeoutCycles: { type: 'number', default: 6, label: 'maxQSOTimeoutCycles', description: 'maxQSOTimeoutCyclesDesc', scope: 'operator', min: 1, max: 20 },
  maxCallAttempts: { type: 'number', default: 5, label: 'maxCallAttempts', description: 'maxCallAttemptsDesc', scope: 'operator', min: 1, max: 20 },
  [STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING]: { type: 'string', default: '', label: STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING, scope: 'operator', hidden: true },
};

export const standardQSOQuickSettings: PluginQuickSetting[] = [
  { settingKey: 'autoReplyToCQ' },
  { settingKey: 'autoReplyToDirectCallWhenStopped' },
  { settingKey: 'autoResumeCQAfterFail' },
  { settingKey: 'autoResumeCQAfterSuccess' },
  { settingKey: 'replyToWorkedStations' },
  { settingKey: 'skipTx1' },
];

export function createStandardQSOPluginRuntime(ctx: StrategyPluginContext): StandardQSOPluginRuntime {
  const runtime = {
    get config(): StandardQSOOperatorConfig {
      return getStandardQSOConfig(ctx);
    },
    async hasWorkedCallsign(callsign: string, options?: { anyBand?: boolean }): Promise<boolean> {
      const config = getStandardQSOConfig(ctx);
      return ctx.operator.hasWorkedCallsign(callsign, {
        anyBand: options?.anyBand ?? config.distinguishWorkedStationsByBand === false,
      });
    },
    isTargetBeingWorkedByOthers(targetCallsign: string): boolean {
      return ctx.operator.isTargetBeingWorkedByOthers(targetCallsign);
    },
  } satisfies ConstructorParameters<typeof StandardQSOPluginRuntime>[0];
  return new StandardQSOPluginRuntime(runtime, ctx.log);
}

export const standardQSOLocales: Record<string, Record<string, string>> = {
  en: {
    pluginName: 'Standard QSO',
    pluginDescription: 'Standard FT8/FT4 QSO workflow',
    strategyOverview: 'Workflow overview',
    strategyOverviewDesc: 'This QSO workflow follows the standard FT8/FT4 flow, including answering others\' CQ, automatic target selection, timeout handling, and retry behavior.',
    autoReplyToCQ: 'Answer others\' CQ',
    autoReplyToCQDesc: 'While listening, automatically choose and call eligible stations calling CQ. This setting does not mean starting your own CQ.',
    autoReplyToDirectCallWhenStopped: 'Answer worked direct calls while idle',
    autoReplyToDirectCallWhenStoppedDesc: 'When the operator is stopped and idle in TX6, a direct call to this callsign can wake transmit and be answered while still respecting contest-session worked checks.',
    autoResumeCQAfterFail: 'Continue CQ after failure',
    autoResumeCQAfterFailDesc: 'After several no-response rounds or the call-attempt limit, return to TX6/CQ and keep listening or calling.',
    autoResumeCQAfterSuccess: 'Continue CQ after QSO',
    autoResumeCQAfterSuccessDesc: 'After sending 73, return to TX6/CQ automatically.',
    replyToWorkedStations: 'Answer worked direct calls',
    replyToWorkedStationsDesc: 'When enabled, direct callers are answered even if their callsign is already in the contest log.',
    distinguishWorkedStationsByBand: 'Judge worked by band',
    distinguishWorkedStationsByBandDesc: 'On: only QSOs on the current band count as worked. Off: a callsign worked on any band counts as worked.',
    skipTx1: 'Skip TX1 grid',
    skipTx1Desc: 'Skip the initial grid exchange and send the signal report first.',
    targetSelectionPriorityMode: 'Auto pick preference',
    targetSelectionPriorityModeDesc: 'Choose whether to prefer new DXCC entities, new grids, or new callsigns.',
    maxQSOTimeoutCycles: 'No-response timeout cycles',
    maxQSOTimeoutCyclesDesc: 'How many cycles without progress count as a timeout.',
    maxCallAttempts: 'Max TX1 call cycles',
    maxCallAttemptsDesc: 'How many cycles to repeat the initial call before failure.',
    dxcc_first: 'DXCC First',
    new_callsign_first: 'New Callsign First',
    balanced: 'Balanced',
    startCQ: 'Start CQ',
    stopTransmitting: 'Stop Transmitting',
  },
  zh: {
    pluginName: '标准通联',
    pluginDescription: '标准 FT8/FT4 通联机制',
    strategyOverview: '机制说明',
    strategyOverviewDesc: '该通联机制负责回应 CQ、自动选台、超时和重试等标准 FT8/FT4 流程。',
    autoReplyToCQ: '自动回应他人 CQ',
    autoReplyToCQDesc: '守听时自动选择并呼叫符合条件的 CQ 电台。',
    autoReplyToDirectCallWhenStopped: '停发待机时回应直呼',
    autoReplyToDirectCallWhenStoppedDesc: '停发待机时回应直呼，同时使用比赛日志判断已通联状态。',
    autoResumeCQAfterFail: '失败后继续 CQ',
    autoResumeCQAfterFailDesc: '无回应或达到呼叫上限后回到 TX6/CQ。',
    autoResumeCQAfterSuccess: '完成 QSO 后继续 CQ',
    autoResumeCQAfterSuccessDesc: '发送 73 后自动回到 TX6/CQ。',
    replyToWorkedStations: '已通联直呼也回应',
    replyToWorkedStationsDesc: '即使呼号已在比赛日志中，也回应对方直呼。',
    distinguishWorkedStationsByBand: '按频段判断已通联',
    distinguishWorkedStationsByBandDesc: '开启时只判断当前频段，关闭时任意频段都算已通联。',
    skipTx1: '跳过 TX1 网格',
    skipTx1Desc: '跳过首轮网格交换，直接发送信号报告。',
    targetSelectionPriorityMode: '自动选台偏好',
    targetSelectionPriorityModeDesc: '选择优先追逐新 DXCC、新网格或新呼号。',
    maxQSOTimeoutCycles: '无回应超时轮数',
    maxQSOTimeoutCyclesDesc: '连续多少轮没有进展后判为超时。',
    maxCallAttempts: 'TX1 最多呼叫轮数',
    maxCallAttemptsDesc: '首呼阶段最多重复呼叫多少轮。',
    dxcc_first: '优先新 DXCC',
    new_callsign_first: '优先新呼号',
    balanced: '平衡模式',
    startCQ: '发起 CQ',
    stopTransmitting: '停止发射',
  },
  ja: {
    pluginName: '標準交信',
    pluginDescription: '標準 FT8/FT4 交信方式',
    strategyOverview: '交信方式の説明',
    strategyOverviewDesc: 'CQ 応答、自動選局、タイムアウト、再試行を含む標準 FT8/FT4 手順です。',
    autoReplyToCQ: '他局の CQ に自動応答',
    autoReplyToCQDesc: '条件に合う CQ 局を自動で選択して呼び出します。',
    autoReplyToDirectCallWhenStopped: '停止待機中も直呼びに応答',
    autoReplyToDirectCallWhenStoppedDesc: '停止待機中の直呼びに応答し、コンテストログの交信済み判定を使います。',
    autoResumeCQAfterFail: '失敗後も CQ 継続',
    autoResumeCQAfterFailDesc: '応答がない、または上限に達した後に TX6/CQ へ戻ります。',
    autoResumeCQAfterSuccess: 'QSO 完了後も CQ 継続',
    autoResumeCQAfterSuccessDesc: '73 送信後に TX6/CQ へ戻ります。',
    replyToWorkedStations: '交信済みの直呼びにも応答',
    replyToWorkedStationsDesc: 'コンテストログにある局からの直呼びにも応答します。',
    distinguishWorkedStationsByBand: 'バンド別に交信済み判定',
    distinguishWorkedStationsByBandDesc: 'オンは現在のバンドのみ、オフは全バンドを確認します。',
    skipTx1: 'TX1 グリッドをスキップ',
    skipTx1Desc: '初回のグリッド交換を省略して信号レポートを送ります。',
    targetSelectionPriorityMode: '自動選局の優先度',
    targetSelectionPriorityModeDesc: '新しい DXCC、グリッド、コールサインの優先度を選びます。',
    maxQSOTimeoutCycles: '無応答タイムアウト周期',
    maxQSOTimeoutCyclesDesc: '進展がない周期が何回続けばタイムアウトとするかを指定します。',
    maxCallAttempts: 'TX1 最大呼出周期',
    maxCallAttemptsDesc: '初回呼び出しを繰り返す最大周期です。',
    dxcc_first: '新しい DXCC を優先',
    new_callsign_first: '新しいコールサインを優先',
    balanced: 'バランスモード',
    startCQ: 'CQ を開始',
    stopTransmitting: '送信を停止',
  },
};
