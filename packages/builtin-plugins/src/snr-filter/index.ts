import type { PluginDefinition } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

/**
 * SNR Filter — 内置示例工具插件（默认未启用）
 *
 * 过滤候选目标，只回复 SNR 高于阈值的台站。
 *
 * 此插件展示了：
 * - onFilterCandidates pipeline hook 的用法
 * - global-scope settings 的声明方式
 * - 插件自包含的翻译（locales/ 在插件目录内）
 *
 * 用户可以将此插件作为编写工具插件的参考范本。
 */
export const snrFilterPlugin: PluginDefinition = {
  name: 'snr-filter',
  version: '1.0.0',
  type: 'utility',
  description: 'Filter candidates below a minimum SNR threshold',

  settings: {
    filterOverview: {
      type: 'info',
      default: '',
      label: 'filterOverview',
      description: 'filterOverviewDesc',
      scope: 'global',
    },
    minSNR: {
      type: 'number',
      default: -15,
      label: 'minSNR',
      description: 'minSNRDesc',
      scope: 'global',
      min: -30,
      max: 10,
    },
  },

  hooks: {
    onFilterCandidates(candidates, ctx) {
      const minSNR = (ctx.config.minSNR as number) ?? -15;
      const filtered = candidates.filter(c => c.snr >= minSNR);

      if (filtered.length < candidates.length) {
        ctx.log.debug('SNR filter applied', {
          before: candidates.length,
          after: filtered.length,
          minSNR,
        });
      }

      return filtered;
    },
  },
};

/** 内置翻译，随插件一起编译进 bundle */
export const snrFilterLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
