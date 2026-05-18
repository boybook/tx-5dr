import type { FrameMessage, ModeDescriptor, SlotPack, SlotPackFrequencyContext } from '@tx5dr/contracts';
import { CycleUtils, parseFT8LocationInfo } from '@tx5dr/core';
import type { FrameDisplayMessage, FrameGroup } from '../../components/radio/digital/FramesTable';

const MAX_GROUPS = 100;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

function isValidTimestampMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_VALID_DATE_MS;
}

function isValidSlotMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidMode(mode: ModeDescriptor): boolean {
  return isValidSlotMs(mode.slotMs);
}

function isValidSlotPack(slotPack: SlotPack): boolean {
  return isValidTimestampMs(slotPack.startMs)
    && isValidTimestampMs(slotPack.endMs)
    && slotPack.endMs >= slotPack.startMs;
}

function sanitizeLiveSlotStartMs(value: number | null): number | null {
  return isValidTimestampMs(value) ? value : null;
}

interface MyRelatedTimelineLiveRxEntry {
  slotStartMs: number;
  messageKey: string;
  message: FrameDisplayMessage;
  headerContextKey: string;
  frequencyContext?: SlotPackFrequencyContext;
  manualSeed: boolean;
}

export interface MyRelatedTimelineState {
  frozenGroups: FrameGroup[];
  frozenMessageKeys: Set<string>;
  liveGroups: FrameGroup[];
  currentLiveSlotStartMs: number | null;
  liveRxEntries: Map<string, MyRelatedTimelineLiveRxEntry>;
  liveTxLogs: Map<string, MyRelatedTransmissionLog>;
  liveVisibleOperatorCallsigns: string[];
  liveTargetCallsign: string;
  pendingRestore: boolean;
  lastProcessedSlotPackSeq: Map<string, number>;
}

export interface MyRelatedTransmissionLog {
  operatorId: string;
  myCallsign?: string;
  headerContextKey?: string;
  time: string;
  message: string;
  frequency: number;
  slotStartMs: number;
  replaceExisting?: boolean;
  frequencyContext?: SlotPackFrequencyContext;
}

export type MyRelatedTimelineAction =
  | {
      type: 'syncLiveContext';
      payload: {
        currentMode: ModeDescriptor;
        liveSlotStartMs: number | null;
        visibleOperatorCallsigns: string[];
        targetCallsign: string;
      };
    }
  | {
      type: 'seedSelectedRx';
      payload: {
        currentMode: ModeDescriptor;
        message: FrameDisplayMessage;
        slotStartMs: number;
        liveSlotStartMs: number | null;
        frequencyContext?: SlotPackFrequencyContext;
      };
    }
  | {
      type: 'ingestSlotPack';
      payload: {
        slotPack: SlotPack;
        currentMode: ModeDescriptor;
        liveSlotStartMs: number | null;
        visibleOperatorCallsigns: string[];
        targetCallsign: string;
      };
    }
  | {
      type: 'ingestTransmissionLog';
      payload: {
        log: MyRelatedTransmissionLog;
        currentMode: ModeDescriptor;
        liveSlotStartMs: number | null;
      };
    }
  | { type: 'beginRestore' }
  | {
      type: 'finalizeRestore';
      payload: {
        slotPacks: SlotPack[];
        currentMode: ModeDescriptor;
        liveSlotStartMs: number | null;
        visibleOperatorCallsigns: string[];
        targetCallsign: string;
        operatorCallsignsById: Record<string, string>;
      };
    }
  | { type: 'clearTimeline' };

export const initialMyRelatedTimelineState: MyRelatedTimelineState = {
  frozenGroups: [],
  frozenMessageKeys: new Set<string>(),
  liveGroups: [],
  currentLiveSlotStartMs: null,
  liveRxEntries: new Map<string, MyRelatedTimelineLiveRxEntry>(),
  liveTxLogs: new Map<string, MyRelatedTransmissionLog>(),
  liveVisibleOperatorCallsigns: [],
  liveTargetCallsign: '',
  pendingRestore: false,
  lastProcessedSlotPackSeq: new Map<string, number>(),
};

