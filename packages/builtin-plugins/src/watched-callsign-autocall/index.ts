import {
  type AutoCallProposal,
  type LastMessageInfo,
  type ParsedFT8Message,
  type PluginContext,
  type PluginDefinition,
  type SlotInfo,
} from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import {
  getSenderCallsign,
  getTriggerMode,
  getAutocallPriority as getAutocallPriorityBase,
  compareByScoreThenSnr,
  isPureStandby,
  shouldTriggerMessage,
  toFrameMessage,
} from '../_shared/autocall-utils.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

type LegacyMatchMode = 'exact' | 'prefix';
type WatchRule = {
  raw: string;
  type: 'exact' | 'prefix' | 'regex';
  matches: (callsign: string) => boolean;
};
const REGEX_META_CHARS = /[\\^$.*+?()[\]{}|]/;

function normalizeWatchList(rawValue: unknown): string[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => Boolean(entry) && !entry.startsWith('#'));
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLegacyMatchMode(ctx: PluginContext): LegacyMatchMode {
  return ctx.config.matchMode === 'prefix' ? 'prefix' : 'exact';
}

function getAutocallPriority(ctx: PluginContext): number {
  return getAutocallPriorityBase(ctx, 100);
}

function buildWatchRules(ctx: PluginContext): WatchRule[] {
  const legacyMatchMode = getLegacyMatchMode(ctx);
  const rules: WatchRule[] = [];

  for (const rawEntry of normalizeWatchList(ctx.config.watchList)) {
    if (REGEX_META_CHARS.test(rawEntry)) {
      try {
        const regex = new RegExp(rawEntry, 'i');
        rules.push({
          raw: rawEntry,
          type: 'regex',
          matches: (callsign) => regex.test(callsign),
        });
      } catch (error) {
        ctx.log.warn('Watched callsign regex is invalid and will be ignored', {
          entry: rawEntry,
          error,
        });
      }
      continue;
    }

    const normalizedEntry = rawEntry.toUpperCase();
    if (legacyMatchMode === 'prefix') {
      rules.push({
        raw: rawEntry,
        type: 'prefix',
        matches: (callsign) => callsign.startsWith(normalizedEntry),
      });
      continue;
    }

    const exactRegex = new RegExp(`^${escapeRegex(rawEntry)}$`, 'i');
    rules.push({
      raw: rawEntry,
      type: 'exact',
      matches: (callsign) => exactRegex.test(callsign),
    });
  }

  return rules;
}

function findMatchedTarget(
  messages: ParsedFT8Message[],
  ctx: PluginContext,
): { callsign: string; message: ParsedFT8Message; rule: WatchRule } | null {
  const watchRules = buildWatchRules(ctx);
  if (watchRules.length === 0) {
    return null;
  }

  const triggerMode = getTriggerMode(ctx);
  const matches: Array<{
    callsign: string;
    message: ParsedFT8Message;
    rule: WatchRule;
    ruleOrder: number;
    messageOrder: number;
  }> = [];

  for (const [ruleOrder, watchRule] of watchRules.entries()) {
    for (const [messageOrder, parsedMessage] of messages.entries()) {
      const senderCallsign = getSenderCallsign(parsedMessage.message);
      if (!senderCallsign || !watchRule.matches(senderCallsign)) {
        continue;
      }
      if (!shouldTriggerMessage(parsedMessage, ctx, triggerMode)) {
        continue;
      }
      matches.push({
        callsign: senderCallsign,
        message: parsedMessage,
        rule: watchRule,
        ruleOrder,
        messageOrder,
      });
    }
  }

  matches.sort((left, right) =>
    compareByScoreThenSnr(left.message, right.message)
      || left.ruleOrder - right.ruleOrder
      || left.messageOrder - right.messageOrder
  );

  return matches[0] ?? null;
}

