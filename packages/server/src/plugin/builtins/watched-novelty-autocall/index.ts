import {
  FT8MessageType,
  type AutoCallProposal,
  type LastMessageInfo,
  type FrameMessage,
  type ParsedFT8Message,
  type PluginContext,
  type PluginDefinition,
  type SlotInfo,
} from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

type TriggerMode = 'cq' | 'cq-or-signoff' | 'any';

function getTriggerMode(ctx: PluginContext): TriggerMode {
  const value = ctx.config.triggerMode;
  if (value === 'any' || value === 'cq-or-signoff') {
    return value;
  }
  return 'cq';
}

function getAutocallPriority(ctx: PluginContext): number {
  return typeof ctx.config.autocallPriority === 'number'
    ? ctx.config.autocallPriority
    : 80;
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

function getMatchedNoveltyKinds(parsedMessage: ParsedFT8Message, ctx: PluginContext): string[] {
  const analysis = parsedMessage.logbookAnalysis;
  if (!analysis) {
    return [];
  }

  const matchedKinds: string[] = [];
  if (ctx.config.watchNewDxcc === true && analysis.isNewDxccEntity && analysis.dxccStatus !== 'deleted') {
    matchedKinds.push('newDxcc');
  }
  if (ctx.config.watchNewGrid === true && analysis.isNewGrid) {
    matchedKinds.push('newGrid');
  }
  if (ctx.config.watchNewCallsign === true && analysis.isNewCallsign) {
    matchedKinds.push('newCallsign');
  }
  return matchedKinds;
}

function findMatchedTarget(
  messages: ParsedFT8Message[],
  ctx: PluginContext,
): { callsign: string; message: ParsedFT8Message; matchedKinds: string[] } | null {
  if (ctx.config.watchNewDxcc !== true && ctx.config.watchNewGrid !== true && ctx.config.watchNewCallsign !== true) {
    return null;
  }

  const triggerMode = getTriggerMode(ctx);
  for (const parsedMessage of messages) {
    const callsign = getSenderCallsign(parsedMessage.message);
    if (!callsign || !shouldTriggerMessage(parsedMessage, ctx, triggerMode)) {
      continue;
    }

    const matchedKinds = getMatchedNoveltyKinds(parsedMessage, ctx);
    if (matchedKinds.length > 0) {
      return {
        callsign,
        message: parsedMessage,
        matchedKinds,
      };
    }
  }

  return null;
}

export const watchedNoveltyAutocallPlugin: PluginDefinition = {
  name: 'watched-novelty-autocall',
  version: '1.0.0',
  type: 'utility',
  description: 'Automatically call newly needed DXCC, grids, or callsigns while the operator is idle',

  settings: {
    noveltyOverview: {
      type: 'info',
      default: '',
      label: 'noveltyOverview',
      description: 'noveltyOverviewDesc',
      scope: 'operator',
    },
    watchNewDxcc: {
      type: 'boolean',
      default: false,
      label: 'watchNewDxcc',
      description: 'watchNewDxccDesc',
      scope: 'operator',
    },
    watchNewGrid: {
      type: 'boolean',
      default: false,
      label: 'watchNewGrid',
      description: 'watchNewGridDesc',
      scope: 'operator',
    },
    watchNewCallsign: {
      type: 'boolean',
      default: false,
      label: 'watchNewCallsign',
      description: 'watchNewCallsignDesc',
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
      default: 80,
      label: 'autocallPriority',
      description: 'autocallPriorityDesc',
      scope: 'operator',
      min: 0,
      max: 1000,
    },
  },

  quickSettings: [
    { settingKey: 'watchNewDxcc' },
    { settingKey: 'watchNewGrid' },
    { settingKey: 'watchNewCallsign' },
    { settingKey: 'triggerMode' },
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
        ctx.log.debug('Novelty autocall skipped because another operator is already working it', {
          callsign: matched.callsign,
        });
        return null;
      }

      const lastMessage: LastMessageInfo = {
        message: toFrameMessage(matched.message),
        slotInfo,
      };

      ctx.log.debug('Novelty autocall proposed target', {
        callsign: matched.callsign,
        matchedKinds: matched.matchedKinds,
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

export const watchedNoveltyAutocallLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