export function myRelatedTimelineReducer(
  state: MyRelatedTimelineState,
  action: MyRelatedTimelineAction,
): MyRelatedTimelineState {
  switch (action.type) {
    case 'syncLiveContext': {
      const { currentMode, liveSlotStartMs, visibleOperatorCallsigns, targetCallsign } = action.payload;
      if (!isValidMode(currentMode)) {
        return state;
      }
      const nextState = rolloverLiveCycle(state, currentMode, sanitizeLiveSlotStartMs(liveSlotStartMs));
      return reprojectLiveGroups(nextState, currentMode, visibleOperatorCallsigns, targetCallsign);
    }

    case 'seedSelectedRx': {
      const { currentMode, message, slotStartMs, liveSlotStartMs, frequencyContext } = action.payload;
      if (!isValidMode(currentMode) || !isValidTimestampMs(slotStartMs)) {
        return state;
      }
      const nextState = rolloverLiveCycle(state, currentMode, sanitizeLiveSlotStartMs(liveSlotStartMs));
      const messageKey = buildRxDisplayMessageKey(slotStartMs, message);
      const liveRxEntries = new Map(nextState.liveRxEntries);
      const existing = liveRxEntries.get(messageKey);
      liveRxEntries.set(messageKey, {
        slotStartMs,
        messageKey,
        message,
        headerContextKey: buildHeaderContextKey(frequencyContext),
        frequencyContext: frequencyContext ?? existing?.frequencyContext,
        manualSeed: true,
      });

      return reprojectLiveGroups(
        {
          ...nextState,
          liveRxEntries,
        },
        currentMode,
        nextState.liveVisibleOperatorCallsigns,
        nextState.liveTargetCallsign,
      );
    }

    case 'ingestSlotPack': {
      const { slotPack, currentMode, liveSlotStartMs, visibleOperatorCallsigns, targetCallsign } = action.payload;
      if (!isValidMode(currentMode) || !isValidSlotPack(slotPack)) {
        return state;
      }

      const previousSeq = state.lastProcessedSlotPackSeq.get(slotPack.slotId) ?? -1;
      const incomingSeq = slotPack.stats?.updateSeq ?? 0;
      if (incomingSeq <= previousSeq) {
        return state;
      }

      let nextState = rolloverLiveCycle(
        {
          ...state,
          lastProcessedSlotPackSeq: new Map(state.lastProcessedSlotPackSeq).set(slotPack.slotId, incomingSeq),
        },
        currentMode,
        sanitizeLiveSlotStartMs(liveSlotStartMs),
      );

      if (nextState.pendingRestore) {
        return nextState;
      }

      const liveRxEntries = new Map(nextState.liveRxEntries);
      for (const frame of slotPack.frames) {
        if (frame.snr === -999) {
          continue;
        }

        const messageKey = buildFrameMessageKey(frame, slotPack.startMs);
        const message = frameToDisplayMessage(frame, slotPack.startMs);

        if (nextState.currentLiveSlotStartMs !== null && slotPack.startMs < nextState.currentLiveSlotStartMs) {
          if (!matchesVisibleOperators(frame.message, visibleOperatorCallsigns) && !containsCallsign(frame.message, targetCallsign)) {
            continue;
          }

          nextState = appendFrozenDisplayMessage(
            nextState,
            slotPack.startMs,
            currentMode,
            message,
            messageKey,
            buildHeaderContextKey(slotPack.frequencyContext),
            slotPack.frequencyContext,
          );
          continue;
        }

        const existing = liveRxEntries.get(messageKey);
        liveRxEntries.set(messageKey, {
          slotStartMs: slotPack.startMs,
          messageKey,
          message,
          headerContextKey: buildHeaderContextKey(slotPack.frequencyContext),
          frequencyContext: slotPack.frequencyContext ?? existing?.frequencyContext,
          manualSeed: existing?.manualSeed ?? false,
        });
      }

      nextState = {
        ...nextState,
        liveRxEntries,
      };

      return reprojectLiveGroups(nextState, currentMode, visibleOperatorCallsigns, targetCallsign);
    }

    case 'ingestTransmissionLog': {
      const { log, currentMode, liveSlotStartMs } = action.payload;
      if (!isValidMode(currentMode) || !isValidTimestampMs(log.slotStartMs)) {
        return state;
      }

      const nextState = rolloverLiveCycle(
        state,
        currentMode,
        sanitizeLiveSlotStartMs(liveSlotStartMs) ?? log.slotStartMs,
      );

      if (
        nextState.currentLiveSlotStartMs !== null &&
        log.slotStartMs < nextState.currentLiveSlotStartMs
      ) {
        return appendFrozenTransmission(nextState, log, currentMode);
      }

      const liveTxLogs = new Map(nextState.liveTxLogs);
      liveTxLogs.set(buildLiveTxKey(log.operatorId, log.slotStartMs), log);
      return reprojectLiveGroups(
        {
          ...nextState,
          liveTxLogs,
        },
        currentMode,
        nextState.liveVisibleOperatorCallsigns,
        nextState.liveTargetCallsign,
      );
    }

    case 'beginRestore':
      return {
        ...state,
        pendingRestore: true,
      };

    case 'finalizeRestore': {
      const {
        slotPacks,
        currentMode,
        liveSlotStartMs,
        visibleOperatorCallsigns,
        targetCallsign,
        operatorCallsignsById,
      } = action.payload;
      if (!state.pendingRestore) {
        return state;
      }

      if (!isValidMode(currentMode)) {
        return {
          ...state,
          pendingRestore: false,
        };
      }

      const validSlotPacks = slotPacks.filter(isValidSlotPack);
      const resolvedLiveSlotStartMs = sanitizeLiveSlotStartMs(liveSlotStartMs) ?? findLatestSlotStartMs(validSlotPacks);
      let nextState: MyRelatedTimelineState = {
        frozenGroups: [],
        frozenMessageKeys: new Set<string>(),
        liveGroups: [],
        currentLiveSlotStartMs: resolvedLiveSlotStartMs,
        liveRxEntries: new Map<string, MyRelatedTimelineLiveRxEntry>(),
        liveTxLogs: new Map<string, MyRelatedTransmissionLog>(),
        liveVisibleOperatorCallsigns: visibleOperatorCallsigns,
        liveTargetCallsign: targetCallsign,
        pendingRestore: false,
        lastProcessedSlotPackSeq: createProcessedSeqMap(state.lastProcessedSlotPackSeq, validSlotPacks),
      };

      const sortedSlotPacks = [...validSlotPacks].sort((left, right) => left.startMs - right.startMs);
      for (const slotPack of sortedSlotPacks) {
        const isLiveSlot = resolvedLiveSlotStartMs !== null && slotPack.startMs === resolvedLiveSlotStartMs;

        for (const frame of slotPack.frames) {
          if (frame.snr === -999 && frame.operatorId) {
            const log: MyRelatedTransmissionLog = {
              operatorId: frame.operatorId,
              myCallsign: operatorCallsignsById[frame.operatorId] || undefined,
              headerContextKey: buildHeaderContextKey(slotPack.frequencyContext),
              time: new Date(slotPack.startMs).toISOString().slice(11, 19).replace(/:/g, ''),
              message: frame.message,
              frequency: Math.round(frame.freq),
              slotStartMs: slotPack.startMs,
              replaceExisting: true,
              frequencyContext: slotPack.frequencyContext,
            };

            if (isLiveSlot) {
              nextState.liveTxLogs.set(buildLiveTxKey(log.operatorId, log.slotStartMs), log);
            } else {
              nextState = appendFrozenTransmission(nextState, log, currentMode);
            }
            continue;
          }

          if (frame.snr === -999) {
            continue;
          }

          const message = frameToDisplayMessage(frame, slotPack.startMs);
          const messageKey = buildFrameMessageKey(frame, slotPack.startMs);
          if (isLiveSlot) {
            nextState.liveRxEntries.set(messageKey, {
              slotStartMs: slotPack.startMs,
              messageKey,
              message,
              headerContextKey: buildHeaderContextKey(slotPack.frequencyContext),
              frequencyContext: slotPack.frequencyContext,
              manualSeed: false,
            });
            continue;
          }

          if (!matchesVisibleOperators(frame.message, visibleOperatorCallsigns) && !containsCallsign(frame.message, targetCallsign)) {
            continue;
          }

          nextState = appendFrozenDisplayMessage(
            nextState,
            slotPack.startMs,
            currentMode,
            message,
            messageKey,
            buildHeaderContextKey(slotPack.frequencyContext),
            slotPack.frequencyContext,
          );
        }
      }

      return reprojectLiveGroups(nextState, currentMode, visibleOperatorCallsigns, targetCallsign);
    }

    case 'clearTimeline':
      return {
        ...state,
        frozenGroups: [],
        frozenMessageKeys: new Set<string>(),
        liveGroups: [],
        liveRxEntries: new Map<string, MyRelatedTimelineLiveRxEntry>(),
        liveTxLogs: new Map<string, MyRelatedTransmissionLog>(),
        pendingRestore: false,
      };

    default:
      return state;
  }
}

