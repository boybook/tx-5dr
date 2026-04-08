import type {
  OperatorSlots,
  PluginDefinition,
  QSORecord,
  TargetSelectionPriorityMode,
} from '@tx5dr/plugin-api';
import type {
  OperatorConfig,
} from '@tx5dr/contracts';
import {
  StandardQSOPluginRuntime,
  type StandardQSOPluginOperator,
} from './StandardQSOPluginRuntime.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

/**
 * 内置标准 QSO 策略插件
 *
 * 插件目录内直接持有标准 QSO 运行时实现，不再依赖 core 中的策略抽象。
 * 该内建实现仍会使用部分 contracts 内部类型，不作为外部插件作者的导入示例。
 *
 * 配置来源：所有自动化设置（autoReplyToCQ 等）来自 ctx.config（operator-scope
 * plugin settings），不再依赖 RadioOperatorConfig。
 */

export const BUILTIN_STANDARD_QSO_PLUGIN_NAME = 'standard-qso';

function getStandardQSOConfig(ctx: {
  config: Record<string, unknown>;
  operator: {
    id: string;
    callsign: string;
    grid: string;
    frequency: number;
    mode: OperatorConfig['mode'];
    transmitCycles: number[];
  };
}): OperatorConfig {
  const c = ctx.config;
  return {
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
    targetSelectionPriorityMode: ((c.targetSelectionPriorityMode as string) ?? 'dxcc_first') as TargetSelectionPriorityMode,
    maxQSOTimeoutCycles: (c.maxQSOTimeoutCycles as number) ?? 6,
    maxCallAttempts: (c.maxCallAttempts as number) ?? 5,
  };
}

export const standardQSOStrategyPlugin: PluginDefinition = {
  name: BUILTIN_STANDARD_QSO_PLUGIN_NAME,
  version: '1.0.0',
  type: 'strategy',
  description: 'Built-in FT8/FT4 standard QSO automation strategy',

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
    autoResumeCQAfterFail: {
      type: 'boolean',
      default: false,
      label: 'autoResumeCQAfterFail',
      scope: 'operator',
    },
    autoResumeCQAfterSuccess: {
      type: 'boolean',
      default: false,
      label: 'autoResumeCQAfterSuccess',
      scope: 'operator',
    },
    replyToWorkedStations: {
      type: 'boolean',
      default: false,
      label: 'replyToWorkedStations',
      scope: 'operator',
    },
    targetSelectionPriorityMode: {
      type: 'string',
      default: 'dxcc_first',
      label: 'targetSelectionPriorityMode',
      scope: 'operator',
      options: [
        { label: 'dxcc_first', value: 'dxcc_first' },
        { label: 'new_callsign_first', value: 'new_callsign_first' },
        { label: 'balanced', value: 'balanced' },
      ],
    },
    maxQSOTimeoutCycles: {
      type: 'number',
      default: 6,
      label: 'maxQSOTimeoutCycles',
      scope: 'operator',
      min: 1,
      max: 20,
    },
    maxCallAttempts: {
      type: 'number',
      default: 5,
      label: 'maxCallAttempts',
      scope: 'operator',
      min: 1,
      max: 20,
    },
  },

  /**
   * 快捷设置 — 在右上角自动化下拉面板中直接渲染 operator-scope setting
   */
  quickSettings: [
    { settingKey: 'autoReplyToCQ' },
    { settingKey: 'autoResumeCQAfterFail' },
    { settingKey: 'autoResumeCQAfterSuccess' },
    { settingKey: 'replyToWorkedStations' },
  ],

  createStrategyRuntime(ctx) {
    const operatorId = ctx.operator.id;
    const runtime: StandardQSOPluginOperator = {
      get config(): OperatorConfig {
        return getStandardQSOConfig(ctx);
      },
      async hasWorkedCallsign(callsign: string): Promise<boolean> {
        return ctx.operator.hasWorkedCallsign(callsign);
      },
      isTargetBeingWorkedByOthers(targetCallsign: string): boolean {
        return ctx.operator.isTargetBeingWorkedByOthers(targetCallsign);
      },
      recordQSOLog(record: QSORecord): void {
        ctx.operator.recordQSO(record);
      },
      notifySlotsUpdated(slots: OperatorSlots): void {
        ctx.operator.notifySlotsUpdated(slots);
      },
      notifyStateChanged(state: string): void {
        ctx.operator.notifyStateChanged(state);
      },
    };
    const strategy = new StandardQSOPluginRuntime(runtime);
    ctx.log.info('Standard QSO strategy initialized', { operatorId });
    return strategy;
  },

  hooks: {
    onConfigChange(_changes, ctx) {
      ctx.log.debug('Standard QSO config changed');
    },
  },
};

/** 内置翻译，随插件一起编译进 bundle */
export const standardQSOLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
