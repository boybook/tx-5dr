import type {
  OperatorStatus,
  QSORecord,
  StationInfo,
} from '@tx5dr/contracts';
import { gridToCoordinates } from '@tx5dr/core';

const REMOTE_POINT_COLOR = '#60a5fa';
const HOME_POINT_COLOR = '#f97316';
const ARC_BASE_COLOR = '59, 130, 246';
const HIGHLIGHT_POINT_COLOR = '#f43f5e';
const HIGHLIGHT_ARC_COLOR = '244, 63, 94';
const RECENT_QSO_HIGHLIGHT_WINDOW_MS = 10 * 60 * 1000;
const EARTH_RADIUS_KM = 6371;
const ARC_SURFACE_CLEARANCE = 0.008;
const LONG_ARC_LIFT_SOFTENING = 0.82;

export interface GlobeStationPoint {
  lat: number;
  lng: number;
  size: number;
  color: string;
  grid: string;
  count: number;
  callsigns: string[];
  isHome?: boolean;
}

export interface GlobeArc {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  color: string;
  altitude: number;
  stroke: number;
  grid: string;
  callsign: string;
  startTime: number;
  mode: string;
  frequency: number;
  dashLength?: number;
  dashGap?: number;
  dashAnimateTime?: number;
}

export interface GlobeRing {
  lat: number;
  lng: number;
  color: string[];
  maxRadius: number;
  propagationSpeed: number;
  repeatPeriod: number;
}

export interface RecentQSOGlobeModel {
  homePoint: GlobeStationPoint | null;
  remotePoints: GlobeStationPoint[];
  arcs: GlobeArc[];
  /** All rings, including `homeRing`. */
  rings: GlobeRing[];
  /** The station's own pulse; stays visible when QSO history is hidden. */
  homeRing: GlobeRing | null;
  summary: {
    qsoCount: number;
    uniqueGridCount: number;
    latestQsoTime?: number;
    farthestDistanceKm?: number;
    droppedInvalidGrid: number;
    limited: boolean;
  };
}

function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2))
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function getAngularDistanceDegrees(distanceKm: number): number {
  return distanceKm / EARTH_RADIUS_KM * 180 / Math.PI;
}

// react-globe.gl arcs use a midpoint altitude. For very long hops that midpoint
// needs extra lift, otherwise the bezier can dip into the globe interior.
export function getRenderedArcAltitude(distanceKm: number, highlighted: boolean): number {
  const baseAltitude = highlighted
    ? Math.min(0.4, 0.14 + distanceKm / 32000)
    : Math.min(0.35, 0.08 + distanceKm / 40000);
  const angularDistanceDegrees = getAngularDistanceDegrees(distanceKm);
  const nonIntersectingAltitude = Math.min(
    0.92,
    Math.max(
      0,
      (1 - Math.cos((angularDistanceDegrees * Math.PI / 180) / 2)) * LONG_ARC_LIFT_SOFTENING
        + ARC_SURFACE_CLEARANCE,
    ),
  );

  return Number(Math.max(baseAltitude, nonIntersectingAltitude).toFixed(3));
}

function getArcOpacity(startTime: number, hours: number): number {
  const maxAgeMs = hours * 60 * 60 * 1000;
  const ageMs = Math.max(0, Date.now() - startTime);
  const freshness = Math.max(0.2, 1 - ageMs / maxAgeMs);
  return Number((0.2 + freshness * 0.75).toFixed(3));
}

function getHighlightArcOpacity(startTime: number): number {
  const ageMs = Math.max(0, Date.now() - startTime);
  const freshness = Math.max(0, 1 - ageMs / RECENT_QSO_HIGHLIGHT_WINDOW_MS);
  return Number((0.72 + freshness * 0.24).toFixed(3));
}

function isRecentQsoHighlightCandidate(startTime: number, now = Date.now()): boolean {
  const ageMs = now - startTime;
  return ageMs >= 0 && ageMs <= RECENT_QSO_HIGHLIGHT_WINDOW_MS;
}

function buildHighlightedRemoteRing(lat: number, lng: number): GlobeRing {
  return {
    lat,
    lng,
    color: ['rgba(244, 63, 94, 0.92)', 'rgba(248, 113, 113, 0.42)', 'rgba(248, 113, 113, 0.04)'],
    maxRadius: 4.4,
    propagationSpeed: 2.8,
    repeatPeriod: 1400,
  };
}

