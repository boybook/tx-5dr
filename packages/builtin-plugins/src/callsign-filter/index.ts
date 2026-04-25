import type { PluginDefinition } from '@tx5dr/plugin-api';
import {
  evaluateCallsignFilter,
  normalizeCallsignFilterMode,
  parseCallsignFilterRules,
} from '@tx5dr/core';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

function getSenderCallsign(message: unknown): string {
  if (typeof message === 'object' && message !== null && 'senderCallsign' in message) {
    const callsign = (message as { senderCallsign?: unknown }).senderCallsign;
    return typeof callsign === 'string' ? callsign : '';
  }
  return '';
}

export const callsignFilterPlugin: PluginDefinition = {
  name: 'callsign-filter',
  version: '1.0.0',
  type: 'utility',
  description: 'Filter candidate stations by callsign or advanced regex keep rules',

  settings: {
    filterOverview: {
      type: 'info',
      default: '',
      label: 'filterOverview',
      description: 'filterOverviewDesc',
      scope: 'operator',
    },
    filterMode: {
      type: 'string',
      default: 'blocklist',
      label: 'filterMode',
      description: 'filterModeDesc',
      scope: 'operator',
      options: [
        { label: 'filterModeBlocklist', value: 'blocklist' },
        { label: 'filterModeRegexKeep', value: 'regex-keep' },
      ],
    },
    filterRules: {
      type: 'string[]',
      default: [],
      label: 'filterRules',
      description: 'filterRulesDesc',
      scope: 'operator',
    },
    filterScope: {
      type: 'string',
      default: 'auto-reply',
      label: 'filterScope',
      description: 'filterScopeDesc',
      scope: 'operator',
      options: [
        { label: 'scopeAutoReply', value: 'auto-reply' },
        { label: 'scopeAutoReplyAndDisplay', value: 'auto-reply-and-display' },
      ],
    },
  },

  quickSettings: [
    { settingKey: 'filterMode' },
    { settingKey: 'filterRules' },
    { settingKey: 'filterScope' },
  ],

  hooks: {
    onFilterCandidates(candidates, ctx) {
      const rawEntries = Array.isArray(ctx.config.filterRules)
        ? ctx.config.filterRules
        : [];
      const filterMode = normalizeCallsignFilterMode(ctx.config.filterMode);
      const rules = parseCallsignFilterRules(rawEntries as string[], filterMode);
      if (rules.length === 0) {
        return candidates;
      }

      const filtered = candidates.filter((candidate) => {
        const sender = getSenderCallsign(candidate.message);
        if (!sender) {
          return false;
        }
        return evaluateCallsignFilter(sender, rules);
      });

      ctx.log.debug('Callsign filter applied', {
        before: candidates.length,
        after: filtered.length,
        ruleCount: rules.length,
        mode: filterMode,
      });

      return filtered;
    },
  },
};

export const callsignFilterLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
