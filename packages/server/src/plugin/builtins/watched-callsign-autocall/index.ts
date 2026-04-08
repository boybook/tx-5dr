import {
  FT8MessageType,
  type FrameMessage,
  type ParsedFT8Message,
  type PluginContext,
  type PluginDefinition,
  type SlotInfo,
} from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

type LegacyMatchMode = 'exact' | 'prefix';
type TriggerMode = 'cq' | 'cq-or-signoff' | 'any';
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

function getTriggerMode(ctx: PluginContext): TriggerMode {
  const value = ctx.config.triggerMode;
  if (value === 'any' || value === 'cq-or-signoff') {
    return value;
  }
  return 'cq';
}

function getSenderCallsign(message: ParsedFT8Message['message']): string {
  if ('senderCallsign' in message && typeof message.senderCallsign === 'string') {
    return message.senderCallsign.toUpperCase();
  }
  return '';
}

function getTargetCallsign(message: ParsedFT8Message['message']): string {
  if ('targetCallsign' in message && typeof message.targetCallsign === 'string') {
    return message.targetCallsign.toUpperCase();
  }
  return '';
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

function isPureStandby(ctx: PluginContext): boolean {
  if (ctx.operator.isTransmitting) {
    return false;
  }

  const automation = ctx.operator.automation;
  if (!automation) {
    return true;
  }

  const targetCallsign = typeof automation.context?.targetCallsign === 'string'
    ? automation.context.targetCallsign.trim()
    : '';
  return automation.currentState === 'TX6' && targetCallsign.length === 0;
}

function shouldTriggerMessage(
  parsedMessage: ParsedFT8Message,
  ctx: PluginContext,
  triggerMode: TriggerMode,
): boolean {
  const message = parsedMessage.message;
  const myCallsign = ctx.operator.callsign.toUpperCase();
  if (getTargetCallsign(message) === myCallsign) {
    return true;
  }

  if (message.type === FT8MessageType.CQ) {
    return true;
  }

  if (triggerMode === 'any') {
    return true;
  }

  if (triggerMode === 'cq-or-signoff') {
    return message.type === FT8MessageType.RRR || message.type === FT8MessageType.SEVENTY_THREE;
  }

  return false;
}

function toFrameMessage(parsedMessage: ParsedFT8Message): FrameMessage {
  return {
    snr: parsedMessage.snr,
    freq: parsedMessage.df,
    dt: parsedMessage.dt,
    message: parsedMessage.rawMessage,
    confidence: 1,
    logbookAnalysis: parsedMessage.logbookAnalysis,
  };
}

function toMessageSlotInfo(parsedMessage: ParsedFT8Message, ctx: PluginContext): SlotInfo {
  const slotMs = ctx.operator.mode.slotMs;
  const startMs = parsedMessage.timestamp;
  return {
    id: parsedMessage.slotId,
    startMs,
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: slotMs > 0 ? Math.floor(startMs / slotMs) % 2 : 0,
    utcSeconds: Math.floor(startMs / 1000),
    mode: ctx.operator.mode.name,
  };
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

  for (const watchRule of watchRules) {
    for (const parsedMessage of messages) {
      const senderCallsign = getSenderCallsign(parsedMessage.message);
      if (!senderCallsign || !watchRule.matches(senderCallsign)) {
        continue;
      }
      if (!shouldTriggerMessage(parsedMessage, ctx, triggerMode)) {
        continue;
      }
      return { callsign: senderCallsign, message: parsedMessage, rule: watchRule };
    }
  }

  return null;
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
  },

  quickSettings: [
    { settingKey: 'triggerMode' },
    { settingKey: 'watchList' },
  ],

  hooks: {
    onSlotStart(_slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContext) {
      if (!isPureStandby(ctx)) {
        return;
      }

      const matched = findMatchedTarget(messages, ctx);
      if (!matched) {
        return;
      }

      if (ctx.operator.isTargetBeingWorkedByOthers(matched.callsign)) {
        ctx.log.debug('Watched callsign skipped because another operator is already working it', {
          callsign: matched.callsign,
        });
        return;
      }

      ctx.log.info('Watched callsign matched, starting automatic call', {
        callsign: matched.callsign,
        matchedBy: matched.rule.type,
        watchEntry: matched.rule.raw,
        triggerMode: getTriggerMode(ctx),
      });

      ctx.operator.call(matched.callsign, {
        message: toFrameMessage(matched.message),
        slotInfo: toMessageSlotInfo(matched.message, ctx),
      });
    },
  },
};

export const watchedCallsignAutocallLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
