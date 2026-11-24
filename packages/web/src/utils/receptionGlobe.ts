import type {
  PSKReporterReceptionSpot,
  PSKReporterReceptionState,
  PSKReporterReceptionUpdate,
} from '@tx5dr/contracts';
import { gridToCoordinates } from '@tx5dr/core';
import { DEFAULT_RECEPTION_THEME, type ReceptionTheme } from './receptionThemes';

/**
 * Reception feedback on the logbook globe.
 *
 * Reports reach PSK Reporter in receiver batches, often one to three minutes
 * after the transmission. Brightness therefore follows the age of the heard
 * transmission, not the arrival time: a report stays at full brightness for the
 * first minutes, so a late batch still reads as "this transmission", and an old
 * report arrives already dimmed instead of posing as live.
 */
export const RECEPTION_FULL_BRIGHTNESS_MS = 5 * 60 * 1000;
/** A current QSO target heard within this period is marked as hearing us. */
export const RECEPTION_TARGET_HEARD_MS = 5 * 60 * 1000;
const MAX_VIEW_SPOTS = 3000;
/**
 * The glow is a kernel density over ~40k vertices per point, computed on the
 * CPU where WebGPU is missing. Weights are quantised so the periodic freshness
 * refresh does not recompute it for invisible changes, and the point count is
 * capped to the warmest areas.
 */
const HEAT_WEIGHT_STEP = 0.05;
const MAX_HEAT_POINTS = 300;
/**
 * Receivers are pooled into areas about as wide as the glow's kernel, so the
 * glow shows how well each area hears rather than how many receivers it holds.
 */
const HEAT_AREA_DEGREES = 4;
/** Freshness-weighted receiver count at which an area's count factor reaches 1. */
const HEAT_REFERENCE_RECEIVERS = 8;
/**
 * Area weight drawn at the full glow, about eight receivers hearing us at
 * -6 dB. The glow layer normalises to its strongest area, so without this a
 * lone marginal receiver would glow as brightly as a well-covered continent.
 */
const HEAT_FULL_WEIGHT = 0.75;
/** Dimmest the strongest area is drawn, so weak coverage stays visible. */
const HEAT_MIN_SCALE = 0.35;
/** Quality assumed for a report without SNR: an ordinary, not a marginal, decode. */
const HEAT_UNKNOWN_SNR_QUALITY = 0.5;
const EARTH_RADIUS_KM = 6371;

export interface ReceptionView {
  state: PSKReporterReceptionState;
  callsigns: string[];
  windowMs: number;
  spots: PSKReporterReceptionSpot[];
}

/**
 * Brightness of the glow as a whole, from its strongest area's absolute weight:
 * multiplies the layer's normalised density before colouring. Quantised so it
 * changes only with visible differences.
 */
export function getReceptionHeatScale(points: readonly ReceptionHeatPoint[]): number {
  const strongest = points.reduce((max, point) => Math.max(max, point.weight), 0);
  const scale = Math.min(1, Math.max(HEAT_MIN_SCALE, strongest / HEAT_FULL_WEIGHT));
  return Math.round(scale / HEAT_WEIGHT_STEP) * HEAT_WEIGHT_STEP;
}

/** Applies a pushed update; spots outside the window are dropped. */
export function applyReceptionUpdate(
  previous: ReceptionView | null,
  update: PSKReporterReceptionUpdate,
  now: number,
): ReceptionView {
  const sameFollow = previous && previous.callsigns.join(',') === update.callsigns.join(',');
  const base = update.kind === 'append' && sameFollow ? previous.spots : [];
  const byId = new Map(base.map(spot => [spot.id, spot]));
  for (const spot of update.spots) {
    byId.set(spot.id, spot);
  }
  const oldest = now - update.windowMs;
  const spots = Array.from(byId.values())
    .filter(spot => spot.transmittedAt >= oldest)
    .sort((left, right) => left.transmittedAt - right.transmittedAt)
    .slice(-MAX_VIEW_SPOTS);
  return { state: update.state, callsigns: update.callsigns, windowMs: update.windowMs, spots };
}

export function escapeGlobeLabelText(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[character] ?? character);
}

/** Identity of a heat point set; equal signatures render the same glow. */
export function getReceptionHeatSignature(points: readonly ReceptionHeatPoint[]): string {
  return points.map(point => `${point.lat.toFixed(2)},${point.lng.toFixed(2)},${point.weight.toFixed(2)}`).join(';');
}