export function buildPagedQSOGlobeModel(qsos: QSORecord[], stationInfo?: StationInfo | null): RecentQSOGlobeModel {
  const validMyGridRecord = qsos.find((qso) => typeof qso.myGrid === 'string' && !!gridToCoordinates(qso.myGrid));
  const homeCoords = validMyGridRecord?.myGrid ? gridToCoordinates(validMyGridRecord.myGrid) : null;
  const fallbackStationCoords = stationInfo?.qth?.latitude != null && stationInfo?.qth?.longitude != null
    ? { lat: stationInfo.qth.latitude, lon: stationInfo.qth.longitude }
    : null;
  const fallbackStationGridCoords = stationInfo?.qth?.grid ? gridToCoordinates(stationInfo.qth.grid) : null;
  const homePoint = homeCoords && validMyGridRecord?.myGrid
    ? {
      lat: homeCoords.lat,
      lng: homeCoords.lon,
      size: 0.75,
      color: HOME_POINT_COLOR,
      grid: validMyGridRecord.myGrid,
      count: 1,
      callsigns: [],
      isHome: true,
    }
    : fallbackStationCoords
      ? {
        lat: fallbackStationCoords.lat,
        lng: fallbackStationCoords.lon,
        size: 0.75,
        color: HOME_POINT_COLOR,
        grid: stationInfo?.qth?.grid || '',
        count: 1,
        callsigns: [],
        isHome: true,
      }
      : fallbackStationGridCoords && stationInfo?.qth?.grid
        ? {
          lat: fallbackStationGridCoords.lat,
          lng: fallbackStationGridCoords.lon,
          size: 0.75,
          color: HOME_POINT_COLOR,
          grid: stationInfo.qth.grid,
          count: 1,
          callsigns: [],
          isHome: true,
        }
        : null;

  const pointMap = new Map<string, GlobeStationPoint>();
  const arcs: GlobeArc[] = [];
  const rings: GlobeRing[] = [];
  let farthestDistanceKm = 0;
  let droppedInvalidGrid = 0;
  const highlightedQso = qsos.reduce<QSORecord | null>((latest, qso) => {
    if (!qso.grid || !gridToCoordinates(qso.grid) || !isRecentQsoHighlightCandidate(qso.startTime)) {
      return latest;
    }

    if (!latest || qso.startTime > latest.startTime) {
      return qso;
    }

    return latest;
  }, null);
  const highlightedGrid = highlightedQso?.grid ?? null;

  for (const qso of qsos) {
    if (!qso.grid) {
      droppedInvalidGrid += 1;
      continue;
    }

    const coords = gridToCoordinates(qso.grid);
    if (!coords) {
      droppedInvalidGrid += 1;
      continue;
    }

    const isHighlightedQso = highlightedQso?.id === qso.id;

    const existingPoint = pointMap.get(qso.grid);
    if (existingPoint) {
      existingPoint.count += 1;
      existingPoint.size = Math.min(1.9, 0.42 + existingPoint.count * 0.14);
      if (!existingPoint.callsigns.includes(qso.callsign) && existingPoint.callsigns.length < 4) {
        existingPoint.callsigns.push(qso.callsign);
      }
    } else {
      pointMap.set(qso.grid, {
        lat: coords.lat,
        lng: coords.lon,
        size: 0.56,
        color: REMOTE_POINT_COLOR,
        grid: qso.grid,
        count: 1,
        callsigns: [qso.callsign],
      });
    }

    if (isHighlightedQso) {
      const highlightedPoint = pointMap.get(qso.grid);
      if (highlightedPoint) {
        highlightedPoint.color = HIGHLIGHT_POINT_COLOR;
        highlightedPoint.size = Math.max(highlightedPoint.size, 0.9);
      }
    }

    if (homePoint) {
      const distanceKm = haversineDistanceKm(homePoint.lat, homePoint.lng, coords.lat, coords.lon);
      farthestDistanceKm = Math.max(farthestDistanceKm, distanceKm);
      arcs.push({
        startLat: homePoint.lat,
        startLng: homePoint.lng,
        endLat: coords.lat,
        endLng: coords.lon,
        color: isHighlightedQso
          ? `rgba(${HIGHLIGHT_ARC_COLOR}, ${getHighlightArcOpacity(qso.startTime)})`
          : `rgba(${ARC_BASE_COLOR}, ${getArcOpacity(qso.startTime, 24)})`,
        altitude: getRenderedArcAltitude(distanceKm, isHighlightedQso),
        stroke: isHighlightedQso
          ? (distanceKm > 8000 ? 1.1 : 0.9)
          : (distanceKm > 8000 ? 0.75 : 0.5),
        grid: qso.grid,
        callsign: qso.callsign,
        startTime: qso.startTime,
        mode: qso.mode,
        frequency: qso.frequency,
      });
    }
  }

  const homeRing: GlobeRing | null = homePoint
    ? {
      lat: homePoint.lat,
      lng: homePoint.lng,
      color: ['rgba(249, 115, 22, 0.65)', 'rgba(249, 115, 22, 0.08)'],
      maxRadius: 4.8,
      propagationSpeed: 2.2,
      repeatPeriod: 1600,
    }
    : null;
  if (homeRing) {
    rings.push(homeRing);
  }

  if (highlightedGrid) {
    const highlightedPoint = pointMap.get(highlightedGrid);
    if (highlightedPoint) {
      rings.push(buildHighlightedRemoteRing(highlightedPoint.lat, highlightedPoint.lng));
    }
  }

  Array.from(pointMap.values())
    .filter((point) => point.grid !== highlightedGrid)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .forEach((point, index) => {
      rings.push({
        lat: point.lat,
        lng: point.lng,
        color: ['rgba(96, 165, 250, 0.45)', 'rgba(96, 165, 250, 0.02)'],
        maxRadius: 2.2 + index * 0.5,
        propagationSpeed: 1.2 + index * 0.25,
        repeatPeriod: 2600 + index * 260,
      });
    });

  return {
    homePoint,
    remotePoints: Array.from(pointMap.values()),
    arcs,
    rings,
    homeRing,
    summary: {
      qsoCount: qsos.length,
      uniqueGridCount: pointMap.size,
      latestQsoTime: qsos[0]?.startTime,
      farthestDistanceKm: homePoint && farthestDistanceKm > 0 ? farthestDistanceKm : undefined,
      droppedInvalidGrid,
      limited: false,
    },
  };
}