export function buildMyRelatedTimelineGroups(state: MyRelatedTimelineState): FrameGroup[] {
  return mergeGroups([
    ...state.frozenGroups,
    ...state.liveGroups,
  ]);
}

function rolloverLiveCycle(
  state: MyRelatedTimelineState,
  currentMode: ModeDescriptor,
  nextLiveSlotStartMs: number | null,
): MyRelatedTimelineState {
  if (!isValidMode(currentMode)) {
    return state;
  }

  if (nextLiveSlotStartMs === null) {
    return state;
  }

  if (state.currentLiveSlotStartMs === null) {
    return {
      ...state,
      currentLiveSlotStartMs: nextLiveSlotStartMs,
    };
  }

  if (nextLiveSlotStartMs <= state.currentLiveSlotStartMs) {
    return state;
  }

  const frozenState = freezeLiveGroups(state, currentMode);
  return {
    ...frozenState,
    currentLiveSlotStartMs: nextLiveSlotStartMs,
    liveGroups: [],
    liveRxEntries: new Map<string, MyRelatedTimelineLiveRxEntry>(),
    liveTxLogs: new Map<string, MyRelatedTransmissionLog>(),
  };
}

function reprojectLiveGroups(
  state: MyRelatedTimelineState,
  currentMode: ModeDescriptor,
  visibleOperatorCallsigns: string[],
  targetCallsign: string,
): MyRelatedTimelineState {
  let liveGroups: FrameGroup[] = [];

  for (const log of state.liveTxLogs.values()) {
    liveGroups = upsertTransmissionGroupMessage(liveGroups, log, currentMode, log.frequencyContext);
  }

  for (const entry of state.liveRxEntries.values()) {
    if (!entry.manualSeed && !matchesVisibleOperators(entry.message.message, visibleOperatorCallsigns) && !containsCallsign(entry.message.message, targetCallsign)) {
      continue;
    }

    liveGroups = appendMessageToGroups(
      liveGroups,
      entry.slotStartMs,
      currentMode.slotMs,
      entry.message,
      entry.headerContextKey,
      entry.frequencyContext,
    );
  }

  return {
    ...state,
    liveGroups: trimGroups(liveGroups),
    liveVisibleOperatorCallsigns: [...visibleOperatorCallsigns],
    liveTargetCallsign: targetCallsign,
  };
}

