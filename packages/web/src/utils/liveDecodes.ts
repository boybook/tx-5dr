import type { LogbookLiveDecode, LogbookLiveDecodesUpdate } from '@tx5dr/contracts';
import {
  HighlightType,
  resolveHighestPriorityHighlight,
  type DisplayNotificationSettings,
} from './displayNotificationSettings';

/**
 * Stations heard in the latest receive slots, for the logbook globe.
 *
 * The layer answers one question at the end of every slot: is there a station
 * I need that I can call right now? Each station therefore gets a tier:
 * 1. needed and calling CQ in the current cycle: the actionable ones;
 * 2. needed, but busy with someone else or no longer fresh;
 * 3. calling CQ, but not needed;
 * 4. everything else, background that shows where the band is open.
 * "Needed" is decided exactly as the decode table highlights a row.
 */

/** Two FT8/FT4 cycles of receive slots. */
export const LIVE_DECODE_SLOTS = 4;
/** A station heard within one cycle (either period) can still be answered. */
const FRESH_SLOT_AGE = 1;

export interface LiveDecodeView {
  operatorId: string;
  band?: string;
  slotMs: number;
  /** Newest slot first. */
  slots: LogbookLiveDecodesUpdate[];
}

/**
 * Adds or replaces a slot. A band or operator change starts a new view: the
 * old band's stations are not on air here any more.
 */
export function applyLiveDecodesUpdate(previous: LiveDecodeView | null, update: LogbookLiveDecodesUpdate): LiveDecodeView {
  const sameView = previous
    && previous.operatorId === update.operatorId
    && (previous.band ?? '') === (update.band ?? '');
  const others = sameView ? previous.slots.filter(slot => slot.slotId !== update.slotId) : [];
  const slots = [...others, update]
    .sort((left, right) => right.slotStartMs - left.slotStartMs);
  const newest = slots[0]?.slotStartMs ?? update.slotStartMs;
  const oldest = newest - (LIVE_DECODE_SLOTS - 1) * update.slotMs;
  return {
    operatorId: update.operatorId,
    band: update.band,
    slotMs: update.slotMs,
    slots: slots.filter(slot => slot.slotStartMs >= oldest),
  };
}

export type LiveStationTier = 1 | 2 | 3 | 4;

export interface LiveStation {
  callsign: string;
  decode: LogbookLiveDecode;
  slotStartMs: number;
  /** Receive slots since this station was last heard; 0 is the current one. */
  ageSlots: number;
  isCq: boolean;
  highlight: HighlightType | null;
  /** Highlight colour from the decode table settings; null when not needed. */
  color: string | null;
  tier: LiveStationTier;
  lat: number;
  lng: number;
  approximate: boolean;
}

/** Fades a station out over the window, keeping the current cycle at full strength. */
export function getLiveStationOpacity(ageSlots: number): number {
  if (ageSlots <= FRESH_SLOT_AGE) return 1;
  if (ageSlots === 2) return 0.6;
  return 0.35;
}

export function buildLiveStations(
  view: LiveDecodeView | null,
  now: number,
  settings: DisplayNotificationSettings,
  /** Current QSO partners; the in-progress arc already marks them. */
  excludedCallsigns: ReadonlySet<string> = new Set(),
): LiveStation[] {
  if (!view || view.slots.length === 0) return [];
  // A slot's decodes arrive during the next slot, so the slot before the
  // current period is the newest one. Counting periods up to now lets a
  // quiet band still fade.
  const newest = view.slots[0].slotStartMs;
  const elapsed = Math.max(0, now - newest);
  const currentSlotStart = Math.max(newest, newest + (Math.floor(elapsed / view.slotMs) - 1) * view.slotMs);
  const stations = new Map<string, LiveStation>();
  // Newest first: the first decode seen of a station is its latest.
  for (const slot of view.slots) {
    const ageSlots = Math.max(0, Math.round((currentSlotStart - slot.slotStartMs) / view.slotMs));
    if (ageSlots >= LIVE_DECODE_SLOTS) continue;
    for (const decode of slot.decodes) {
      if (stations.has(decode.callsign) || excludedCallsigns.has(decode.callsign)) continue;
      if (!decode.location) continue;
      const highlight = decode.analysis
        ? resolveHighestPriorityHighlight(decode.analysis, settings)
        : null;
      const isCq = decode.messageType === 'cq';
      const fresh = ageSlots <= FRESH_SLOT_AGE;
      const needed = highlight !== null;
      const tier: LiveStationTier = needed && isCq && fresh ? 1 : needed ? 2 : isCq ? 3 : 4;
      stations.set(decode.callsign, {
        callsign: decode.callsign,
        decode,
        slotStartMs: slot.slotStartMs,
        ageSlots,
        isCq,
        highlight,
        color: highlight ? settings.highlights[highlight].color : null,
        tier,
        lat: decode.location.lat,
        lng: decode.location.lng,
        approximate: decode.location.precision === 'entity',
      });
    }
  }
  return Array.from(stations.values());
}

/** Great-circle distance (km) and initial short-path bearing (degrees from north). */
export function getDistanceAndBearing(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): { distanceKm: number; bearingDeg: number } {
  const rad = Math.PI / 180;
  const lat1 = from.lat * rad;
  const lat2 = to.lat * rad;
  const dLng = (to.lng - from.lng) * rad;
  const a = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearingDeg = ((Math.atan2(y, x) / rad) + 360) % 360;
  return { distanceKm, bearingDeg };
}
