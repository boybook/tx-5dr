import type {
  AutoCallOperatorCandidate,
  AutoCallOperatorSelectionRequest,
  PluginContext,
  PluginDefinition,
  QSOFailureInfo,
} from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

export const BUILTIN_AUTOCALL_OPERATOR_ROTATION_PLUGIN_NAME = 'autocall-operator-rotation';

type RotationMode = 'manual' | 'random';

interface TargetRotationState {
  cursorOperatorCallsign?: string;
  lastSelectedOperatorCallsign?: string;
  consecutiveFailCount: number;
  pendingAdvance: boolean;
}

const DEFAULT_FAIL_ADVANCE_THRESHOLD = 1;

function normalizeCallsign(input: unknown): string {
  return typeof input === 'string' ? input.trim().toUpperCase() : '';
}

function getMode(ctx: PluginContext): RotationMode {
  return ctx.config.mode === 'random' ? 'random' : 'manual';
}

function getFailAdvanceThreshold(ctx: PluginContext): number {
  const raw = Number(ctx.config.failAdvanceThreshold);
  if (!Number.isFinite(raw)) {
    return DEFAULT_FAIL_ADVANCE_THRESHOLD;
  }
  return Math.max(1, Math.trunc(raw));
}

function shouldAvoidImmediateRepeatInRandom(ctx: PluginContext): boolean {
  return ctx.config.avoidImmediateRepeatInRandom !== false;
}

function getManualOrder(ctx: PluginContext): string[] {
  if (!Array.isArray(ctx.config.manualOrder)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of ctx.config.manualOrder) {
    const callsign = normalizeCallsign(entry);
    if (!callsign || seen.has(callsign)) {
      continue;
    }
    seen.add(callsign);
    normalized.push(callsign);
  }
  return normalized;
}

function getTargetStateKey(callsign: string): string {
  return `target:${callsign}`;
}

function readTargetState(ctx: PluginContext, callsign: string): TargetRotationState {
  const state = ctx.store.global.get<TargetRotationState | undefined>(getTargetStateKey(callsign));
  if (!state || typeof state !== 'object') {
    return {
      consecutiveFailCount: 0,
      pendingAdvance: false,
    };
  }

  return {
    cursorOperatorCallsign: normalizeCallsign(state.cursorOperatorCallsign),
    lastSelectedOperatorCallsign: normalizeCallsign(state.lastSelectedOperatorCallsign),
    consecutiveFailCount: Number.isFinite(state.consecutiveFailCount)
      ? Math.max(0, Math.trunc(state.consecutiveFailCount))
      : 0,
    pendingAdvance: state.pendingAdvance === true,
  };
}

function writeTargetState(ctx: PluginContext, callsign: string, state: TargetRotationState): void {
  ctx.store.global.set(getTargetStateKey(callsign), state);
}

function findCandidateByOperatorCallsign(
  candidates: AutoCallOperatorCandidate[],
  operatorCallsign: string,
): AutoCallOperatorCandidate | undefined {
  if (!operatorCallsign) {
    return undefined;
  }
  return candidates.find((candidate) => normalizeCallsign(candidate.operatorCallsign) === operatorCallsign);
}

function selectManualCandidate(
  candidates: AutoCallOperatorCandidate[],
  state: TargetRotationState,
  manualOrder: string[],
): AutoCallOperatorCandidate {
  const cursorCandidate = findCandidateByOperatorCallsign(candidates, state.cursorOperatorCallsign ?? '');
  if (!state.pendingAdvance && cursorCandidate) {
    return cursorCandidate;
  }

  if (manualOrder.length === 0) {
    if (state.pendingAdvance && candidates.length > 1 && cursorCandidate) {
      const fallback = candidates.find((candidate) => candidate.operatorId !== cursorCandidate.operatorId);
      return fallback ?? candidates[0]!;
    }
    return candidates[0]!;
  }

  const cursor = state.cursorOperatorCallsign ?? '';
  const cursorIndex = cursor ? manualOrder.indexOf(cursor) : -1;
  const startIndex = state.pendingAdvance
    ? (cursorIndex >= 0 ? (cursorIndex + 1) % manualOrder.length : 0)
    : (cursorIndex >= 0 ? cursorIndex : 0);

  for (let offset = 0; offset < manualOrder.length; offset += 1) {
    const index = (startIndex + offset) % manualOrder.length;
    const orderedCallsign = manualOrder[index]!;
    const matched = findCandidateByOperatorCallsign(candidates, orderedCallsign);
    if (matched) {
      return matched;
    }
  }

  return cursorCandidate ?? candidates[0]!;
}