function freezeLiveGroups(
  state: MyRelatedTimelineState,
  currentMode: ModeDescriptor,
): MyRelatedTimelineState {
  let nextState = state;
  for (const group of state.liveGroups) {
    for (const message of group.messages) {
      const messageKey = buildFrozenMessageKey(group.startMs, message);
      if (nextState.frozenMessageKeys.has(messageKey)) {
        continue;
      }

      if (message.db === 'TX') {
        const log = state.liveTxLogs.get(buildLiveTxKey(message.operatorId ?? '', group.startMs));
        if (log) {
          nextState = appendFrozenTransmission(nextState, log, currentMode);
        }
        continue;
      }

      nextState = appendFrozenDisplayMessage(
        nextState,
        group.startMs,
        currentMode,
        message,
        messageKey,
        group.headerContextKey ?? buildHeaderContextKey(group.frequencyContext),
        group.frequencyContext,
      );
    }
  }

  return nextState;
}

function appendFrozenDisplayMessage(
  state: MyRelatedTimelineState,
  slotStartMs: number,
  currentMode: ModeDescriptor,
  message: FrameDisplayMessage,
  messageKey: string,
  headerContextKey: string,
  frequencyContext?: SlotPackFrequencyContext,
): MyRelatedTimelineState {
  if (!isValidMode(currentMode) || !isValidTimestampMs(slotStartMs)) {
    return state;
  }

  if (state.frozenMessageKeys.has(messageKey)) {
    return state;
  }

  const frozenMessageKeys = new Set(state.frozenMessageKeys);
  frozenMessageKeys.add(messageKey);
  return {
    ...state,
    frozenGroups: trimGroups(
      appendMessageToGroups(
        state.frozenGroups,
        slotStartMs,
        currentMode.slotMs,
        message,
        headerContextKey,
        frequencyContext,
      ),
    ),
    frozenMessageKeys,
  };
}

