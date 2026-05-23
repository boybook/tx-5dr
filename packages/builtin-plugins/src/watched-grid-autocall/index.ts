import type {
  AutoCallProposal,
  LastMessageInfo,
  ParsedFT8Message,
  PluginContext,
  PluginDefinition,
  SlotInfo,
} from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import { getFourCharacterGrid } from '@tx5dr/contracts';
import {
  compileTextMatchRules,
  matchTextValue,
  normalizeTextMatchMode,
  type TextMatchMode,
  type TextMatchRule,
} from '@tx5dr/core';
import {
  compareByScoreThenSnr,
  getAutocallPriority as getAutocallPriorityBase,
  getSenderCallsign,
  getTriggerMode,
  isPureStandby,
  shouldTriggerMessage,
  toFrameMessage,
} from '../_shared/autocall-utils.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

function normalizeGridForMatch(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '');
  return getFourCharacterGrid(normalized) ?? normalized;
}

function getMessageGrid(message: ParsedFT8Message['message']): string {
  if ('grid' in message && typeof message.grid === 'string') {
    return normalizeGridForMatch(message.grid);
  }
  return '';
}

function looksLikeRegexRule(entry: string): boolean {
  return /[\\^$.*+?()[\]{}|]/.test(entry);
}

function getGridMatchMode(ctx: PluginContext): TextMatchMode {
  return normalizeTextMatchMode(ctx.config.gridMatchMode);
}

function getAutocallPriority(ctx: PluginContext): number {
  return getAutocallPriorityBase(ctx, 90);
}

function hasActiveGridWatchEntries(value: unknown): boolean {
  return Array.isArray(value)
    && value.some((entry) => typeof entry === 'string' && entry.trim() !== '' && !entry.trim().startsWith('#'));
}

function isWatchedGridAutoCallEnabled(ctx: PluginContext): boolean {
  return hasActiveGridWatchEntries(ctx.config.gridWatchList);
}

function buildGridRules(ctx: PluginContext): TextMatchRule[] {
  const matchMode = getGridMatchMode(ctx);
  const onInvalidRegex = (entry: string, error: unknown) => {
    ctx.log.warn('Watched grid regex is invalid and will be ignored', { entry, error });
  };

  const options = { normalize: normalizeGridForMatch, onInvalidRegex };
  return compileTextMatchRules(ctx.config.gridWatchList, matchMode, options);
}

function findMatchedTarget(
  messages: ParsedFT8Message[],
  ctx: PluginContext,
): { callsign: string; grid: string; message: ParsedFT8Message; rule: TextMatchRule } | null {
  const rules = buildGridRules(ctx);
  if (rules.length === 0) return null;

  const triggerMode = getTriggerMode(ctx);
  const matches: Array<{
    callsign: string;
    grid: string;
    message: ParsedFT8Message;
    rule: TextMatchRule;
    ruleOrder: number;
    messageOrder: number;
  }> = [];

  for (const [ruleOrder, rule] of rules.entries()) {
    for (const [messageOrder, parsedMessage] of messages.entries()) {
      const callsign = getSenderCallsign(parsedMessage.message);
      const grid = getMessageGrid(parsedMessage.message);
      if (!callsign || !grid || !matchTextValue(grid, [rule])) continue;
      if (!shouldTriggerMessage(parsedMessage, ctx, triggerMode)) continue;
      matches.push({ callsign, grid, message: parsedMessage, rule, ruleOrder, messageOrder });
    }
  }

  matches.sort((left, right) =>
    compareByScoreThenSnr(left.message, right.message)
      || left.ruleOrder - right.ruleOrder
      || left.messageOrder - right.messageOrder
  );

  return matches[0] ?? null;
}

export const watchedGridAutocallPlugin: PluginDefinition = {
  name: 'watched-grid-autocall',
  version: '1.0.0',
  type: 'utility',
  description: 'Automatically call stations from watched Maidenhead grids while the operator is idle',
  permissions: ['operator:transmit-control'],

  settings: {
    gridWatchOverview: {
      type: 'info',
      default: '',
      label: 'gridWatchOverview',
      description: 'gridWatchOverviewDesc',
      scope: 'operator',
    },
    gridWatchList: {
      type: 'string[]',
      default: [],
      label: 'gridWatchList',
      description: 'gridWatchListDesc',
      scope: 'operator',
    },
    gridMatchMode: {
      type: 'string',
      default: 'exact',
      label: 'gridMatchMode',
      description: 'gridMatchModeDesc',
      scope: 'operator',
      options: [
        { label: 'matchModeExact', value: 'exact' },
        { label: 'matchModePrefix', value: 'prefix' },
        { label: 'matchModeFuzzy', value: 'fuzzy' },
        { label: 'matchModeRegex', value: 'regex' },
      ],
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
      default: 90,
      label: 'autocallPriority',
      description: 'autocallPriorityDesc',
      scope: 'operator',
      min: 0,
      max: 1000,
    },
    workedGridSkipEnabled: {
      type: 'boolean',
      default: true,
      label: 'workedGridSkipEnabled',
      description: 'workedGridSkipEnabledDesc',
      scope: 'operator',
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
    { settingKey: 'gridMatchMode' },
    { settingKey: 'gridWatchList' },
  ],

  isAutoCallEnabled: isWatchedGridAutoCallEnabled,

  hooks: {
    onQSOComplete(record: QSORecord, ctx: PluginContext): void {
      if (!ctx.config.removeExactMatchAfterQSO || !record.grid) return;
      const completedGrid = normalizeGridForMatch(record.grid);
      const rawList = Array.isArray(ctx.config.gridWatchList) ? [...(ctx.config.gridWatchList as string[])] : [];
      const matchIndex = rawList.findIndex((entry) => {
        if (typeof entry !== 'string') return false;
        const trimmed = entry.trim();
        return Boolean(trimmed) && !trimmed.startsWith('#') && !looksLikeRegexRule(trimmed)
          && normalizeGridForMatch(trimmed) === completedGrid;
      });
      if (matchIndex === -1) return;
      const removedEntry = rawList[matchIndex];
      rawList.splice(matchIndex, 1);
      ctx.updateConfig({ gridWatchList: rawList }).catch((err) => {
        ctx.log.error('Failed to remove completed grid from watch list', err);
      });
      ctx.log.info('Removed exact-match grid from watch list after QSO completion', { grid: completedGrid, removedEntry });
    },

    async onAutoCallCandidate(slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContext): Promise<AutoCallProposal | null> {
      if (!isPureStandby(ctx)) return null;
      const matched = findMatchedTarget(messages, ctx);
      if (!matched) return null;

      if (ctx.operator.isTargetBeingWorkedByOthers(matched.callsign)) {
        ctx.log.debug('Watched grid skipped because another operator is already working the station', {
          callsign: matched.callsign,
          grid: matched.grid,
        });
        return null;
      }

      if (ctx.config.workedGridSkipEnabled !== false && await ctx.logbook.hasWorkedGrid(matched.grid)) {
        ctx.log.debug('Watched grid skipped because grid was already worked', {
          callsign: matched.callsign,
          grid: matched.grid,
        });
        return null;
      }

      const lastMessage: LastMessageInfo = {
        message: toFrameMessage(matched.message),
        slotInfo,
      };

      ctx.log.debug('Watched grid proposed for automatic call', {
        callsign: matched.callsign,
        grid: matched.grid,
        matchedBy: matched.rule.mode,
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

export const watchedGridAutocallLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};

export const watchedGridAutocallTestables = {
  isWatchedGridAutoCallEnabled,
};
