import {
  definePlugin,
  type PluginQuickSetting,
  type PluginSettingDescriptor,
  type StrategyPluginContext,
} from '@tx5dr/plugin-api';
import {
  getStandardQSOConfig,
  standardQSOLocales,
  standardQSOSettings,
} from '../standard-qso/index.js';
import type {
  StandardQSOOperatorConfig,
  StandardQSOPluginOperator,
} from '../standard-qso/StandardQSOPluginRuntime.js';
import { AssistedQSOQueueRuntime } from './AssistedQSOQueueRuntime.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

export const BUILTIN_ASSISTED_QSO_QUEUE_PLUGIN_NAME = 'assisted-qso-queue';

const ASSISTED_QSO_QUEUE_SETTING_KEYS = [
  'strategyOverview',
  'replyToWorkedStations',
  'distinguishWorkedStationsByBand',
  'skipTx1',
  'maxQSOTimeoutCycles',
  'maxCallAttempts',
] as const;

export const assistedQSOQueueSettings: Record<string, PluginSettingDescriptor> = {
  ...Object.fromEntries(
    ASSISTED_QSO_QUEUE_SETTING_KEYS.map((key) => [key, standardQSOSettings[key]]),
  ),
  parallelStreams: {
    type: 'number',
    default: 1,
    label: 'parallelStreams',
    description: 'parallelStreamsDesc',
    scope: 'operator',
    min: 1,
    max: 3,
  },
};

export const assistedQSOQueueQuickSettings: PluginQuickSetting[] = [
  { settingKey: 'replyToWorkedStations' },
  { settingKey: 'distinguishWorkedStationsByBand' },
  { settingKey: 'skipTx1' },
  { settingKey: 'parallelStreams' },
];

function createOperator(ctx: StrategyPluginContext): StandardQSOPluginOperator {
  return {
    get config(): StandardQSOOperatorConfig {
      const config = getStandardQSOConfig(ctx);
      return {
        ...config,
        autoReplyToCQ: false,
        autoReplyToDirectCallWhenStopped: false,
        autoResumeCQAfterFail: false,
        autoResumeCQAfterSuccess: false,
      };
    },
    async hasWorkedCallsign(callsign: string): Promise<boolean> {
      const config = getStandardQSOConfig(ctx);
      return ctx.operator.hasWorkedCallsign(callsign, {
        anyBand: config.distinguishWorkedStationsByBand === false,
      });
    },
    isTargetBeingWorkedByOthers(callsign: string): boolean {
      return ctx.operator.isTargetBeingWorkedByOthers(callsign);
    },
  };
}

export const assistedQSOQueueStrategyPlugin = definePlugin({
  apiVersion: 2,
  name: BUILTIN_ASSISTED_QSO_QUEUE_PLUGIN_NAME,
  version: '1.0.0',
  type: 'strategy',
  strategyFeatures: {
    targetQueue: 1,
    parallelTargetQueue: 1,
    queueActivation: 'immediate',
    maxConcurrentStreams: 3,
  },
  description: 'Assisted FT8/FT4 target queue using the standard QSO protocol',
  settings: assistedQSOQueueSettings,
  quickSettings: assistedQSOQueueQuickSettings,
  createStrategyRuntime(ctx) {
    return new AssistedQSOQueueRuntime({
      operator: createOperator(ctx),
      isTransmitting: () => ctx.operator.isTransmitting,
      logger: ctx.log,
      getMaxStreams: () => Number(ctx.config.parallelStreams ?? 1),
    });
  },
});

export const assistedQSOQueueLocales: Record<string, Record<string, string>> = {
  zh: { ...standardQSOLocales.zh, ...zhLocale },
  en: { ...standardQSOLocales.en, ...enLocale },
  ja: { ...standardQSOLocales.ja, ...jaLocale },
};

export { AssistedQSOQueueRuntime } from './AssistedQSOQueueRuntime.js';
