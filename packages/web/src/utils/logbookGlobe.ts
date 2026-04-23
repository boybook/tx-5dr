import type {
  LogBookRecentGlobeResponse,
  LogBookWorkedGridItem,
  QSORecord,
  StationInfo,
} from '@tx5dr/contracts';
import {
  getGridBounds,
  getTwoCharacterGrid,
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
  rings: GlobeRing[];
  summary: {
    qsoCount: number;
    uniqueGridCount: number;
    latestQsoTime?: number;
    farthestDistanceKm?: number;
    droppedInvalidGrid: number;
    limited: boolean;
  };
}

export interface WorkedGridPolygon {
  kind: 'worked-grid' | 'grid-base';
  precision: 2 | 4;
  grid: string;
  count: number;
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
}

export interface WorkedGridLabel {
  grid: string;
  precision: 2 | 4;
  count: number;
  lat: number;
  lng: number;
  text: string;
}

export interface WorkedGridGlobeModel {
  precision2: {
    polygons: WorkedGridPolygon[];
    labels: WorkedGridLabel[];
  };
  precision4: {
    polygons: WorkedGridPolygon[];
    labels: WorkedGridLabel[];
  };
}

const globalGridPolygonCache = new Map<2 | 4, WorkedGridPolygon[]>();
const maidenheadGridLineCache = new Map<2 | 4, WorkedGridLine[]>();

export interface WorkedGridLine {
  kind: 'grid-base';
  precision: 2 | 4;
  axis: 'lat' | 'lng';
  value: number;
  points: Array<[number, number]>;
}

function createGridPolygon(grid: string, precision: 2 | 4, count: number, kind: WorkedGridPolygon['kind']): WorkedGridPolygon | null {
  const bounds = getGridBounds(grid);
  if (!bounds) {
    return null;
  }

  return {
    kind,
    precision,
    grid,
    count,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [bounds.lonMin, bounds.latMin],
        [bounds.lonMax, bounds.latMin],
        [bounds.lonMax, bounds.latMax],
        [bounds.lonMin, bounds.latMax],
        [bounds.lonMin, bounds.latMin],
      ]],
    },
  };
}

export function getGlobalGridPolygons(precision: 2 | 4): WorkedGridPolygon[] {
  const cached = globalGridPolygonCache.get(precision);
  if (cached) {
    return cached;
  }

  const polygons: WorkedGridPolygon[] = [];

  for (let lonField = 0; lonField < 18; lonField += 1) {
    for (let latField = 0; latField < 18; latField += 1) {
      const twoCharGrid = `${String.fromCharCode(65 + lonField)}${String.fromCharCode(65 + latField)}`;

      if (precision === 2) {
        const polygon = createGridPolygon(twoCharGrid, 2, 0, 'grid-base');
        if (polygon) {
          polygons.push(polygon);
        }
        continue;
      }

      for (let lonSquare = 0; lonSquare < 10; lonSquare += 1) {
        for (let latSquare = 0; latSquare < 10; latSquare += 1) {
          const fourCharGrid = `${twoCharGrid}${lonSquare}${latSquare}`;
          const polygon = createGridPolygon(fourCharGrid, 4, 0, 'grid-base');
          if (polygon) {
            polygons.push(polygon);
          }
        }
      }
    }
  }

  globalGridPolygonCache.set(precision, polygons);
  return polygons;
}