export const watchedCallsignAutocallPlugin: PluginDefinition = {
  name: 'watched-callsign-autocall',
  version: '1.0.0',
  type: 'utility',
  description: 'Automatically start calling watched callsigns when they appear while the operator is idle',

  settings: {
    watchOverview: {
      type: 'info',
      default: '',
      label: 'watchOverview',
      description: 'watchOverviewDesc',
      scope: 'operator',
    },
    watchList: {
      type: 'string[]',
      default: [],
      label: 'watchList',
      description: 'watchListDesc',
      scope: 'operator',
    },
    triggerMode: {
      type: 'string',
      default: 'cq',
      label: 'triggerMode',
      description: 'triggerModeDesc',
      scope: 'operator',
      options: [
        { label: 'triggerCqOnly', value: 'cq' },
        { label: 'triggerCqOrSignoff', value: 'cq-or-signoff' },
        { label: 'triggerAny', value: 'any' },
      ],
    },
    autocallPriority: {
      type: 'number',
      default: 100,
      label: 'autocallPriority',
      description: 'autocallPriorityDesc',
      scope: 'operator',
      min: 0,
      max: 1000,
    },
    workedCallsignSkipDays: {
      type: 'number',
      default: 365,
      label: 'workedCallsignSkipDays',
      description: 'workedCallsignSkipDaysDesc',
      scope: 'operator',
      min: 0,
      max: 3650,
    },
    removeExactMatchAfterQSO: {
      type: 'boolean',
      default: false,
      label: 'removeExactMatchAfterQSO',
      description: 'removeExactMatchAfterQSODesc',
      scope: 'operator',
    },
  },

  quickSettings: [
    { settingKey: 'triggerMode' },
    { settingKey: 'watchList' },
  ],

  hooks: {
    onQSOComplete(record: QSORecord, ctx: PluginContext): void {
      if (!ctx.config.removeExactMatchAfterQSO) return;

      const completedCallsign = record.callsign?.trim().toUpperCase();
      if (!completedCallsign) return;

      const rawWatchList = Array.isArray(ctx.config.watchList)
        ? [...(ctx.config.watchList as string[])]
        : [];

      const matchIndex = rawWatchList.findIndex((entry) => {
        if (typeof entry !== 'string') return false;
        const trimmed = entry.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        if (REGEX_META_CHARS.test(trimmed)) return false;
        return trimmed.toUpperCase() === completedCallsign;
      });

      if (matchIndex === -1) return;

      const removedEntry = rawWatchList[matchIndex];
      rawWatchList.splice(matchIndex, 1);

      ctx.updateConfig({ watchList: rawWatchList }).catch((err) => {
        ctx.log.error('Failed to remove completed callsign from watch list', err);
      });

      ctx.log.info('Removed exact-match callsign from watch list after QSO completion', {
        callsign: completedCallsign,
        removedEntry,
      });
    },

    async onAutoCallCandidate(slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContext): Promise<AutoCallProposal | null> {
      if (!isPureStandby(ctx)) {
        return null;
      }

      const matched = findMatchedTarget(messages, ctx);
      if (!matched) {
        return null;
      }

      if (ctx.operator.isTargetBeingWorkedByOthers(matched.callsign)) {
        ctx.log.debug('Watched callsign skipped because another operator is already working it', {
          callsign: matched.callsign,
        });
        return null;
      }

      const skipDays = Number(ctx.config.workedCallsignSkipDays) || 0;
      if (skipDays > 0) {
        const cutoff = Date.now() - skipDays * 24 * 60 * 60 * 1000;
        const count = await ctx.logbook.countQSOs({
          callsign: matched.callsign,
          timeRange: { start: cutoff, end: Date.now() },
        });
        if (count > 0) {
          ctx.log.debug('Watched callsign skipped because already worked within time range', {
            callsign: matched.callsign,
            skipDays,
            foundQSOs: count,
          });
          return null;
        }
      }

      const lastMessage: LastMessageInfo = {
        message: toFrameMessage(matched.message),
        slotInfo,
      };

      ctx.log.debug('Watched callsign proposed for automatic call', {
        callsign: matched.callsign,
        matchedBy: matched.rule.type,
        watchEntry: matched.rule.raw,
        triggerMode: getTriggerMode(ctx),
        priority: getAutocallPriority(ctx),
      });

      return {
        callsign: matched.callsign,
        priority: getAutocallPriority(ctx),
        lastMessage,
      };
    },
  },
};

export const watchedCallsignAutocallLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
