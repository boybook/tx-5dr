import { fileURLToPath } from 'url';
import path from 'path';
import { FT8MessageType } from '@tx5dr/contracts';
import type { ParsedFT8Message, QSORecord } from '@tx5dr/contracts';
import type { PluginDefinition, PluginContext, QSOFailureInfo } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

export const BUILTIN_NO_REPLY_MEMORY_FILTER_PLUGIN_NAME = 'no-reply-memory-filter';
export const noReplyMemoryFilterDirPath = path.dirname(fileURLToPath(import.meta.url));

const STORE_KEY_PREFIX = 'callsign:';
const FULL_SCORE = 100;
const RECOVERY_CYCLE_MS = 15_000;
const DEFAULT_RECOVERY_PER_CYCLE = 0.5;
const DEFAULT_BLOCK_THRESHOLD = 50;
const DEFAULT_FULL_FAILURE_PENALTY = 40;

interface MemoryEntry {
  score: number;
  updatedAt: number;
}

export interface NoReplyMemoryItem {
  callsign: string;
  score: number;
  storedScore: number;
  updatedAt: number;
  blocked: boolean;
  minutesUntilCallable: number;
  minutesUntilFull: number;
}

export interface NoReplyMemoryListResponse {
  entries: NoReplyMemoryItem[];
  blockThreshold: number;
  recoveryPerCycle: number;
  fullScore: number;
}

interface NoReplyMemorySettings {
  blockThreshold: number;
  failurePenalty: number;
  recoveryPerCycle: number;
}

export function normalizeMemoryCallsign(callsign: string): string {
  return callsign.trim().toUpperCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundMinutes(value: number): number {
  return Math.max(0, Math.ceil(value * 10) / 10);
}

function isValidMemoryCallsign(callsign: string): boolean {
  return /^[A-Z0-9/]{1,24}$/.test(callsign);
}

function requireMemoryCallsign(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid callsign');
  }
  const callsign = normalizeMemoryCallsign(value);
  if (!callsign || !isValidMemoryCallsign(callsign)) {
    throw new Error('Invalid callsign');
  }
  return callsign;
}

function parseMemoryEntry(value: unknown): MemoryEntry | undefined {
  if (
    !value
    || typeof value !== 'object'
    || !Number.isFinite((value as { score?: unknown }).score)
    || !Number.isFinite((value as { updatedAt?: unknown }).updatedAt)
  ) {
    return undefined;
  }

  const score = Number((value as { score: number }).score);
  const updatedAt = Number((value as { updatedAt: number }).updatedAt);
  if (score < 0 || score > FULL_SCORE || updatedAt <= 0) {
    return undefined;
  }

  return {
    score,
    updatedAt,
  };
}

function requireScore(value: unknown): number {
  const score = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(score) || score < 0 || score > FULL_SCORE) {
    throw new Error('Score must be between 0 and 100');
  }
  return score;
}

function readNumberSetting(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return clamp(numberValue, min, max);
}

function readSettings(ctx: PluginContext): NoReplyMemorySettings {
  const legacyRecoveryPerMinute = readNumberSetting(ctx.config.recoveryPerMinute, DEFAULT_RECOVERY_PER_CYCLE * 4, 0, 80);
  return {
    blockThreshold: readNumberSetting(ctx.config.blockThreshold, DEFAULT_BLOCK_THRESHOLD, 0, FULL_SCORE),
    failurePenalty: readNumberSetting(ctx.config.failurePenalty, DEFAULT_FULL_FAILURE_PENALTY, 0, FULL_SCORE),
    recoveryPerCycle: readNumberSetting(ctx.config.recoveryPerCycle, legacyRecoveryPerMinute / 4, 0, 20),
  };
}

export function calculateRecoveredScore(
  entry: MemoryEntry | undefined,
  now: number,
  recoveryPerCycle = DEFAULT_RECOVERY_PER_CYCLE,
): number {
  if (!entry || !Number.isFinite(entry.score) || !Number.isFinite(entry.updatedAt)) {
    return FULL_SCORE;
  }

  const elapsedCycles = Math.max(0, now - entry.updatedAt) / RECOVERY_CYCLE_MS;
  return Math.min(FULL_SCORE, entry.score + elapsedCycles * recoveryPerCycle);
}