export function getMaidenheadGridLines(precision: 2 | 4): WorkedGridLine[] {
  const cached = maidenheadGridLineCache.get(precision);
  if (cached) {
    return cached;
  }

  const lngStep = precision === 2 ? 20 : 2;
  const latStep = precision === 2 ? 10 : 1;
  const lines: WorkedGridLine[] = [];

  for (let lng = -180; lng <= 180; lng += lngStep) {
    const points: Array<[number, number]> = [];
    for (let lat = -90; lat <= 90; lat += latStep) {
      points.push([lat, lng]);
    }
    lines.push({
      kind: 'grid-base',
      precision,
      axis: 'lng',
      value: lng,
      points,
    });
  }

  for (let lat = -90; lat <= 90; lat += latStep) {
    const points: Array<[number, number]> = [];
    for (let lng = -180; lng <= 180; lng += lngStep) {
      points.push([lat, lng]);
    }
    lines.push({
      kind: 'grid-base',
      precision,
      axis: 'lat',
      value: lat,
      points,
    });
  }

  maidenheadGridLineCache.set(precision, lines);
  return lines;
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

export function buildRecentQSOGlobeModel(
  payload: LogBookRecentGlobeResponse['data'],
): RecentQSOGlobeModel {
  const homePoint = payload.home
    ? {
      lat: payload.home.latitude,
      lng: payload.home.longitude,
      size: 0.75,
      color: HOME_POINT_COLOR,
      grid: payload.home.grid || '',
      count: 1,
      callsigns: [],
      isHome: true,
    }
    : null;

  const pointMap = new Map<string, GlobeStationPoint>();
  const arcs: GlobeArc[] = [];
  const rings: GlobeRing[] = [];
  let farthestDistanceKm = 0;
  const highlightedItem = payload.items.reduce<typeof payload.items[number] | null>((latest, item) => {
    if (!isRecentQsoHighlightCandidate(item.startTime)) {
      return latest;
    }

    if (!latest || item.startTime > latest.startTime) {
      return item;
    }

    return latest;
  }, null);
  const highlightedGrid = highlightedItem?.grid ?? null;

  for (const item of payload.items) {
    const coords = gridToCoordinates(item.grid);
    if (!coords) {
      continue;
    }

    const isHighlightedItem = highlightedItem?.id === item.id;

    const existingPoint = pointMap.get(item.grid);
    if (existingPoint) {
      existingPoint.count += 1;
      existingPoint.size = Math.min(1.9, 0.42 + existingPoint.count * 0.14);
      if (!existingPoint.callsigns.includes(item.callsign) && existingPoint.callsigns.length < 4) {
        existingPoint.callsigns.push(item.callsign);
      }
    } else {
      pointMap.set(item.grid, {
        lat: coords.lat,
        lng: coords.lon,
        size: 0.56,
        color: REMOTE_POINT_COLOR,
        grid: item.grid,
        count: 1,
        callsigns: [item.callsign],
      });
    }

    if (isHighlightedItem) {
      const highlightedPoint = pointMap.get(item.grid);
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
        color: isHighlightedItem
          ? `rgba(${HIGHLIGHT_ARC_COLOR}, ${getHighlightArcOpacity(item.startTime)})`
          : `rgba(${ARC_BASE_COLOR}, ${getArcOpacity(item.startTime, payload.meta.hours)})`,
        altitude: getRenderedArcAltitude(distanceKm, isHighlightedItem),
        stroke: isHighlightedItem
          ? (distanceKm > 8000 ? 1.1 : 0.9)
          : (distanceKm > 8000 ? 0.75 : 0.5),
        grid: item.grid,
        callsign: item.callsign,
        startTime: item.startTime,
        mode: item.mode,
        frequency: item.frequency,
      });
    }
  }

  if (homePoint) {
    rings.push({
      lat: homePoint.lat,
      lng: homePoint.lng,
      color: ['rgba(249, 115, 22, 0.65)', 'rgba(249, 115, 22, 0.08)'],
      maxRadius: 4.8,
      propagationSpeed: 2.2,
      repeatPeriod: 1600,
    });
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
    summary: {
      qsoCount: payload.items.length,
      uniqueGridCount: pointMap.size,
      latestQsoTime: payload.items[0]?.startTime,
      farthestDistanceKm: homePoint && farthestDistanceKm > 0 ? farthestDistanceKm : undefined,
      droppedInvalidGrid: payload.meta.droppedInvalidGrid,
      limited: payload.meta.limited,
    },
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

  if (homePoint) {
    rings.push({
      lat: homePoint.lat,
      lng: homePoint.lng,
      color: ['rgba(249, 115, 22, 0.65)', 'rgba(249, 115, 22, 0.08)'],
      maxRadius: 4.8,
      propagationSpeed: 2.2,
      repeatPeriod: 1600,
    });
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

export function buildWorkedGridGlobeModel(items: LogBookWorkedGridItem[]): WorkedGridGlobeModel {
  const precision4Polygons: WorkedGridPolygon[] = [];
  const precision4Labels: WorkedGridLabel[] = [];
  const precision2Map = new Map<string, number>();

  for (const item of items) {
    const polygon = createGridPolygon(item.grid, 4, item.count, 'worked-grid');
    const bounds = getGridBounds(item.grid);
    if (!polygon || !bounds) {
      continue;
    }

    precision4Polygons.push(polygon);
    precision4Labels.push({
      grid: item.grid,
      precision: 4,
      count: item.count,
      lat: bounds.centerLat,
      lng: bounds.centerLon,
      text: item.grid,
    });

    const twoCharacterGrid = getTwoCharacterGrid(item.grid);
    if (twoCharacterGrid) {
      precision2Map.set(twoCharacterGrid, (precision2Map.get(twoCharacterGrid) || 0) + item.count);
    }
  }

  const precision2Polygons: WorkedGridPolygon[] = [];
  const precision2Labels: WorkedGridLabel[] = [];

  for (const [grid, count] of precision2Map.entries()) {
    const polygon = createGridPolygon(grid, 2, count, 'worked-grid');
    const bounds = getGridBounds(grid);
    if (!polygon || !bounds) {
      continue;
    }

    precision2Polygons.push(polygon);
    precision2Labels.push({
      grid,
      precision: 2,
      count,
      lat: bounds.centerLat,
      lng: bounds.centerLon,
      text: grid,
    });
  }

  precision2Polygons.sort((left, right) => right.count - left.count || left.grid.localeCompare(right.grid));
  precision2Labels.sort((left, right) => right.count - left.count || left.grid.localeCompare(right.grid));
  precision4Polygons.sort((left, right) => right.count - left.count || left.grid.localeCompare(right.grid));
  precision4Labels.sort((left, right) => right.count - left.count || left.grid.localeCompare(right.grid));

  return {
    precision2: {
      polygons: precision2Polygons,
      labels: precision2Labels,
    },
    precision4: {
      polygons: precision4Polygons,
      labels: precision4Labels,
    },
  };
}