function selectRandomCandidate(
  candidates: AutoCallOperatorCandidate[],
  state: TargetRotationState,
  avoidImmediateRepeat: boolean,
): AutoCallOperatorCandidate {
  const cursorCandidate = findCandidateByOperatorCallsign(candidates, state.cursorOperatorCallsign ?? '');
  if (!state.pendingAdvance && cursorCandidate) {
    return cursorCandidate;
  }

  let pool = candidates;
  if (avoidImmediateRepeat && candidates.length > 1) {
    const avoidCallsign = normalizeCallsign(state.lastSelectedOperatorCallsign);
    const filtered = avoidCallsign
      ? candidates.filter((candidate) => normalizeCallsign(candidate.operatorCallsign) !== avoidCallsign)
      : candidates;
    if (filtered.length > 0) {
      pool = filtered;
    }
  }

  const selectedIndex = Math.floor(Math.random() * pool.length);
  return pool[selectedIndex] ?? candidates[0]!;
}

function selectCandidate(
  request: AutoCallOperatorSelectionRequest,
  ctx: PluginContext,
  state: TargetRotationState,
): AutoCallOperatorCandidate {
  const candidates = request.candidates;
  const mode = getMode(ctx);

  if (mode === 'random') {
    return selectRandomCandidate(candidates, state, shouldAvoidImmediateRepeatInRandom(ctx));
  }

  return selectManualCandidate(candidates, state, getManualOrder(ctx));
}

function markTargetForAdvanceOnQSOComplete(
  record: QSORecord,
  ctx: PluginContext,
): void {
  const callsign = normalizeCallsign(record.callsign);
  if (!callsign) {
    return;
  }

  const state = readTargetState(ctx, callsign);
  if (!state.cursorOperatorCallsign && !state.lastSelectedOperatorCallsign) {
    return;
  }

  writeTargetState(ctx, callsign, {
    ...state,
    consecutiveFailCount: 0,
    pendingAdvance: true,
  });
}

function updateTargetFailState(
  info: QSOFailureInfo,
  ctx: PluginContext,
): void {
  const callsign = normalizeCallsign(info.targetCallsign);
  if (!callsign) {
    return;
  }

  const state = readTargetState(ctx, callsign);
  if (!state.cursorOperatorCallsign && !state.lastSelectedOperatorCallsign) {
    return;
  }

  const threshold = getFailAdvanceThreshold(ctx);
  const nextFailCount = state.consecutiveFailCount + 1;
  const shouldAdvance = nextFailCount >= threshold;

  writeTargetState(ctx, callsign, {
    ...state,
    consecutiveFailCount: shouldAdvance ? 0 : nextFailCount,
    pendingAdvance: state.pendingAdvance || shouldAdvance,
  });
}

export const autocallOperatorRotationPlugin: PluginDefinition = {
  name: BUILTIN_AUTOCALL_OPERATOR_ROTATION_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  instanceScope: 'global',
  description: 'Resolve which operator should execute an accepted autocall target when multiple operators match',

  settings: {
    mode: {
      type: 'string',
      default: 'manual',
      label: 'mode',
      description: 'modeDesc',
      scope: 'global',
      options: [
        { label: 'modeManual', value: 'manual' },
        { label: 'modeRandom', value: 'random' },
      ],
    },
    manualOrder: {
      type: 'string[]',
      default: [],
      label: 'manualOrder',
      description: 'manualOrderDesc',
      scope: 'global',
      visibleWhen: {
        setting: 'mode',
        equals: 'manual',
      },
    },
    failAdvanceThreshold: {
      type: 'number',
      default: DEFAULT_FAIL_ADVANCE_THRESHOLD,
      label: 'failAdvanceThreshold',
      description: 'failAdvanceThresholdDesc',
      scope: 'global',
      min: 1,
      max: 20,
    },
    avoidImmediateRepeatInRandom: {
      type: 'boolean',
      default: true,
      label: 'avoidImmediateRepeatInRandom',
      description: 'avoidImmediateRepeatInRandomDesc',
      scope: 'global',
      visibleWhen: {
        setting: 'mode',
        equals: 'random',
      },
    },
  },

  hooks: {
    onResolveAutoCallOperator(request, ctx) {
      const callsign = normalizeCallsign(request.callsign);
      if (!callsign || request.candidates.length === 0) {
        return null;
      }

      const normalizedCandidates = request.candidates.map((candidate) => ({
        ...candidate,
        operatorCallsign: normalizeCallsign(candidate.operatorCallsign),
        callsign: normalizeCallsign(candidate.callsign),
      }));
      const state = readTargetState(ctx, callsign);
      const selected = selectCandidate({
        ...request,
        callsign,
        candidates: normalizedCandidates,
      }, ctx, state);
      if (!selected) {
        return null;
      }

      writeTargetState(ctx, callsign, {
        ...state,
        cursorOperatorCallsign: normalizeCallsign(selected.operatorCallsign),
        lastSelectedOperatorCallsign: normalizeCallsign(selected.operatorCallsign),
        pendingAdvance: false,
      });

      return { selectedOperatorId: selected.operatorId };
    },

    onQSOComplete(record, ctx) {
      markTargetForAdvanceOnQSOComplete(record, ctx);
    },

    onQSOFail(info, ctx) {
      updateTargetFailState(info, ctx);
    },
  },
};

export const autocallOperatorRotationLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};