export function getReceptionFreshness(ageMs: number, windowMs: number): number {
  if (ageMs <= RECEPTION_FULL_BRIGHTNESS_MS) return 1;
  const fadeMs = Math.max(1, windowMs - RECEPTION_FULL_BRIGHTNESS_MS);
  return Math.max(0, 1 - (ageMs - RECEPTION_FULL_BRIGHTNESS_MS) / fadeMs);
}

export interface ReceptionStation {
  callsign: string;
  locator: string;
  lat: number;
  lng: number;
  mode: string;
  frequency?: number;
  snr?: number;
  /** Latest heard transmission of this receiver. */
  transmittedAt: number;
  reportedAt: number;
  /** Source of the latest report. */
  source: PSKReporterReceptionSpot['source'];
  reportCount: number;
  freshness: number;
  distanceKm?: number;
}

export interface ReceptionGlobePoint {
  kind: 'reception';
  lat: number;
  lng: number;
  size: number;
  color: string;
  station: ReceptionStation;
}

export interface ReceptionPingRing {
  id: string;
  lat: number;
  lng: number;
  color: string[];
  maxRadius: number;
  propagationSpeed: number;
  repeatPeriod: number;
}

export interface ReceptionHeatPoint {
  lat: number;
  lng: number;
  weight: number;
}

export interface ReceptionGlobeModel {
  /** Heard stations inside the window, nearest first. */
  stations: ReceptionStation[];
  points: ReceptionGlobePoint[];
  /** Weighted receiver positions for the coverage glow. */
  heatPoints: ReceptionHeatPoint[];
  /** Rings on current QSO targets that recently heard this station. */
  targetRings: ReceptionPingRing[];
  farthest: ReceptionStation | null;
  latestReportAt?: number;
}

function haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Three steps only; brightness already carries time. */
function getReceptionPointSize(snr: number | undefined): number {
  if (snr === undefined) return 0.32;
  if (snr >= -10) return 0.42;
  if (snr >= -18) return 0.34;
  return 0.27;
}

/**
 * How well a receiver hears us, from its typical SNR: linear in dB from about
 * 0.1 at the FT8 decode floor (-24 dB) to 1 at 0 dB and above.
 */
