import type { StrategyPluginContext, StrategyRuntime } from '@tx5dr/plugin-api';
import {
  createStandardQSOPluginRuntime,
  standardQSOLocales,
  standardQSOQuickSettings,
  standardQSOSettings,
} from '../standard-qso/index.js';

export function createContestStrategyRuntime(ctx: StrategyPluginContext): StrategyRuntime {
  return createStandardQSOPluginRuntime(ctx as Parameters<typeof createStandardQSOPluginRuntime>[0]);
}

export { standardQSOQuickSettings, standardQSOSettings };

export function contestLocales(
  title: string,
  en: string,
  zh: string,
  ja: string,
): Record<string, Record<string, string>> {
  return {
    en: { ...standardQSOLocales.en, pluginName: title, pluginDescription: en, contestLogTitle: 'Contest log', contestNewCallsign: 'New on band', contestNewMultiplier: 'New multiplier' },
    zh: { ...standardQSOLocales.zh, pluginName: title, pluginDescription: zh, contestLogTitle: '比赛日志', contestNewCallsign: '本波段新台', contestNewMultiplier: '新系数' },
    ja: { ...standardQSOLocales.ja, pluginName: title, pluginDescription: ja, contestLogTitle: 'コンテストログ', contestNewCallsign: 'このバンドで未交信', contestNewMultiplier: '新マルチ' },
  };
}