/**
 * Arcs and rings of the QSOs in progress. `home` is the station point the
 * globe already shows (see buildPagedQSOGlobeModel): every arc must leave from
 * that same point. The station info and operator grids are only fallbacks for
 * a page without one.
 */
export function buildInProgressQSOGlobeModel(
  operators: OperatorStatus[],
  stationInfo?: StationInfo | null,
  home?: { lat: number; lng: number } | null,
): { arcs: GlobeArc[]; rings: GlobeRing[] } {
  const fallbackStationCoords = stationInfo?.qth?.latitude != null && stationInfo?.qth?.longitude != null
    ? { lat: stationInfo.qth.latitude, lon: stationInfo.qth.longitude }
    : null;
  const fallbackStationGridCoords = stationInfo?.qth?.grid ? gridToCoordinates(stationInfo.qth.grid) : null;

  // 当 stationInfo 未配置时，尝试从 operators 的 myGrid 推导 home point
  const operatorWithMyGrid = operators.find((op) => op.context?.myGrid && gridToCoordinates(op.context.myGrid));
  const operatorGridCoords = operatorWithMyGrid?.context?.myGrid
    ? gridToCoordinates(operatorWithMyGrid.context.myGrid)
    : null;

  const homePoint = home
    ? { lat: home.lat, lng: home.lng }
    : fallbackStationCoords
      ? { lat: fallbackStationCoords.lat, lng: fallbackStationCoords.lon }
      : fallbackStationGridCoords
        ? { lat: fallbackStationGridCoords.lat, lng: fallbackStationGridCoords.lon }
        : operatorGridCoords
          ? { lat: operatorGridCoords.lat, lng: operatorGridCoords.lon }
          : null;

  if (!homePoint) {
    return { arcs: [], rings: [] };
  }

  const arcs: GlobeArc[] = [];
  const rings: GlobeRing[] = [];

  for (const op of operators) {
    if (op.currentSlot === 'TX6') continue;
    if (!op.context.targetCall || !op.context.targetGrid) continue;

    const coords = gridToCoordinates(op.context.targetGrid);
    if (!coords) continue;

    const distanceKm = haversineDistanceKm(homePoint.lat, homePoint.lng, coords.lat, coords.lon);
    arcs.push({
      startLat: homePoint.lat,
      startLng: homePoint.lng,
      endLat: coords.lat,
      endLng: coords.lon,
      color: `rgba(${HIGHLIGHT_ARC_COLOR}, 0.85)`,
      altitude: getRenderedArcAltitude(distanceKm, true),
      stroke: distanceKm > 8000 ? 1.1 : 0.9,
      dashLength: 0.1,
      dashGap: 0.05,
      dashAnimateTime: 2500,
      grid: op.context.targetGrid,
      callsign: op.context.targetCall,
      startTime: Date.now(),
      mode: op.strategy?.state ?? '',
      frequency: op.context.frequency ?? 0,
    });

    rings.push(buildHighlightedRemoteRing(coords.lat, coords.lon));
  }

  return { arcs, rings };
}
