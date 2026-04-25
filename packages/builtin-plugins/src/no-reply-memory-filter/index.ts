import { FT8MessageType } from '@tx5dr/contracts';
import type { ParsedFT8Message, QSORecord } from '@tx5dr/contracts';
import type { PluginDefinition, PluginContext, QSOFailureInfo } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

export const BUILTIN_NO_REPLY_MEMORY_FILTER_PLUGIN_NAME = 'no-reply-memory-filter';

const STORE_KEY_PREFIX = 'callsign:';
const FULL_SCORE = 100;
const DEFAULT_RECOVERY_PER_MINUTE = 2;
const DEFAULT_BLOCK_THRESHOLD = 50;
const DEFAULT_FULL_FAILURE_PENALTY = 40;
const DEFAULT_SWITCHED_TARGET_PENALTY = 20;

interface MemoryEntry {
  score: number;
  updatedAt: number;
}

export function normalizeMemoryCallsign(callsign: string): string {
  return callsign.trim().toUpperCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function calculateRecoveredScore(
  entry: MemoryEntry | undefined,
  now: number,
  recoveryPerMinute = DEFAULT_RECOVERY_PER_MINUTE,
): number {
  if (!entry || !Number.isFinite(entry.score) || !Number.isFinite(entry.updatedAt)) {
    return FULL_SCORE;
  }

  const elapsedMinutes = Math.max(0, now - entry.updatedAt) / 60_000;
  return Math.min(FULL_SCORE, entry.score + elapsedMinutes * recoveryPerMinute);
}

export function calculateNoReplyPenalty(failure: Pick<QSOFailureInfo, 'reason' | 'unansweredTransmissions'>): number {
  if (failure.reason === 'tx1_switched_to_direct_call'
      || failure.reason === 'tx1_switched_to_direct_signal_report') {
    return DEFAULT_SWITCHED_TARGET_PENALTY;
  }

  return DEFAULT_FULL_FAILURE_PENALTY;
}

export function calculateScoreAfterFailure(
  entry: MemoryEntry | undefined,
  failure: Pick<QSOFailureInfo, 'reason' | 'unansweredTransmissions'>,
  now: number,
): number {
  const recoveredScore = calculateRecoveredScore(entry, now);
  return Math.max(0, recoveredScore - calculateNoReplyPenalty(failure));
}

function getSenderCallsign(message: unknown): string {
  if (typeof message === 'object' && message !== null && 'senderCallsign' in message) {
    const callsign = (message as { senderCallsign?: unknown }).senderCallsign;
    return typeof callsign === 'string' ? normalizeMemoryCallsign(callsign) : '';
  }
  return '';
}

function getTargetCallsign(message: unknown): string {
  if (typeof message === 'object' && message !== null && 'targetCallsign' in message) {
    const callsign = (message as { targetCallsign?: unknown }).targetCallsign;
    return typeof callsign === 'string' ? normalizeMemoryCallsign(callsign) : '';
  }
  return '';
}

function getStoreKey(callsign: string): string {
  return `${STORE_KEY_PREFIX}${normalizeMemoryCallsign(callsign)}`;
}

function readEntry(ctx: PluginContext, callsign: string): MemoryEntry | undefined {
  const stored = ctx.store.global.get<MemoryEntry | undefined>(getStoreKey(callsign));
  if (
    !stored
    || typeof stored !== 'object'
    || !Number.isFinite(stored.score)
    || !Number.isFinite(stored.updatedAt)
  ) {
    return undefined;
  }
  return stored;
}

function writeEntry(ctx: PluginContext, callsign: string, score: number, now: number): void {
  if (score >= FULL_SCORE) {
    ctx.store.global.delete(getStoreKey(callsign));
    return;
  }
  ctx.store.global.set(getStoreKey(callsign), {
    score: clamp(score, 0, FULL_SCORE),
    updatedAt: now,
  } satisfies MemoryEntry);
}

function shouldPreserveDirectedMessage(candidate: ParsedFT8Message, ctx: PluginContext): boolean {
  const target = getTargetCallsign(candidate.message);
  return target.length > 0 && target === normalizeMemoryCallsign(ctx.operator.callsign);
}

function isAutomaticChaseCandidate(candidate: ParsedFT8Message): boolean {
  switch (candidate.message.type) {
    case FT8MessageType.CQ:
    case FT8MessageType.SEVENTY_THREE:
    case FT8MessageType.RRR:
      return true;
    default:
      return false;
  }
}

function getEffectiveScore(ctx: PluginContext, callsign: string, now: number): number {
  const entry = readEntry(ctx, callsign);
  const score = calculateRecoveredScore(entry, now);
  if (entry && score >= FULL_SCORE) {
    ctx.store.global.delete(getStoreKey(callsign));
  }
  return score;
}

export const noReplyMemoryFilterPlugin: PluginDefinition = {
  name: BUILTIN_NO_REPLY_MEMORY_FILTER_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  description: 'Temporarily suppress automatic calls to stations that recently ignored repeated calls',

  settings: {
    memoryOverview: {
      type: 'info',
      default: '',
      label: 'memoryOverview',
      description: 'memoryOverviewDesc',
      scope: 'global',
    },
  },

  hooks: {
    onFilterCandidates(candidates, ctx) {
      const now = Date.now();
      const filtered = candidates.filter((candidate) => {
        if (shouldPreserveDirectedMessage(candidate, ctx)) {
          return true;
        }
        if (!isAutomaticChaseCandidate(candidate)) {
          return true;
        }

        const callsign = getSenderCallsign(candidate.message);
        if (!callsign) {
          return true;
        }

        const score = getEffectiveScore(ctx, callsign, now);
        return score >= DEFAULT_BLOCK_THRESHOLD;
      });

      if (filtered.length < candidates.length) {
        ctx.log.debug('No-reply memory filter applied', {
          before: candidates.length,
          after: filtered.length,
          blockThreshold: DEFAULT_BLOCK_THRESHOLD,
        });
      }

      return filtered;
    },

    onQSOFail(info, ctx) {
      const callsign = normalizeMemoryCallsign(info.targetCallsign);
      if (
        !callsign
        || info.stage !== 'TX1'
        || info.hadTargetReply === true
      ) {
        return;
      }

      const now = Date.now();
      const current = readEntry(ctx, callsign);
      const nextScore = calculateScoreAfterFailure(current, info, now);
      writeEntry(ctx, callsign, nextScore, now);

      ctx.log.debug('No-reply memory score penalized', {
        callsign,
        reason: info.reason,
        unansweredTransmissions: info.unansweredTransmissions ?? null,
        score: nextScore,
      });
    },

    onQSOComplete(record: QSORecord, ctx) {
      const callsign = normalizeMemoryCallsign(record.callsign);
      if (!callsign) {
        return;
      }
      ctx.store.global.delete(getStoreKey(callsign));
      ctx.log.debug('No-reply memory score cleared after QSO completion', { callsign });
    },
  },
};

export const noReplyMemoryFilterLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
