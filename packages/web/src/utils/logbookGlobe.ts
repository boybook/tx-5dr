import type { LogBookRecentGlobeResponse, QSORecord, StationInfo } from '@tx5dr/contracts';
import { gridToCoordinates } from '@tx5dr/core';

const REMOTE_POINT_COLOR = '#60a5fa';
const HOME_POINT_COLOR = '#f97316';
const ARC_BASE_COLOR = '59, 130, 246';

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

function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2))
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function getArcOpacity(startTime: number, hours: number): number {
  const maxAgeMs = hours * 60 * 60 * 1000;
  const ageMs = Math.max(0, Date.now() - startTime);
  const freshness = Math.max(0.2, 1 - ageMs / maxAgeMs);
  return Number((0.2 + freshness * 0.75).toFixed(3));
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

  for (const item of payload.items) {
    const coords = gridToCoordinates(item.grid);
    if (!coords) {
      continue;
    }

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

    if (homePoint) {
      const distanceKm = haversineDistanceKm(homePoint.lat, homePoint.lng, coords.lat, coords.lon);
      farthestDistanceKm = Math.max(farthestDistanceKm, distanceKm);
      arcs.push({
        startLat: homePoint.lat,
        startLng: homePoint.lng,
        endLat: coords.lat,
        endLng: coords.lon,
        color: `rgba(${ARC_BASE_COLOR}, ${getArcOpacity(item.startTime, payload.meta.hours)})`,
        altitude: Math.min(0.35, 0.08 + distanceKm / 40000),
        stroke: distanceKm > 8000 ? 0.75 : 0.5,
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

  Array.from(pointMap.values())
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

    if (homePoint) {
      const distanceKm = haversineDistanceKm(homePoint.lat, homePoint.lng, coords.lat, coords.lon);
      farthestDistanceKm = Math.max(farthestDistanceKm, distanceKm);
      arcs.push({
        startLat: homePoint.lat,
        startLng: homePoint.lng,
        endLat: coords.lat,
        endLng: coords.lon,
        color: `rgba(${ARC_BASE_COLOR}, ${getArcOpacity(qso.startTime, 24)})`,
        altitude: Math.min(0.35, 0.08 + distanceKm / 40000),
        stroke: distanceKm > 8000 ? 0.75 : 0.5,
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

  Array.from(pointMap.values())
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
