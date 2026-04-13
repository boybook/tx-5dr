import type { PluginDefinition } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

function getSenderCallsign(message: unknown): string {
  if (typeof message === 'object' && message !== null && 'senderCallsign' in message) {
    const callsign = (message as { senderCallsign?: unknown }).senderCallsign;
    return typeof callsign === 'string' ? callsign : '';
  }
  return '';
}

export const callsignPrefixFilterPlugin: PluginDefinition = {
  name: 'callsign-prefix-filter',
  version: '1.0.0',
  type: 'utility',
  description: 'Filter candidates by callsign prefixes or exact matches',

  settings: {
    filterOverview: {
      type: 'info',
      default: '',
      label: 'filterOverview',
      description: 'filterOverviewDesc',
      scope: 'global',
    },
    allowedPrefixes: {
      type: 'string[]',
      default: [],
      label: 'allowedPrefixes',
      description: 'allowedPrefixesDesc',
      scope: 'global',
    },
    matchMode: {
      type: 'string',
      default: 'prefix',
      label: 'matchMode',
      description: 'matchModeDesc',
      scope: 'global',
      options: [
        { label: 'prefixMode', value: 'prefix' },
        { label: 'exactMode', value: 'exact' },
      ],
    },
  },

  hooks: {
    onFilterCandidates(candidates, ctx) {
      const rawEntries = Array.isArray(ctx.config.allowedPrefixes)
        ? ctx.config.allowedPrefixes
        : [];
      const entries = rawEntries
        .map((entry) => (typeof entry === 'string' ? entry.trim().toUpperCase() : ''))
        .filter(Boolean);
      if (entries.length === 0) {
        return candidates;
      }

      const matchMode = ctx.config.matchMode === 'exact' ? 'exact' : 'prefix';
      const filtered = candidates.filter((candidate) => {
        const sender = getSenderCallsign(candidate.message).toUpperCase();
        if (!sender) {
          return false;
        }
        return matchMode === 'exact'
          ? entries.includes(sender)
          : entries.some((entry) => sender.startsWith(entry));
      });

      ctx.log.debug('Callsign prefix filter applied', {
        before: candidates.length,
        after: filtered.length,
        matchMode,
        entryCount: entries.length,
      });

      return filtered;
    },
  },
};

export const callsignPrefixFilterLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
