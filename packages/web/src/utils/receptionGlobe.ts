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
 * capped to the strongest receivers.
 */
const HEAT_WEIGHT_STEP = 0.05;
const MAX_HEAT_POINTS = 300;
const EARTH_RADIUS_KM = 6371;

export interface ReceptionView {
  state: PSKReporterReceptionState;
  callsigns: string[];
  windowMs: number;
  spots: PSKReporterReceptionSpot[];
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

/** A strong report lights its area more than a marginal one. */
function getReceptionSignalWeight(snr: number | undefined): number {
  if (snr === undefined) return 0.8;
  if (snr >= -10) return 1;
  if (snr >= -18) return 0.8;
  return 0.62;
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
  let latestReportAt: number | undefined;
  for (const spot of view.spots) {
    latestReportAt = Math.max(latestReportAt ?? 0, spot.reportedAt);
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

  const heatPoints = stations
    .map<ReceptionHeatPoint>(station => ({
      lat: station.lat,
      lng: station.lng,
      weight: Math.max(
        HEAT_WEIGHT_STEP,
        Math.round((Math.max(0.12, station.freshness) * getReceptionSignalWeight(station.snr)) / HEAT_WEIGHT_STEP)
          * HEAT_WEIGHT_STEP,
      ),
    }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, MAX_HEAT_POINTS);

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
