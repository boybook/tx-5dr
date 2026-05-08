import type { FrameMessage, ModeDescriptor, SlotPack, SlotPackFrequencyContext } from '@tx5dr/contracts';
import { CycleUtils, FT8MessageParser, parseFT8LocationInfo } from '@tx5dr/core';
import type { FrameDisplayMessage, FrameGroup } from '../../components/radio/digital/FramesTable';

const MAX_GROUPS = 100;

export interface MyRelatedTimelineOperatorContext {
  operatorId: string;
  myCallsign: string;
  targetCallsign: string;
  headerContextKey: string;
  frequencyContext?: SlotPackFrequencyContext;
  startedAtMs: number;
}

export interface MyRelatedTimelineActiveSession extends MyRelatedTimelineOperatorContext {
  groups: FrameGroup[];
  seenMessageKeys: Set<string>;
}

export interface MyRelatedTimelineState {
  globalTxGroups: FrameGroup[];
  committedRxGroups: FrameGroup[];
  committedRxMessageKeys: Set<string>;
  activeSession: MyRelatedTimelineActiveSession | null;
  pendingRestore: boolean;
  lastProcessedSlotPackSeq: Map<string, number>;
}

export interface MyRelatedTimelineSeedCandidate {
  slotStartMs: number;
  frequencyContext?: SlotPackFrequencyContext;
  message: FrameDisplayMessage;
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
  | { type: 'replaceSessionContext'; payload: { nextContext: MyRelatedTimelineOperatorContext | null; forceRestart?: boolean } }
  | { type: 'freezeActiveSession' }
  | {
      type: 'seedSelectedRx';
      payload: {
        context: MyRelatedTimelineOperatorContext;
        currentMode: ModeDescriptor;
        message: FrameDisplayMessage;
        slotStartMs: number;
        frequencyContext?: SlotPackFrequencyContext;
      };
    }
  | { type: 'ingestSlotPack'; payload: { slotPack: SlotPack; currentMode: ModeDescriptor } }
  | { type: 'ingestTransmissionLog'; payload: { log: MyRelatedTransmissionLog; currentMode: ModeDescriptor } }
  | { type: 'beginRestore' }
  | {
      type: 'finalizeRestore';
      payload: {
        slotPacks: SlotPack[];
        currentMode: ModeDescriptor;
        context: MyRelatedTimelineOperatorContext | null;
        operatorCallsignsById: Record<string, string>;
      };
    }
  | { type: 'clearTimeline'; payload: { nextContext: MyRelatedTimelineOperatorContext | null } };

export const initialMyRelatedTimelineState: MyRelatedTimelineState = {
  globalTxGroups: [],
  committedRxGroups: [],
  committedRxMessageKeys: new Set<string>(),
  activeSession: null,
  pendingRestore: false,
  lastProcessedSlotPackSeq: new Map<string, number>(),
};

export function myRelatedTimelineReducer(
  state: MyRelatedTimelineState,
  action: MyRelatedTimelineAction,
): MyRelatedTimelineState {
  switch (action.type) {
    case 'replaceSessionContext': {
      const { nextContext, forceRestart = false } = action.payload;
      if (!nextContext) {
        return freezeIntoCommitted(state, null);
      }

      const activeSession = state.activeSession;
      const sameSessionIdentity = activeSession && sessionIdentityEquals(activeSession, nextContext);
      const sameFrequencyContext = activeSession && frequencyContextEquals(activeSession.frequencyContext, nextContext.frequencyContext);

      if (activeSession && canPromoteSessionTarget(activeSession, nextContext)) {
        return {
          ...state,
          activeSession: {
            ...activeSession,
            targetCallsign: nextContext.targetCallsign,
            frequencyContext: nextContext.frequencyContext ?? activeSession.frequencyContext,
          },
        };
      }

      if (sameSessionIdentity && sameFrequencyContext && !forceRestart) {
        return state;
      }

      return freezeIntoCommitted(
        state,
        shouldAutoStartSession(nextContext) ? createActiveSession(nextContext) : null,
      );
    }

    case 'freezeActiveSession':
      return freezeIntoCommitted(state, null);

    case 'seedSelectedRx': {
      const { context, currentMode, message, slotStartMs, frequencyContext } = action.payload;
      const needsRestart = !state.activeSession || !sessionIdentityEquals(state.activeSession, context);

      const nextState = needsRestart
        ? freezeIntoCommitted(state, createActiveSession(context))
        : state;

      if (!nextState.activeSession) {
        return nextState;
      }

      const messageKey = buildRxDisplayMessageKey(slotStartMs, message);
      return appendDisplayMessageToActiveSession(
        nextState,
        slotStartMs,
        currentMode,
        message,
        messageKey,
        context.headerContextKey,
        frequencyContext ?? context.frequencyContext,
      );
    }

    case 'ingestSlotPack': {
      const { slotPack, currentMode } = action.payload;
      const previousSeq = state.lastProcessedSlotPackSeq.get(slotPack.slotId) ?? -1;
      const incomingSeq = slotPack.stats?.updateSeq ?? 0;
      if (incomingSeq <= previousSeq) {
        return state;
      }

      let nextState: MyRelatedTimelineState = {
        ...state,
        lastProcessedSlotPackSeq: new Map(state.lastProcessedSlotPackSeq).set(slotPack.slotId, incomingSeq),
      };

      if (nextState.pendingRestore || !nextState.activeSession) {
        return nextState;
      }

      if (slotPack.startMs < nextState.activeSession.startedAtMs) {
        return nextState;
      }

      for (const frame of slotPack.frames) {
        if (frame.snr === -999) {
          continue;
        }
        if (!matchesSession(frame.message, nextState.activeSession)) {
          continue;
        }

        const messageKey = buildFrameMessageKey(frame, slotPack.startMs);
        nextState = appendDisplayMessageToActiveSession(
          nextState,
          slotPack.startMs,
          currentMode,
          frameToDisplayMessage(frame, slotPack.startMs),
          messageKey,
          nextState.activeSession.headerContextKey,
          slotPack.frequencyContext ?? nextState.activeSession.frequencyContext,
        );
      }

      return nextState;
    }

    case 'ingestTransmissionLog':
      return upsertGlobalTransmission(state, action.payload.log, action.payload.currentMode);

    case 'beginRestore':
      return {
        ...state,
        pendingRestore: true,
      };

    case 'finalizeRestore': {
      const { slotPacks, currentMode, context, operatorCallsignsById } = action.payload;
      if (!state.pendingRestore) {
        return state;
      }

      let nextState: MyRelatedTimelineState = {
        ...state,
        pendingRestore: false,
        lastProcessedSlotPackSeq: createProcessedSeqMap(state.lastProcessedSlotPackSeq, slotPacks),
      };

      for (const slotPack of slotPacks) {
        for (const frame of slotPack.frames) {
          if (frame.snr !== -999 || !frame.operatorId) {
            continue;
          }

          nextState = upsertGlobalTransmission(
            nextState,
            {
              operatorId: frame.operatorId,
              myCallsign: operatorCallsignsById[frame.operatorId] || undefined,
              headerContextKey: buildHeaderContextKey(slotPack.frequencyContext),
              time: new Date(slotPack.startMs).toISOString().slice(11, 19).replace(/:/g, ''),
              message: frame.message,
              frequency: Math.round(frame.freq),
              slotStartMs: slotPack.startMs,
              replaceExisting: true,
              frequencyContext: slotPack.frequencyContext,
            },
            currentMode,
          );
        }
      }

      if (!context?.myCallsign) {
        return nextState;
      }

      for (const slotPack of slotPacks) {
        for (const frame of slotPack.frames) {
          if (frame.snr === -999 || !matchesSession(frame.message, context)) {
            continue;
          }

          const messageKey = buildFrameMessageKey(frame, slotPack.startMs);
          if (nextState.committedRxMessageKeys.has(messageKey)) {
            continue;
          }

          nextState = appendCommittedRxDisplayMessage(
            nextState,
            slotPack.startMs,
            currentMode,
            frameToDisplayMessage(frame, slotPack.startMs),
            messageKey,
            context.headerContextKey,
            slotPack.frequencyContext ?? context.frequencyContext,
          );
        }
      }

      return nextState;
    }

    case 'clearTimeline':
      return {
        globalTxGroups: [],
        committedRxGroups: [],
        committedRxMessageKeys: new Set<string>(),
        activeSession: action.payload.nextContext && shouldAutoStartSession(action.payload.nextContext)
          ? createActiveSession(action.payload.nextContext)
          : null,
        pendingRestore: false,
        lastProcessedSlotPackSeq: state.lastProcessedSlotPackSeq,
      };

    default:
      return state;
  }
}

export function buildMyRelatedTimelineGroups(state: MyRelatedTimelineState): FrameGroup[] {
  return mergeGroups([
    ...state.globalTxGroups,
    ...state.committedRxGroups,
    ...(state.activeSession?.groups ?? []),
  ]);
}

export function findRecentSessionSeed(
  slotPacks: SlotPack[],
  context: Pick<MyRelatedTimelineOperatorContext, 'myCallsign' | 'targetCallsign' | 'startedAtMs'>,
  currentMode: ModeDescriptor,
): MyRelatedTimelineSeedCandidate | null {
  const maxLookbackMs = currentMode.slotMs * 2;
  const minStartMs = context.startedAtMs - maxLookbackMs;

  let bestCandidate: MyRelatedTimelineSeedCandidate | null = null;
  let bestScore = -1;

  for (const slotPack of slotPacks) {
    if (slotPack.startMs < minStartMs || slotPack.startMs > context.startedAtMs) {
      continue;
    }

    for (const frame of slotPack.frames) {
      if (frame.snr === -999) {
        continue;
      }

      const score = scoreSessionSeedFrame(frame, context);
      if (score < 0) {
        continue;
      }

      if (
        score > bestScore ||
        (score === bestScore && bestCandidate && slotPack.startMs > bestCandidate.slotStartMs) ||
        (score === bestScore && bestCandidate && slotPack.startMs === bestCandidate.slotStartMs && Math.round(frame.freq) > bestCandidate.message.freq)
      ) {
        bestScore = score;
        bestCandidate = {
          slotStartMs: slotPack.startMs,
          frequencyContext: slotPack.frequencyContext,
          message: frameToDisplayMessage(frame, slotPack.startMs),
        };
      }
    }
  }

  return bestCandidate;
}

function shouldAutoStartSession(context: MyRelatedTimelineOperatorContext): boolean {
  return context.myCallsign.trim().length > 0 && context.targetCallsign.trim().length > 0;
}

function createActiveSession(context: MyRelatedTimelineOperatorContext): MyRelatedTimelineActiveSession {
  return {
    ...context,
    groups: [],
    seenMessageKeys: new Set<string>(),
  };
}

function cloneActiveSession(session: MyRelatedTimelineActiveSession): MyRelatedTimelineActiveSession {
  return {
    ...session,
    groups: session.groups.map(group => ({
      ...group,
      messages: [...group.messages],
      ...(group.frequencyContext ? { frequencyContext: { ...group.frequencyContext } } : {}),
    })),
    seenMessageKeys: new Set(session.seenMessageKeys),
    ...(session.frequencyContext ? { frequencyContext: { ...session.frequencyContext } } : {}),
  };
}

function freezeIntoCommitted(
  state: MyRelatedTimelineState,
  nextActiveSession: MyRelatedTimelineActiveSession | null,
): MyRelatedTimelineState {
  const activeSession = state.activeSession;
  if (!activeSession || activeSession.groups.length === 0) {
    return {
      ...state,
      activeSession: nextActiveSession,
    };
  }

  const committedRxMessageKeys = new Set(state.committedRxMessageKeys);
  let committedRxGroups = state.committedRxGroups;

  for (const group of activeSession.groups) {
    for (const message of group.messages) {
      const messageKey = buildRxDisplayMessageKey(group.startMs, message);
      if (committedRxMessageKeys.has(messageKey)) {
        continue;
      }
      committedRxMessageKeys.add(messageKey);
      committedRxGroups = appendExistingGroupMessage(
        committedRxGroups,
        group,
        message,
        group.frequencyContext ?? activeSession.frequencyContext,
      );
    }
  }

  return {
    ...state,
    committedRxGroups: trimGroups(committedRxGroups),
    committedRxMessageKeys,
    activeSession: nextActiveSession,
  };
}

function appendCommittedRxDisplayMessage(
  state: MyRelatedTimelineState,
  slotStartMs: number,
  currentMode: ModeDescriptor,
  message: FrameDisplayMessage,
  messageKey: string,
  headerContextKey: string,
  frequencyContext?: SlotPackFrequencyContext,
): MyRelatedTimelineState {
  const committedRxMessageKeys = new Set(state.committedRxMessageKeys);
  committedRxMessageKeys.add(messageKey);
  return {
    ...state,
    committedRxGroups: trimGroups(
      appendMessageToGroups(
        state.committedRxGroups,
        slotStartMs,
        currentMode.slotMs,
        message,
        headerContextKey,
        frequencyContext,
      ),
    ),
    committedRxMessageKeys,
  };
}

function appendExistingGroupMessage(
  groups: FrameGroup[],
  sourceGroup: FrameGroup,
  message: FrameDisplayMessage,
  frequencyContext?: SlotPackFrequencyContext,
): FrameGroup[] {
  const groupKey = getGroupIdentityKey(sourceGroup.startMs, sourceGroup.frequencyContext ?? frequencyContext);
  const nextGroups = groups.slice();
  const existingIndex = nextGroups.findIndex(group => getGroupIdentityKey(group.startMs, group.frequencyContext) === groupKey);

  if (existingIndex === -1) {
    return mergeGroups([
      ...nextGroups,
      {
        ...sourceGroup,
        messages: [message],
        ...(frequencyContext && !sourceGroup.frequencyContext ? { frequencyContext } : {}),
      },
    ]);
  }

  const existingGroup = nextGroups[existingIndex]!;
  nextGroups[existingIndex] = {
    ...existingGroup,
    messages: mergeMessages(existingGroup.messages, [message]),
    type: existingGroup.messages.some(item => item.db === 'TX') || message.db === 'TX' ? 'transmit' : 'receive',
    headerContextKey: existingGroup.headerContextKey || sourceGroup.headerContextKey,
    frequencyContext: existingGroup.frequencyContext ?? frequencyContext,
  };

  return mergeGroups(nextGroups);
}

function appendDisplayMessageToActiveSession(
  state: MyRelatedTimelineState,
  slotStartMs: number,
  currentMode: ModeDescriptor,
  message: FrameDisplayMessage,
  messageKey: string,
  headerContextKey: string,
  frequencyContext?: SlotPackFrequencyContext,
): MyRelatedTimelineState {
  const activeSession = state.activeSession;
  if (!activeSession) {
    return state;
  }

  if (state.committedRxMessageKeys.has(messageKey)) {
    return state;
  }

  const nextActiveSession = cloneActiveSession(activeSession);
  nextActiveSession.seenMessageKeys.add(messageKey);
  nextActiveSession.groups = appendMessageToGroups(
    nextActiveSession.groups,
    slotStartMs,
    currentMode.slotMs,
    message,
    headerContextKey,
    frequencyContext ?? nextActiveSession.frequencyContext,
  );

  return {
    ...state,
    activeSession: nextActiveSession,
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
  const alignedMs = Math.floor(slotStartMs / slotMs) * slotMs;
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
    frequencyContext: existingGroup.frequencyContext ?? frequencyContext,
  };

  return mergeGroups(nextGroups);
}

function upsertGlobalTransmission(
  state: MyRelatedTimelineState,
  log: MyRelatedTransmissionLog,
  currentMode: ModeDescriptor,
): MyRelatedTimelineState {
  return {
    ...state,
    globalTxGroups: trimGroups(
      upsertTransmissionGroupMessage(
        removeTransmissionMessageFromGroups(state.globalTxGroups, log.operatorId, log.slotStartMs),
        log,
        currentMode,
        log.frequencyContext,
      ),
    ),
  };
}

function upsertTransmissionGroupMessage(
  groups: FrameGroup[],
  log: MyRelatedTransmissionLog,
  currentMode: ModeDescriptor,
  frequencyContext?: SlotPackFrequencyContext,
): FrameGroup[] {
  const alignedMs = Math.floor(log.slotStartMs / currentMode.slotMs) * currentMode.slotMs;
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
    frequencyContext: existingGroup.frequencyContext ?? frequencyContext,
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
      frequencyContext: existing.frequencyContext ?? group.frequencyContext,
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

function matchesSession(
  message: string,
  context: Pick<MyRelatedTimelineOperatorContext, 'myCallsign' | 'targetCallsign'>,
): boolean {
  return containsCallsign(message, context.myCallsign) || containsCallsign(message, context.targetCallsign);
}

function scoreSessionSeedFrame(
  frame: FrameMessage,
  context: Pick<MyRelatedTimelineOperatorContext, 'myCallsign' | 'targetCallsign'>,
): number {
  const myCallsign = context.myCallsign.trim().toUpperCase();
  const targetCallsign = context.targetCallsign.trim().toUpperCase();
  if (!myCallsign || !targetCallsign) {
    return -1;
  }

  try {
    const parsed = FT8MessageParser.parseMessage(frame.message);
    switch (parsed.type) {
      case 'call':
      case 'signal_report':
      case 'roger_report':
      case 'rrr':
      case '73': {
        const sender = parsed.senderCallsign?.toUpperCase();
        const target = parsed.targetCallsign?.toUpperCase();
        return sender === targetCallsign && target === myCallsign ? 2 : -1;
      }
      case 'cq':
        return parsed.senderCallsign?.toUpperCase() === targetCallsign ? 1 : -1;
      default:
        return -1;
    }
  } catch {
    return -1;
  }
}

function containsCallsign(message: string, callsign: string): boolean {
  const normalizedCallsign = callsign.trim();
  if (!normalizedCallsign) {
    return false;
  }

  return message.includes(normalizedCallsign) ||
    message.startsWith(`${normalizedCallsign} `) ||
    message.includes(` ${normalizedCallsign} `) ||
    message.endsWith(` ${normalizedCallsign}`);
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

function removeTransmissionMessageFromGroups(
  groups: FrameGroup[],
  operatorId: string,
  slotStartMs: number,
): FrameGroup[] {
  const nextGroups: FrameGroup[] = [];

  for (const group of groups) {
    if (group.startMs !== slotStartMs) {
      nextGroups.push(group);
      continue;
    }

    const nextMessages = group.messages.filter(message => !(message.db === 'TX' && message.operatorId === operatorId));
    if (nextMessages.length === 0) {
      continue;
    }

    nextGroups.push({
      ...group,
      messages: mergeMessages([], nextMessages),
      type: nextMessages.some(message => message.db === 'TX') ? 'transmit' : 'receive',
    });
  }

  return mergeGroups(nextGroups);
}

function getGroupIdentityKey(startMs: number, frequencyContext?: SlotPackFrequencyContext): string {
  return [
    startMs,
    frequencyContext?.frequency ?? '',
    frequencyContext?.band ?? '',
    frequencyContext?.mode ?? '',
    frequencyContext?.radioMode ?? '',
  ].join(':');
}

function sessionIdentityEquals(
  left: Pick<MyRelatedTimelineOperatorContext, 'operatorId' | 'myCallsign' | 'targetCallsign'>,
  right: Pick<MyRelatedTimelineOperatorContext, 'operatorId' | 'myCallsign' | 'targetCallsign'>,
): boolean {
  return left.operatorId === right.operatorId &&
    left.myCallsign === right.myCallsign &&
    left.targetCallsign === right.targetCallsign;
}

function frequencyContextEquals(
  left?: SlotPackFrequencyContext,
  right?: SlotPackFrequencyContext,
): boolean {
  return (left?.frequency ?? null) === (right?.frequency ?? null) &&
    (left?.band ?? '') === (right?.band ?? '') &&
    (left?.mode ?? '') === (right?.mode ?? '') &&
    (left?.radioMode ?? '') === (right?.radioMode ?? '') &&
    (left?.description ?? '') === (right?.description ?? '');
}

function canPromoteSessionTarget(
  session: MyRelatedTimelineActiveSession,
  context: MyRelatedTimelineOperatorContext,
): boolean {
  return session.operatorId === context.operatorId &&
    session.myCallsign === context.myCallsign &&
    !session.targetCallsign.trim() &&
    !!context.targetCallsign.trim() &&
    frequencyContextEquals(session.frequencyContext, context.frequencyContext);
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