function appendFrozenTransmission(
  state: MyRelatedTimelineState,
  log: MyRelatedTransmissionLog,
  currentMode: ModeDescriptor,
): MyRelatedTimelineState {
  if (!isValidMode(currentMode) || !isValidTimestampMs(log.slotStartMs)) {
    return state;
  }

  const messageKey = buildFrozenMessageKey(log.slotStartMs, transmissionLogToDisplayMessage(log));
  const frozenMessageKeys = new Set(state.frozenMessageKeys);
  frozenMessageKeys.add(messageKey);
  return {
    ...state,
    frozenGroups: trimGroups(
      upsertTransmissionGroupMessage(
        state.frozenGroups,
        log,
        currentMode,
        log.frequencyContext,
      ),
    ),
    frozenMessageKeys,
  };
}

function appendMessageToGroups(
  groups: FrameGroup[],
  slotStartMs: number,
  slotMs: number,
  message: FrameDisplayMessage,
  headerContextKey: string,
  frequencyContext?: SlotPackFrequencyContext,
): FrameGroup[] {
  if (!isValidTimestampMs(slotStartMs) || !isValidSlotMs(slotMs)) {
    return groups;
  }

  const alignedMs = Math.floor(slotStartMs / slotMs) * slotMs;
  if (!isValidTimestampMs(alignedMs)) {
    return groups;
  }

  const groupKey = getGroupIdentityKey(alignedMs, frequencyContext);
  const existingIndex = groups.findIndex(group => getGroupIdentityKey(group.startMs, group.frequencyContext) === groupKey);

  if (existingIndex === -1) {
    const cycleNumber = CycleUtils.calculateCycleNumberFromMs(slotStartMs, slotMs);
    return mergeGroups([
      ...groups,
      {
        time: CycleUtils.generateSlotGroupKey(slotStartMs, slotMs),
        startMs: alignedMs,
        messages: [message],
        type: message.db === 'TX' ? 'transmit' : 'receive',
        cycle: CycleUtils.isEvenCycle(cycleNumber) ? 'even' : 'odd',
        headerContextKey,
        ...(frequencyContext && { frequencyContext }),
      },
    ]);
  }

  const nextGroups = groups.slice();
  const existingGroup = nextGroups[existingIndex]!;
  const mergedMessages = mergeMessages(existingGroup.messages, [message]);
  nextGroups[existingIndex] = {
    ...existingGroup,
    messages: mergedMessages,
    type: mergedMessages.some(item => item.db === 'TX') ? 'transmit' : 'receive',
    headerContextKey: existingGroup.headerContextKey || headerContextKey,
    frequencyContext: mergeFrequencyContext(existingGroup.frequencyContext, frequencyContext),
  };

  return mergeGroups(nextGroups);
}

