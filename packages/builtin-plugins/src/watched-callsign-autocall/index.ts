import {
  type AutoCallProposal,
  type LastMessageInfo,
  type ParsedFT8Message,
  type PluginContext,
  type PluginDefinition,
  type SlotInfo,
} from '@tx5dr/plugin-api';
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
  },

  quickSettings: [
    { settingKey: 'triggerMode' },
    { settingKey: 'watchList' },
  ],

  hooks: {
    onAutoCallCandidate(slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContext): AutoCallProposal | null {
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