export function getReceptionSignalQuality(snr: number | undefined): number {
  if (snr === undefined || !Number.isFinite(snr)) return HEAT_UNKNOWN_SNR_QUALITY;
  return Math.min(1, Math.max(0.1, (snr + 26) / 26));
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Key of the roughly equal-area cell, about HEAT_AREA_DEGREES wide, holding a point. */
function getHeatAreaKey(lat: number, lng: number): string {
  const row = Math.min(Math.floor((lat + 90) / HEAT_AREA_DEGREES), Math.ceil(180 / HEAT_AREA_DEGREES) - 1);
  const rowCenterLat = -90 + (row + 0.5) * HEAT_AREA_DEGREES;
  const columns = Math.max(1, Math.round((360 * Math.cos(rowCenterLat * Math.PI / 180)) / HEAT_AREA_DEGREES));
  const column = Math.min(columns - 1, Math.floor(((((lng + 180) % 360) + 360) % 360) / (360 / columns)));
  return `${row}:${column}`;
}

/**
 * One heat point per area, weighted by both how many receivers hear us there
 * and how well they do: the freshness-weighted mean signal quality times a
 * logarithmic receiver count. A few strong receivers outweigh a crowd of
 * marginal decodes; more receivers still warm an area, with diminishing returns.
 */
function buildReceptionHeatPoints(stations: readonly ReceptionStation[], typicalSnr: ReadonlyMap<string, number | undefined>): ReceptionHeatPoint[] {
  const areas = new Map<string, { latSum: number; lngSum: number; members: number; freshness: number; quality: number }>();
  for (const station of stations) {
    const key = getHeatAreaKey(station.lat, station.lng);
    const area = areas.get(key) ?? { latSum: 0, lngSum: 0, members: 0, freshness: 0, quality: 0 };
    const quality = getReceptionSignalQuality(typicalSnr.get(station.callsign));
    area.latSum += station.lat;
    area.lngSum += station.lng;
    area.members += 1;
    area.freshness += station.freshness;
    area.quality += station.freshness * quality;
    areas.set(key, area);
  }

  const countScale = Math.log2(1 + HEAT_REFERENCE_RECEIVERS);
  return Array.from(areas.values())
    .filter(area => area.freshness > 0)
    .map<ReceptionHeatPoint>(area => {
      const meanQuality = area.quality / area.freshness;
      const countFactor = Math.log2(1 + area.freshness) / countScale;
      return {
        lat: area.latSum / area.members,
        lng: area.lngSum / area.members,
        weight: Math.max(HEAT_WEIGHT_STEP, Math.round((meanQuality * countFactor) / HEAT_WEIGHT_STEP) * HEAT_WEIGHT_STEP),
      };
    })
    .sort((left, right) => right.weight - left.weight)
    .slice(0, MAX_HEAT_POINTS);
}

export function buildReceptionPingRing(
  station: Pick<ReceptionStation, 'callsign' | 'lat' | 'lng'>,
  id: string,
  theme: ReceptionTheme = DEFAULT_RECEPTION_THEME,
): ReceptionPingRing {
  return {
    id,
    lat: station.lat,
    lng: station.lng,
    color: [`rgba(${theme.pointRgb}, 0.42)`, `rgba(${theme.accentRgb}, 0.12)`, `rgba(${theme.accentRgb}, 0)`],
    maxRadius: 1.6,
    propagationSpeed: 0.9,
    // One ring per datum: the ring is removed before it would repeat.
    repeatPeriod: 60_000,
  };
}

export function buildReceptionGlobeModel(
  view: ReceptionView | null,
  home: { lat: number; lng: number } | null,
  now: number,
  targetCalls: ReadonlySet<string> = new Set(),
  theme: ReceptionTheme = DEFAULT_RECEPTION_THEME,
): ReceptionGlobeModel {
  const empty: ReceptionGlobeModel = { stations: [], points: [], heatPoints: [], targetRings: [], farthest: null };
  if (!view || view.state === 'disabled' || view.spots.length === 0) {
    return empty;
  }

  const stationsByCall = new Map<string, ReceptionStation>();
  const snrsByCall = new Map<string, number[]>();
  let latestReportAt: number | undefined;
  for (const spot of view.spots) {
    latestReportAt = Math.max(latestReportAt ?? 0, spot.reportedAt);
    if (spot.snr !== undefined && Number.isFinite(spot.snr)) {
      const snrs = snrsByCall.get(spot.receiverCallsign) ?? [];
      snrs.push(spot.snr);
      snrsByCall.set(spot.receiverCallsign, snrs);
    }
    const existing = stationsByCall.get(spot.receiverCallsign);
    if (existing) {
      existing.reportCount += 1;
      if (spot.transmittedAt < existing.transmittedAt) continue;
    }
    const coords = gridToCoordinates(spot.receiverLocator);
    if (!coords) continue;
    const freshness = getReceptionFreshness(now - spot.transmittedAt, view.windowMs);
    stationsByCall.set(spot.receiverCallsign, {
      callsign: spot.receiverCallsign,
      locator: spot.receiverLocator,
      lat: coords.lat,
      lng: coords.lon,
      mode: spot.mode,
      frequency: spot.frequency,
      snr: spot.snr,
      transmittedAt: spot.transmittedAt,
      reportedAt: spot.reportedAt,
      source: spot.source,
      reportCount: existing?.reportCount ?? 1,
      freshness,
      distanceKm: home ? haversineDistanceKm(home.lat, home.lng, coords.lat, coords.lon) : undefined,
    });
  }

  const stations = Array.from(stationsByCall.values())
    .filter(station => station.freshness > 0)
    .sort((left, right) => (left.distanceKm ?? 0) - (right.distanceKm ?? 0));
  const farthest = stations.reduce<ReceptionStation | null>((current, station) => (
    station.distanceKm !== undefined && (!current || station.distanceKm > (current.distanceKm ?? 0)) ? station : current
  ), null);

  const points = stations.map<ReceptionGlobePoint>(station => ({
    kind: 'reception',
    lat: station.lat,
    lng: station.lng,
    size: getReceptionPointSize(station.snr),
    color: `rgba(${theme.pointRgb}, ${(0.3 + station.freshness * 0.62).toFixed(3)})`,
    station,
  }));

  // A receiver's typical report, so one lucky decode does not light its area.
  const typicalSnr = new Map(stations.map(station => [station.callsign, median(snrsByCall.get(station.callsign) ?? [])]));
  const heatPoints = buildReceptionHeatPoints(stations, typicalSnr);

  const targetRings = stations
    .filter(station => targetCalls.has(station.callsign) && now - station.transmittedAt <= RECEPTION_TARGET_HEARD_MS)
    .map<ReceptionPingRing>(station => ({
      id: `target:${station.callsign}`,
      lat: station.lat,
      lng: station.lng,
      color: [`rgba(${theme.pointRgb}, 0.55)`, `rgba(${theme.accentRgb}, 0.04)`],
      maxRadius: 2.4,
      propagationSpeed: 1.3,
      repeatPeriod: 2400,
    }));

  return { stations, points, heatPoints, targetRings, farthest, latestReportAt };
}