function upsertTransmissionGroupMessage(
  groups: FrameGroup[],
  log: MyRelatedTransmissionLog,
  currentMode: ModeDescriptor,
  frequencyContext?: SlotPackFrequencyContext,
): FrameGroup[] {
  if (!isValidMode(currentMode) || !isValidTimestampMs(log.slotStartMs)) {
    return groups;
  }

  const alignedMs = Math.floor(log.slotStartMs / currentMode.slotMs) * currentMode.slotMs;
  if (!isValidTimestampMs(alignedMs)) {
    return groups;
  }

  const groupKey = getGroupIdentityKey(alignedMs, frequencyContext);
  const existingIndex = groups.findIndex(group => getGroupIdentityKey(group.startMs, group.frequencyContext) === groupKey);
  const txMessage = transmissionLogToDisplayMessage(log);
  const headerContextKey = log.headerContextKey ?? buildHeaderContextKey(frequencyContext);

  if (existingIndex === -1) {
    const cycleNumber = CycleUtils.calculateCycleNumberFromMs(log.slotStartMs, currentMode.slotMs);
    return mergeGroups([
      ...groups,
      {
        time: CycleUtils.generateSlotGroupKey(log.slotStartMs, currentMode.slotMs),
        startMs: alignedMs,
        messages: [txMessage],
        type: 'transmit',
        cycle: CycleUtils.isEvenCycle(cycleNumber) ? 'even' : 'odd',
        headerContextKey,
        ...(frequencyContext && { frequencyContext }),
      },
    ]);
  }

  const nextGroups = groups.slice();
  const existingGroup = nextGroups[existingIndex]!;
  const nextMessages = mergeMessages(existingGroup.messages, [txMessage]);
  nextGroups[existingIndex] = {
    ...existingGroup,
    messages: nextMessages,
    type: 'transmit',
    headerContextKey: existingGroup.headerContextKey || headerContextKey,
    frequencyContext: mergeFrequencyContext(existingGroup.frequencyContext, frequencyContext),
  };

  return mergeGroups(nextGroups);
}

function mergeGroups(groups: FrameGroup[]): FrameGroup[] {
  const byKey = new Map<string, FrameGroup>();

  for (const group of groups) {
    const key = getGroupIdentityKey(group.startMs, group.frequencyContext);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...group,
        messages: mergeMessages([], group.messages),
        headerContextKey: group.headerContextKey,
        ...(group.frequencyContext ? { frequencyContext: { ...group.frequencyContext } } : {}),
      });
      continue;
    }

    const mergedMessages = mergeMessages(existing.messages, group.messages);
    byKey.set(key, {
      ...existing,
      time: existing.time || group.time,
      cycle: existing.cycle,
      type: mergedMessages.some(message => message.db === 'TX') ? 'transmit' : 'receive',
      messages: mergedMessages,
      headerContextKey: existing.headerContextKey || group.headerContextKey,
      frequencyContext: mergeFrequencyContext(existing.frequencyContext, group.frequencyContext),
    });
  }

  return Array.from(byKey.values()).sort((left, right) => left.startMs - right.startMs);
}

function trimGroups(groups: FrameGroup[]): FrameGroup[] {
  const merged = mergeGroups(groups);
  return merged.length > MAX_GROUPS ? merged.slice(-MAX_GROUPS) : merged;
}

function mergeMessages(existing: FrameDisplayMessage[], incoming: FrameDisplayMessage[]): FrameDisplayMessage[] {
  const byKey = new Map<string, FrameDisplayMessage>();
  for (const message of [...existing, ...incoming]) {
    byKey.set(buildInlineMessageKey(message), message);
  }
  return Array.from(byKey.values()).sort((left, right) => left.utc.localeCompare(right.utc));
}

function buildInlineMessageKey(message: FrameDisplayMessage): string {
  if (message.db === 'TX') {
    return `TX:${message.operatorId ?? message.message}`;
  }

  return [
    'RX',
    message.message,
  ].join(':');
}

function matchesVisibleOperators(message: string, visibleOperatorCallsigns: string[]): boolean {
  return visibleOperatorCallsigns.some(callsign => containsCallsign(message, callsign));
}

function containsCallsign(message: string, callsign: string): boolean {
  const normalizedCallsign = callsign.trim().toUpperCase();
  if (!normalizedCallsign) {
    return false;
  }

  const upperMessage = message.toUpperCase();
  return upperMessage.includes(normalizedCallsign) ||
    upperMessage.startsWith(`${normalizedCallsign} `) ||
    upperMessage.includes(` ${normalizedCallsign} `) ||
    upperMessage.endsWith(` ${normalizedCallsign}`);
}

