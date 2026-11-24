import { FT8MessageParser, gridToCoordinates, resolveDXCCEntity } from '@tx5dr/core';
import type {
  LogbookLiveDecode,
  LogbookLiveDecodesUpdate,
  LogbookLiveLocation,
  SlotPack,
} from '@tx5dr/contracts';

/** Receive slots kept for a newly opened page: two FT8/FT4 cycles. */
export const LOGBOOK_LIVE_RECENT_SLOTS = 4;

export interface LogbookLiveDecodeFeedDeps {
  /** Frames analysed against the operator's logbook (worked before, new DXCC, ...). */
  projectSlotPack(slotPack: SlotPack, operatorId: string): Promise<SlotPack>;
  /** The operator's own callsigns; their transmissions are not shown as heard. */
  getOperatorCallsigns(operatorId: string): string[];
  getActiveSlotPacks(): SlotPack[];
}

/**
 * Where a station is drawn: its locator when known, otherwise the centre of
 * its DXCC entity, marked approximate.
 */
export function locateLiveStation(callsign: string, grid?: string): LogbookLiveLocation | undefined {
  const gridCoordinates = grid ? gridToCoordinates(grid) : null;
  if (gridCoordinates) {
    return { lat: gridCoordinates.lat, lng: gridCoordinates.lon, precision: 'grid' };
  }
  const entity = resolveDXCCEntity(callsign).entity;
  if (entity && Number.isFinite(entity.latitude) && Number.isFinite(entity.longitude)) {
    // CTY data gives longitude positive to the west.
    return { lat: entity.latitude as number, lng: -(entity.longitude as number), precision: 'entity' };
  }
  return undefined;
}

/** Heard stations of one projected slot; own transmissions and unparsable frames are left out. */
export function buildLiveDecodes(slotPack: SlotPack, ownCallsigns: ReadonlySet<string>): LogbookLiveDecode[] {
  const byCallsign = new Map<string, LogbookLiveDecode>();
  for (const frame of slotPack.frames) {
    // -999 marks this station's own transmitted frames.
    if (frame.snr === -999) continue;
    let parsed: ReturnType<typeof FT8MessageParser.parseMessage>;
    try {
      parsed = FT8MessageParser.parseMessage(frame.message);
    } catch {
      continue;
    }
    const callsign = 'senderCallsign' in parsed && typeof parsed.senderCallsign === 'string'
      ? parsed.senderCallsign.toUpperCase()
      : undefined;
    if (!callsign || ownCallsigns.has(callsign)) continue;

    const messageGrid = 'grid' in parsed && typeof parsed.grid === 'string' ? parsed.grid : undefined;
    const grid = frame.logbookAnalysis?.grid ?? messageGrid;
    const decode: LogbookLiveDecode = {
      callsign,
      message: frame.message,
      messageType: parsed.type,
      targetCallsign: 'targetCallsign' in parsed && typeof parsed.targetCallsign === 'string'
        ? parsed.targetCallsign.toUpperCase()
        : undefined,
      snr: frame.snr,
      dt: frame.dt,
      freq: frame.freq,
      location: locateLiveStation(callsign, grid),
      analysis: frame.logbookAnalysis,
    };
    // One entry per station and slot; a later decode window wins.
    byCallsign.set(callsign, decode);
  }
  return Array.from(byCallsign.values());
}

/** Turns receive slots into live decode updates for logbook pages. */
export class LogbookLiveDecodeFeed {
  constructor(private readonly deps: LogbookLiveDecodeFeedDeps) {}

  async buildUpdate(slotPack: SlotPack, operatorId: string): Promise<LogbookLiveDecodesUpdate> {
    const projected = await this.deps.projectSlotPack(slotPack, operatorId);
    const ownCallsigns = new Set(this.deps.getOperatorCallsigns(operatorId).map(call => call.toUpperCase()));
    return {
      operatorId,
      slotId: slotPack.slotId,
      slotStartMs: slotPack.startMs,
      slotMs: Math.max(1, slotPack.endMs - slotPack.startMs),
      mode: slotPack.frequencyContext?.mode,
      band: slotPack.frequencyContext?.band,
      frequency: slotPack.frequencyContext?.frequency,
      decodes: buildLiveDecodes(projected, ownCallsigns),
    };
  }

  /** The latest receive slots with decodes, oldest first, for a page that just connected. */
  getRecentSlotPacks(): SlotPack[] {
    return this.deps.getActiveSlotPacks()
      .filter(slotPack => slotPack.frames.some(frame => frame.snr !== -999))
      .sort((left, right) => left.startMs - right.startMs)
      .slice(-LOGBOOK_LIVE_RECENT_SLOTS);
  }
}
