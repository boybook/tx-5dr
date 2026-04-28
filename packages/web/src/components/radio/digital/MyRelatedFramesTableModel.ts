import type { FrameMessage, ModeDescriptor, SlotPack } from '@tx5dr/contracts';
import { CycleUtils, parseFT8LocationInfo } from '@tx5dr/core';
import type { FrameDisplayMessage, FrameGroup } from './FramesTable';

export interface TransmissionLog {
  time: string;
  message: string;
  frequency: number;
  operatorId: string;
  slotStartMs: number;
  replaceExisting?: boolean;
}

export interface MyRelatedOperatorInfo {
  myCallsign: string;
}

interface GroupAccumulator {
  messages: FrameDisplayMessage[];
  cycle: 'even' | 'odd';
  hasTransmission: boolean;
  alignedMs: number;
}

interface BuildMyRelatedFrameGroupsParams {
  slotPacks: SlotPack[];
  transmissionLogs: TransmissionLog[];
  operators: MyRelatedOperatorInfo[];
  targetCallsigns: string[];
  myTransmitCycles: number[];
  currentMode: ModeDescriptor;
  currentGroupKey: string;
  recentSlotGroupKeys: string[];
}

export function getTransmissionIdentity(operatorId: string, slotStartMs: number): string {
  return `${operatorId}:${slotStartMs}`;
}

export function upsertTransmissionLog(prev: TransmissionLog[], data: TransmissionLog): TransmissionLog[] {
  const nextKey = getTransmissionIdentity(data.operatorId, data.slotStartMs);
  const idx = prev.findIndex(log => getTransmissionIdentity(log.operatorId, log.slotStartMs) === nextKey);

  if (idx >= 0) {
    if (
      prev[idx]?.message === data.message &&
      prev[idx]?.frequency === data.frequency &&
      prev[idx]?.time === data.time &&
      prev[idx]?.replaceExisting === data.replaceExisting
    ) {
      return prev;
    }

    const updated = [...prev];
    updated[idx] = data;
    return updated;
  }

  return [...prev, data];
}

export function buildMyRelatedFrameGroups({
  slotPacks,
  transmissionLogs,
  operators,
  targetCallsigns,
  myTransmitCycles,
  currentMode,
  currentGroupKey,
  recentSlotGroupKeys,
}: BuildMyRelatedFrameGroupsParams): FrameGroup[] {
  const visibleGroupKeys = new Set([currentGroupKey, ...recentSlotGroupKeys]);
  const groupsMap = new Map<string, GroupAccumulator>();
  const txLogsByIdentity = new Map<string, TransmissionLog>();
  const emittedTxFrameIdentities = new Set<string>();

  for (const log of transmissionLogs) {
    txLogsByIdentity.set(getTransmissionIdentity(log.operatorId, log.slotStartMs), log);
  }

  for (const slotPack of slotPacks) {
    const slotGroupKey = CycleUtils.generateSlotGroupKey(slotPack.startMs, currentMode.slotMs);
    if (!visibleGroupKeys.has(slotGroupKey)) {
      continue;
    }

    for (const frame of slotPack.frames) {
      const txIdentity = getFrameTransmissionIdentity(frame, slotPack.startMs);
      if (txIdentity) {
        if (txLogsByIdentity.has(txIdentity) || emittedTxFrameIdentities.has(txIdentity)) {
          continue;
        }
        emittedTxFrameIdentities.add(txIdentity);
      }

      if (!isRelevantMessage(frame.message, operators, targetCallsigns)) {
        continue;
      }

      const cycleNumber = CycleUtils.calculateCycleNumberFromMs(slotPack.startMs, currentMode.slotMs);
      const group = getOrCreateGroup(groupsMap, slotPack.startMs, currentMode.slotMs);
      group.messages.push(frameToDisplayMessage(frame, slotPack.startMs));

      if (myTransmitCycles.includes(cycleNumber)) {
        group.hasTransmission = true;
      }
    }
  }

  for (const log of txLogsByIdentity.values()) {
    const logGroupKey = CycleUtils.generateSlotGroupKey(log.slotStartMs, currentMode.slotMs);
    if (!visibleGroupKeys.has(logGroupKey)) {
      continue;
    }

    const group = getOrCreateGroup(groupsMap, log.slotStartMs, currentMode.slotMs);
    group.hasTransmission = true;
    group.messages.push(transmissionLogToDisplayMessage(log));
  }

  return Array.from(groupsMap.entries())
    .map(([time, { messages, cycle, hasTransmission, alignedMs }]) => ({
      time,
      startMs: alignedMs,
      messages: messages.sort((a, b) => a.utc.localeCompare(b.utc)),
      type: hasTransmission ? 'transmit' as const : 'receive' as const,
      cycle,
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

function getFrameTransmissionIdentity(frame: FrameMessage, slotStartMs: number): string | null {
  if (frame.snr !== -999 || !frame.operatorId) {
    return null;
  }

  return getTransmissionIdentity(frame.operatorId, slotStartMs);
}

function isRelevantMessage(
  message: string,
  operators: MyRelatedOperatorInfo[],
  targetCallsigns: string[],
): boolean {
  return operators.some(({ myCallsign }) =>
    message.includes(myCallsign) ||
    message.startsWith(`${myCallsign} `) ||
    message.includes(` ${myCallsign} `) ||
    message.endsWith(` ${myCallsign}`)
  ) || targetCallsigns.some(targetCall =>
    targetCall && message.includes(targetCall)
  );
}

function getOrCreateGroup(
  groupsMap: Map<string, GroupAccumulator>,
  startMs: number,
  slotMs: number,
): GroupAccumulator {
  const groupKey = CycleUtils.generateSlotGroupKey(startMs, slotMs);
  const existingGroup = groupsMap.get(groupKey);
  if (existingGroup) {
    return existingGroup;
  }

  const cycleNumber = CycleUtils.calculateCycleNumberFromMs(startMs, slotMs);
  const alignedMs = Math.floor(startMs / slotMs) * slotMs;
  const group: GroupAccumulator = {
    messages: [],
    cycle: CycleUtils.isEvenCycle(cycleNumber) ? 'even' : 'odd',
    hasTransmission: false,
    alignedMs,
  };
  groupsMap.set(groupKey, group);
  return group;
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

function transmissionLogToDisplayMessage(log: TransmissionLog): FrameDisplayMessage {
  return {
    utc: log.time.slice(0, 2) + ':' + log.time.slice(2, 4) + ':' + log.time.slice(4, 6),
    db: 'TX',
    dt: '-',
    freq: log.frequency,
    message: log.message,
  };
}
