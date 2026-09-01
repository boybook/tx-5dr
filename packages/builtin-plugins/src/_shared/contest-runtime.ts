import type { StrategyPluginContext, StrategyRuntime } from '@tx5dr/plugin-api';
import {
  createStandardQSOPluginRuntime,
  standardQSOQuickSettings,
  standardQSOSettings,
} from '../standard-qso/index.js';

export function createContestStrategyRuntime(ctx: StrategyPluginContext): StrategyRuntime {
  return createStandardQSOPluginRuntime(ctx as Parameters<typeof createStandardQSOPluginRuntime>[0]);
}

export { standardQSOQuickSettings, standardQSOSettings };

export function contestLocaleLabel(en: string, zh: string, ja: string): Record<string, Record<string, string>> {
  return {
    en: { pluginDescription: en },
    zh: { pluginDescription: zh },
    ja: { pluginDescription: ja },
  };
}
