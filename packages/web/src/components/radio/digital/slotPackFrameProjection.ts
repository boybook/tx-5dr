import type { SlotPack } from '@tx5dr/contracts';
import {
  CycleUtils, FT8MessageParser, evaluateCallsignFilter, evaluateDxccBlocklist,
  parseFT8LocationInfo, resolveGridLocation, type CallsignFilterRule,
} from '@tx5dr/core';
import type { FrameDisplayMessage, FrameGroup } from './FramesTable';

interface ProjectionOptions {
  slotMs: number;
  filterRules: CallsignFilterRule[];
  dxccBlockEnabled: boolean;
  blockedDxccEntityCodes: string[];
}

/** A projection belongs to one mode/filter configuration, never to a radio session. */
export function createSlotPackFrameProjector(options: ProjectionOptions) {
  const cache = new WeakMap<SlotPack, FrameGroup | null>();

  function projectPack(pack: SlotPack): FrameGroup | null {
    if (cache.has(pack)) return cache.get(pack)!;
    const utc = new Date(pack.startMs).toISOString().slice(11, 19);
    const messages: FrameDisplayMessage[] = [];
    for (const frame of pack.frames) {
      if (frame.snr === -999) continue;
      if (options.filterRules.length > 0 || options.dxccBlockEnabled) {
        const parsed = FT8MessageParser.parseMessage(frame.message);
        const sender = frame.logbookAnalysis?.callsign
          ?? (parsed && 'senderCallsign' in parsed ? parsed.senderCallsign : undefined)
          ?? '';
        if (options.filterRules.length > 0 && sender && !evaluateCallsignFilter(sender, options.filterRules)) continue;
        if (!evaluateDxccBlocklist({
          dxccBlockEnabled: options.dxccBlockEnabled,
          blockedDxccEntityCodes: options.blockedDxccEntityCodes,
          dxccId: frame.logbookAnalysis?.dxccId,
          callsign: sender,
        })) continue;
      }
      const location = parseFT8LocationInfo(frame.message);
      messages.push({
        utc, db: frame.snr, dt: frame.dt, freq: Math.round(frame.freq), message: frame.message,
        ...(location.callsign && { locationCallsign: location.callsign }),
        ...(location.country && { country: location.country }),
        ...(location.countryZh && { countryZh: location.countryZh }),
        ...(location.countryEn && { countryEn: location.countryEn }),
        ...(location.countryCode && { countryCode: location.countryCode }),
        ...(location.flag && { flag: location.flag }),
        ...(location.grid && {
          locationGrid: location.grid,
          gridLocation: resolveGridLocation(location.grid, { ...location, callsign: location.callsign ?? '' }),
        }),
        ...(location.state && { state: location.state }),
        ...(location.stateConfidence && { stateConfidence: location.stateConfidence }),
        ...(frame.logbookAnalysis && { logbookAnalysis: frame.logbookAnalysis }),
      });
    }
    const group: FrameGroup | null = messages.length === 0 ? null : {
      time: CycleUtils.generateSlotGroupKey(pack.startMs, options.slotMs),
      startMs: Math.floor(pack.startMs / options.slotMs) * options.slotMs,
      messages,
      type: 'receive',
      cycle: CycleUtils.isEvenCycle(CycleUtils.calculateCycleNumberFromMs(pack.startMs, options.slotMs)) ? 'even' : 'odd',
      frequencyContext: pack.frequencyContext,
    };
    cache.set(pack, group);
    return group;
  }

  return (packs: SlotPack[]): FrameGroup[] => {
    if (options.slotMs <= 0) return [];
    const groups = new Map<string, FrameGroup>();
    for (const pack of packs) {
      const group = projectPack(pack);
      if (!group) continue;
      const previous = groups.get(group.time);
      groups.set(group.time, previous ? {
        ...previous,
        messages: [...previous.messages, ...group.messages].sort((a, b) => a.utc.localeCompare(b.utc)),
      } : group);
    }
    return [...groups.values()].sort((a, b) => a.startMs - b.startMs);
  };
}