export function calculateNoReplyPenalty(
  failure: Pick<QSOFailureInfo, 'reason' | 'unansweredTransmissions'>,
  fullFailurePenalty = DEFAULT_FULL_FAILURE_PENALTY,
): number {
  if (failure.reason === 'tx1_switched_to_direct_call'
      || failure.reason === 'tx1_switched_to_direct_signal_report') {
    return Math.round(clamp(fullFailurePenalty, 0, FULL_SCORE) / 2);
  }

  return clamp(fullFailurePenalty, 0, FULL_SCORE);
}

export function calculateScoreAfterFailure(
  entry: MemoryEntry | undefined,
  failure: Pick<QSOFailureInfo, 'reason' | 'unansweredTransmissions'>,
  now: number,
  settings: { failurePenalty?: number; recoveryPerCycle?: number; recoveryPerMinute?: number } = {},
): number {
  const recoveryPerCycle = settings.recoveryPerCycle
    ?? (settings.recoveryPerMinute !== undefined ? settings.recoveryPerMinute / 4 : DEFAULT_RECOVERY_PER_CYCLE);
  const recoveredScore = calculateRecoveredScore(entry, now, recoveryPerCycle);
  return Math.max(0, recoveredScore - calculateNoReplyPenalty(
    failure,
    settings.failurePenalty ?? DEFAULT_FULL_FAILURE_PENALTY,
  ));
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

function getMemoryStore(ctx: PluginContext) {
  return ctx.store.operator;
}

function readEntry(ctx: PluginContext, callsign: string): MemoryEntry | undefined {
  const stored = getMemoryStore(ctx).get<MemoryEntry | undefined>(getStoreKey(callsign));
  return parseMemoryEntry(stored);
}

function writeEntry(ctx: PluginContext, callsign: string, score: number, now: number): void {
  const store = getMemoryStore(ctx);
  if (score >= FULL_SCORE) {
    store.delete(getStoreKey(callsign));
    return;
  }
  store.set(getStoreKey(callsign), {
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
  const settings = readSettings(ctx);
  const entry = readEntry(ctx, callsign);
  const score = calculateRecoveredScore(entry, now, settings.recoveryPerCycle);
  if (entry && score >= FULL_SCORE) {
    getMemoryStore(ctx).delete(getStoreKey(callsign));
  }
  return score;
}

export function listNoReplyMemoryEntries(
  ctx: PluginContext,
  now = Date.now(),
): NoReplyMemoryListResponse {
  const entries: NoReplyMemoryItem[] = [];
  const store = getMemoryStore(ctx);
  const settings = readSettings(ctx);

  for (const [key, value] of Object.entries(store.getAll())) {
    if (!key.startsWith(STORE_KEY_PREFIX)) {
      continue;
    }

    const callsign = normalizeMemoryCallsign(key.slice(STORE_KEY_PREFIX.length));
    const entry = parseMemoryEntry(value);
    if (!callsign || !isValidMemoryCallsign(callsign) || !entry) {
      store.delete(key);
      continue;
    }

    const score = calculateRecoveredScore(entry, now, settings.recoveryPerCycle);
    if (score >= FULL_SCORE) {
      store.delete(key);
      continue;
    }

    entries.push({
      callsign,
      score: roundScore(score),
      storedScore: roundScore(entry.score),
      updatedAt: entry.updatedAt,
      blocked: score < settings.blockThreshold,
      minutesUntilCallable: score < settings.blockThreshold && settings.recoveryPerCycle > 0
        ? roundMinutes(((settings.blockThreshold - score) / settings.recoveryPerCycle) * RECOVERY_CYCLE_MS / 60_000)
        : 0,
      minutesUntilFull: settings.recoveryPerCycle > 0
        ? roundMinutes(((FULL_SCORE - score) / settings.recoveryPerCycle) * RECOVERY_CYCLE_MS / 60_000)
        : 0,
    });
  }

  entries.sort((left, right) => {
    if (left.blocked !== right.blocked) {
      return left.blocked ? -1 : 1;
    }
    const scoreDiff = left.score - right.score;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return left.callsign.localeCompare(right.callsign);
  });

  return {
    entries,
    blockThreshold: settings.blockThreshold,
    recoveryPerCycle: settings.recoveryPerCycle,
    fullScore: FULL_SCORE,
  };
}

export function setNoReplyMemoryScore(
  ctx: PluginContext,
  callsignInput: unknown,
  scoreInput: unknown,
  now = Date.now(),
): NoReplyMemoryItem | null {
  const callsign = requireMemoryCallsign(callsignInput);
  const current = readEntry(ctx, callsign);
  if (!current) {
    throw new Error(`Unknown callsign: ${callsign}`);
  }

  const score = requireScore(scoreInput);
  writeEntry(ctx, callsign, score, now);

  if (score >= FULL_SCORE) {
    return null;
  }

  return listNoReplyMemoryEntries(ctx, now).entries.find((entry) => entry.callsign === callsign) ?? null;
}

export function clearNoReplyMemoryEntry(ctx: PluginContext, callsignInput: unknown): { success: true } {
  const callsign = requireMemoryCallsign(callsignInput);
  const current = readEntry(ctx, callsign);
  if (!current) {
    throw new Error(`Unknown callsign: ${callsign}`);
  }
  getMemoryStore(ctx).delete(getStoreKey(callsign));
  return { success: true };
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
      scope: 'operator',
    },
    blockThreshold: {
      type: 'number',
      default: DEFAULT_BLOCK_THRESHOLD,
      label: 'blockThreshold',
      description: 'blockThresholdDesc',
      scope: 'operator',
      min: 0,
      max: FULL_SCORE,
    },
    failurePenalty: {
      type: 'number',
      default: DEFAULT_FULL_FAILURE_PENALTY,
      label: 'failurePenalty',
      description: 'failurePenaltyDesc',
      scope: 'operator',
      min: 0,
      max: FULL_SCORE,
    },
    recoveryPerCycle: {
      type: 'number',
      default: DEFAULT_RECOVERY_PER_CYCLE,
      label: 'recoveryPerCycle',
      description: 'recoveryPerCycleDesc',
      scope: 'operator',
      min: 0,
      max: 20,
    },
  },

  panels: [
    {
      id: 'memory-manager',
      title: 'memoryManagerTitle',
      component: 'iframe',
      pageId: 'memory-manager',
      slot: 'automation',
      width: 'full',
    },
  ],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'memory-manager',
        title: 'memoryManagerTitle',
        entry: 'memory-manager.html',
        accessScope: 'operator',
        resourceBinding: 'none',
      },
    ],
  },

  onLoad(ctx) {
    ctx.ui.registerPageHandler({
      async onMessage(pageId, action, data) {
        if (pageId !== 'memory-manager') {
          throw new Error(`Unknown page: ${pageId}`);
        }

        const payload = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
        switch (action) {
          case 'listMemory':
            return listNoReplyMemoryEntries(ctx);
          case 'setScore':
            return setNoReplyMemoryScore(ctx, payload.callsign, payload.score);
          case 'clearCallsign':
            return clearNoReplyMemoryEntry(ctx, payload.callsign);
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });
  },

  hooks: {
    onFilterCandidates(candidates, ctx) {
      const now = Date.now();
      const settings = readSettings(ctx);
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
        return score >= settings.blockThreshold;
      });

      if (filtered.length < candidates.length) {
        ctx.log.debug('No-reply memory filter applied', {
          before: candidates.length,
          after: filtered.length,
          blockThreshold: settings.blockThreshold,
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
      const settings = readSettings(ctx);
      const current = readEntry(ctx, callsign);
      const nextScore = calculateScoreAfterFailure(current, info, now, settings);
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
      getMemoryStore(ctx).delete(getStoreKey(callsign));
      ctx.log.debug('No-reply memory score cleared after QSO completion', { callsign });
    },
  },
};

export const noReplyMemoryFilterLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