function buildFrameMessageKey(frame: FrameMessage, slotStartMs: number): string {
  return [
    'RX',
    slotStartMs,
    frame.message,
  ].join(':');
}

function buildRxDisplayMessageKey(slotStartMs: number, message: FrameDisplayMessage): string {
  return [
    'RX',
    slotStartMs,
    message.message,
  ].join(':');
}

function buildFrozenMessageKey(slotStartMs: number, message: FrameDisplayMessage): string {
  if (message.db === 'TX') {
    return `TX:${slotStartMs}:${message.operatorId ?? message.message}`;
  }

  return buildRxDisplayMessageKey(slotStartMs, message);
}

function buildLiveTxKey(operatorId: string, slotStartMs: number): string {
  return `${operatorId}:${slotStartMs}`;
}

function getGroupIdentityKey(startMs: number, frequencyContext?: SlotPackFrequencyContext): string {
  return [
    startMs,
    frequencyContext?.frequency ?? '',
    frequencyContext?.band ?? '',
    frequencyContext?.mode ?? '',
  ].join(':');
}

function mergeFrequencyContext(
  existing?: SlotPackFrequencyContext,
  incoming?: SlotPackFrequencyContext,
): SlotPackFrequencyContext | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  return {
    ...existing,
    ...incoming,
    frequency: incoming.frequency ?? existing.frequency,
    band: incoming.band ?? existing.band,
    mode: incoming.mode ?? existing.mode,
    radioMode: incoming.radioMode ?? existing.radioMode,
    description: incoming.description ?? existing.description,
  };
}

function findLatestSlotStartMs(slotPacks: SlotPack[]): number | null {
  const validSlotPacks = slotPacks.filter(isValidSlotPack);
  if (validSlotPacks.length === 0) {
    return null;
  }

  return validSlotPacks.reduce<number | null>((latest, slotPack) => {
    if (latest === null || slotPack.startMs > latest) {
      return slotPack.startMs;
    }
    return latest;
  }, null);
}

function createProcessedSeqMap(
  existing: Map<string, number>,
  slotPacks: SlotPack[],
): Map<string, number> {
  const next = new Map(existing);
  for (const slotPack of slotPacks) {
    next.set(slotPack.slotId, slotPack.stats?.updateSeq ?? 0);
  }
  return next;
}

function buildHeaderContextKey(frequencyContext?: SlotPackFrequencyContext): string {
  return frequencyContext
    ? [
        frequencyContext.frequency ?? '',
        frequencyContext.band ?? '',
        frequencyContext.mode ?? '',
      ].join(':')
    : 'no-frequency';
}

function frameToDisplayMessage(frame: FrameMessage, slotStartMs: number): FrameDisplayMessage {
  const utcSeconds = new Date(slotStartMs).toISOString().slice(11, 19);
  const locationInfo = parseFT8LocationInfo(frame.message);

  return {
    utc: utcSeconds,
    db: frame.snr === -999 ? 'TX' : frame.snr,
    dt: frame.snr === -999 ? '-' : frame.dt,
    freq: Math.round(frame.freq),
    message: frame.message,
    ...(locationInfo.country && { country: locationInfo.country }),
    ...(locationInfo.countryZh && { countryZh: locationInfo.countryZh }),
    ...(locationInfo.countryEn && { countryEn: locationInfo.countryEn }),
    ...(locationInfo.countryCode && { countryCode: locationInfo.countryCode }),
    ...(locationInfo.flag && { flag: locationInfo.flag }),
    ...(locationInfo.state && { state: locationInfo.state }),
    ...(locationInfo.stateConfidence && { stateConfidence: locationInfo.stateConfidence }),
    ...(frame.logbookAnalysis && { logbookAnalysis: frame.logbookAnalysis }),
  };
}

function transmissionLogToDisplayMessage(log: MyRelatedTransmissionLog): FrameDisplayMessage {
  return {
    utc: log.time.slice(0, 2) + ':' + log.time.slice(2, 4) + ':' + log.time.slice(4, 6),
    db: 'TX',
    dt: '-',
    freq: log.frequency,
    message: log.message,
    operatorId: log.operatorId,
    ...(log.myCallsign ? { emphasisCallsigns: [log.myCallsign] } : {}),
  };
}
