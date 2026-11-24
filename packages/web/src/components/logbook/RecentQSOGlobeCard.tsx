import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger, Select, SelectItem, Spinner, Tooltip } from '@heroui/react';
import { getGridBounds, type LogBookWorkedGridItem, type OperatorStatus, type QSORecord, type StationInfo } from '@tx5dr/contracts';
import { api, ApiError, getBandFromFrequency } from '@tx5dr/core';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClockRotateLeft, faTableCells, faTowerBroadcast, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import * as THREE from 'three';
import { feature } from 'topojson-client';
import type { Feature, Geometry } from 'geojson';
import landTopology from 'world-atlas/land-110m.json';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { isElectron, isMacOS } from '../../utils/config';
import { OperatorsContext } from '../../store/radio/contexts';
import { useViewportHeightValue } from '../../hooks/useViewportHeight';
import {
  buildWorkedGridGlobeModel,
  buildPagedQSOGlobeModel,
  buildInProgressQSOGlobeModel,
  getMaidenheadGridLines,
  type GlobeArc,
  type GlobeStationPoint,
  type WorkedGridLabel,
  type WorkedGridLine,
} from '../../utils/logbookGlobe';
import {
  buildReceptionGlobeModel,
  getReceptionHeatSignature,
  type ReceptionGlobePoint,
  type ReceptionHeatPoint,
  type ReceptionView,
} from '../../utils/receptionGlobe';
import { useReceptionPings } from './useReceptionPings';
import { useGlobeTrackpadGestures } from './useGlobeTrackpadGestures';
import { buildReceptionPointCardHtml } from '../../utils/receptionPointCard';
import { LOGBOOK_BAND_OPTIONS } from './logbookBands';
import {
  RECEPTION_THEMES,
  getReceptionTheme,
  loadReceptionThemeId,
  saveReceptionThemeId,
  type ReceptionThemeId,
} from '../../utils/receptionThemes';

const logger = createLogger('RecentQSOGlobeCard');

const GLOBE_HEIGHT_MIN = 360;
const GLOBE_HEIGHT_MAX = 560;
const GLOBE_WIDTH_FALLBACK = 1280;
const STARFIELD_URL = '/globe/night-sky.png';
const EARTH_TEXTURE_URL = '/globe/earth-night.jpg';
const EARTH_BUMP_URL = '/globe/earth-topology.png';
const INITIAL_POV_ANIMATION_MS = 900;
const FOCUS_POV_ANIMATION_MS = 1400;
const DEFAULT_POV_ALTITUDE = 1.0;
const WORKED_GRID_SWITCH_ALTITUDE = 0.62;
const WORKED_GRID_LABEL_LIMIT = 120;
const WORKED_GRID_MIN_VISIBLE_DEGREES = 34;
const WORKED_GRID_MAX_VISIBLE_DEGREES = 68;
const POV_SYNC_INTERVAL_MS = 120;
const POV_SYNC_ALTITUDE_EPSILON = 0.025;
const POV_SYNC_CENTER_EPSILON_WITH_GRIDS = 1.2;
const POV_SYNC_CENTER_EPSILON_IDLE = 999;
const WORKED_GRID_CACHE_LIMIT = 4;
const EMPTY_OPERATORS: OperatorStatus[] = [];
const RECEPTION_TICK_MS = 30_000;
const RECEPTION_POINT_ALTITUDE = 0.0045;
/** Gaussian radius of the coverage glow, in degrees of arc. */
const RECEPTION_FOG_BANDWIDTH = 4.5;
/** Above the land caps (0.0025) so the glow tints land instead of sitting under the overlay. */
const RECEPTION_FOG_ALTITUDE = 0.0032;
/** Frames to keep re-applying the glow material after a data change. */
const RECEPTION_FOG_PATCH_FRAMES = 30;

/**
 * The heatmap is a whole-globe shell. Its material writes depth even where it
 * is fully transparent, which hides any layer it covers: above the land caps
 * it hides them on the whole hemisphere, below them it punches holes where the
 * flat cap triangles sag. A glow must not occlude anything, so depth writes
 * are off, and it is blended additively: it adds light to the night texture
 * below instead of painting over it. globe.gl exposes no heatmap material
 * option and rebuilds the mesh when its data changes, so the mesh is patched
 * after updates.
 */
type SceneMaterial = { depthWrite: boolean; blending: number; needsUpdate: boolean };
type SceneObject = { __globeObjType?: string; material?: SceneMaterial | SceneMaterial[] };

function applyHeatmapGlowMaterial(globe: GlobeMethods | undefined): boolean {
  if (!globe || typeof globe.scene !== 'function') return false;
  let found = false;
  globe.scene().traverse((object: SceneObject) => {
    if (object.__globeObjType !== 'heatmap') return;
    found = true;
    const materials = ([] as SceneMaterial[]).concat(object.material ?? []);
    for (const material of materials) {
      if (material.depthWrite || material.blending !== THREE.AdditiveBlending) {
        material.depthWrite = false;
        material.blending = THREE.AdditiveBlending;
        material.needsUpdate = true;
      }
    }
  });
  return found;
}
const RECEPTION_FOG_TRANSITION_MS = 1200;
const EMPTY_HEATMAPS: object[] = [];
/** Minimum spacing of glow recomputations; receiver batches arrive in bursts. */
const RECEPTION_FOG_MIN_INTERVAL_MS = 3000;
const EMPTY_HEAT_POINTS: ReceptionHeatPoint[] = [];
// The globe is always dark, so its hover panels stay dark in the light theme too.
const GLOBE_TOOLTIP_CLASSNAMES = {
  content: 'border border-white/10 bg-[rgba(15,23,42,0.95)] text-[rgba(226,232,240,0.94)] shadow-[0_14px_36px_rgba(2,6,23,0.5)] backdrop-blur-xl',
};
const GLOBE_TOOLTIP_MUTED_CLASS = 'text-[rgba(148,163,184,0.95)]';
const GLOBE_TOOLTIP_FAINT_CLASS = 'text-[rgba(148,163,184,0.7)]';
// The pale land overlay steps back while the reception glow is shown, so the
// glow and the night texture both stay readable.
const getLandCapColor = () => 'rgba(226, 232, 240, 0.2)';
const getDimmedLandCapColor = () => 'rgba(226, 232, 240, 0.13)';
const getLandStrokeColor = () => 'rgba(241, 245, 249, 0.2)';
const getDimmedLandStrokeColor = () => 'rgba(241, 245, 249, 0.16)';
const RECEPTION_TOOLTIP_STATION_LIMIT = 5;
const RECEPTION_PANEL_CLOSE_DELAY_MS = 200;
const RECEPTION_CREDIT = 'Data from PSK Reporter by Philip Gladstone. Live spots from mqtt.pskreporter.info by Tom Fanning M0LTE.';

type GlobePointDatum = GlobeStationPoint | ReceptionGlobePoint;

const GLOBE_ALL_BANDS_KEY = '__all__';
const GLOBE_SELECT_LISTBOX_PROPS = {
  itemClasses: {
    base: 'text-[rgba(248,250,252,0.94)] [&_svg]:text-[rgba(248,250,252,0.94)] data-[hover=true]:bg-white/10 data-[selectable=true]:focus:bg-white/10',
    title: 'text-[rgba(248,250,252,0.94)] group-data-[selected=true]:text-white',
  },
};
const GLOBE_SELECT_CLASSNAMES = {
  base: 'min-w-0',
  trigger: 'h-10 min-h-10 border-0 bg-transparent pl-0 pr-0 shadow-none data-[hover=true]:bg-transparent data-[open=true]:bg-transparent',
  innerWrapper: 'shadow-none',
  mainWrapper: 'shadow-none',
  value: 'pl-0 pr-0 text-sm text-[rgba(248,250,252,0.94)]',
  popoverContent: 'border border-white/10 bg-[rgba(15,23,42,0.92)] text-[rgba(248,250,252,0.94)] backdrop-blur-xl',
  selectorIcon: 'text-[rgba(226,232,240,0.72)]',
  listboxWrapper: 'max-h-60',
};
// HeroUI sizes the popover to the trigger; band labels such as
// "1.25m (222MHz)" need more room than the compact trigger.
const GLOBE_BAND_SELECT_CLASSNAMES = {
  ...GLOBE_SELECT_CLASSNAMES,
  popoverContent: `${GLOBE_SELECT_CLASSNAMES.popoverContent} min-w-[168px]`,
};
// `className` styles the popover element that receives the inline width;
// passing `classNames` here would replace Select's own content slot styles.
const GLOBE_BAND_SELECT_POPOVER_PROPS = { className: 'min-w-[168px]' };
const GLOBE_SELECT_ITEM_CLASS = 'text-[rgba(248,250,252,0.94)] [&_svg]:text-[rgba(248,250,252,0.94)]';

/** Round icon toggle for the globe controls; the label appears on hover. */
const GlobeIconToggle: React.FC<{
  active: boolean;
  icon: IconDefinition;
  label: string;
  onPress: () => void;
}> = ({ active, icon, label, onPress }) => (
  <Tooltip content={label} placement="top" delay={150} closeDelay={0} classNames={GLOBE_TOOLTIP_CLASSNAMES}>
    <button
      type="button"
      onClick={onPress}
      aria-pressed={active}
      aria-label={label}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-full border shadow-[0_10px_30px_rgba(2,6,23,0.28)] backdrop-blur-md transition-all duration-300 ${active
        ? 'border-[rgba(125,211,252,0.3)] bg-[rgba(30,58,95,0.6)] text-[rgba(224,242,254,0.95)] hover:border-[rgba(125,211,252,0.45)]'
        : 'border-white/10 bg-[rgba(15,23,42,0.52)] text-[rgba(226,232,240,0.5)] hover:border-white/20 hover:bg-[rgba(15,23,42,0.68)] hover:text-[rgba(226,232,240,0.8)]'}`}
    >
      <FontAwesomeIcon icon={icon} className="h-3.5 w-3.5" />
    </button>
  </Tooltip>
);

function isReceptionPoint(point: object): point is ReceptionGlobePoint {
  return (point as ReceptionGlobePoint).kind === 'reception';
}

type GlobeControls = {
  autoRotate: boolean;
  autoRotateSpeed: number;
  enableZoom: boolean;
  update?: () => void;
};

type LandTopology = {
  type: 'Topology';
  objects: {
    land: unknown;
  };
};

type GlobeGridPath = WorkedGridLine | {
  kind: 'worked-grid';
  precision: 2 | 4;
  grid: string;
  count: number;
  points: Array<[number, number]>;
};

type GlobeGridTile = {
  grid: string;
  count: number;
  precision: 2 | 4;
  lat: number;
  lng: number;
  width: number;
  height: number;
};

type GlobePolygonGeometry = {
  type: string;
  coordinates: number[];
};

type GlobePointOfView = {
  lat?: number;
  lng?: number;
  altitude?: number;
};

function getLandGeometry(polygon: object): GlobePolygonGeometry {
  return (polygon as Feature<Geometry>).geometry as unknown as GlobePolygonGeometry;
}

function getGridPathColor(path: object): string {
  const gridPath = path as GlobeGridPath;
  if (gridPath.kind === 'worked-grid') {
    return gridPath.precision === 4
      ? 'rgba(248, 113, 113, 0.26)'
      : 'rgba(248, 113, 113, 0.22)';
  }
  return gridPath.precision === 4
    ? 'rgba(248, 113, 113, 0.07)'
    : 'rgba(248, 113, 113, 0.1)';
}

function getGridTileAltitude(tile: object): number {
  return (tile as GlobeGridTile).precision === 4 ? 0.0062 : 0.0054;
}

interface RecentQSOGlobeCardProps {
  active?: boolean;
  logBookId: string;
  qsos: QSORecord[];
  loading: boolean;
  bandFilter?: string;
  /** Sets the logbook band filter shared with the table; omitted hides the globe control. */
  onBandFilterChange?: (band: string | undefined) => void;
  pageSize: number;
  pageSizeOptions: number[];
  onPageSizeChange: (pageSize: number) => void;
  desktopLeftOverlay?: React.ReactNode;
  desktopRightOverlay?: React.ReactNode;
  operators?: OperatorStatus[];
  /** PSK Reporter reports of other stations hearing this logbook's operator. */
  reception?: ReceptionView | null;
  /** Whether the viewer may turn reception feedback on (administrators only). */
  canEnableReception?: boolean;
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

function angularDistanceDegrees(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const lat1Rad = toRadians(lat1);
  const lat2Rad = toRadians(lat2);
  const deltaLngRad = toRadians(lng2 - lng1);
  const cosine = Math.sin(lat1Rad) * Math.sin(lat2Rad)
    + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLngRad);
  const clampedCosine = Math.min(1, Math.max(-1, cosine));
  return Math.acos(clampedCosine) * 180 / Math.PI;
}

function shortestLongitudeDeltaDegrees(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function formatUtcTime(timestamp?: number): string {
  if (!timestamp) {
    return '-';
  }

  return new Date(timestamp).toLocaleString(undefined, {
    timeZone: 'UTC',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const RecentQSOGlobeCard: React.FC<RecentQSOGlobeCardProps> = ({
  active = true,
  logBookId,
  qsos,
  loading,
  bandFilter,
  onBandFilterChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  desktopLeftOverlay,
  desktopRightOverlay,
  operators: operatorsProp,
  reception = null,
  canEnableReception = false,
}) => {
  const { t } = useTranslation('logbook');
  const [stationInfo, setStationInfo] = useState<StationInfo | null>(null);
  const [globeWidth, setGlobeWidth] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showWorkedGrids, setShowWorkedGrids] = useState(false);
  const [showQsoHistory, setShowQsoHistory] = useState(true);
  const [workedGridItems, setWorkedGridItems] = useState<LogBookWorkedGridItem[]>([]);
  const [workedGridLoading, setWorkedGridLoading] = useState(false);
  const [workedGridError, setWorkedGridError] = useState<string | null>(null);
  const [globeAltitude, setGlobeAltitude] = useState(DEFAULT_POV_ALTITUDE);
  const [globeCenter, setGlobeCenter] = useState({ lat: 0, lng: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const activeRef = useRef(active);
  const refreshAnimationRef = useRef<(() => void) | null>(null);
  activeRef.current = active;
  const hasInitialFocusRef = useRef(false);
  const lastFocusKeyRef = useRef<string | null>(null);
  const workedGridCacheRef = useRef<Map<string, LogBookWorkedGridItem[]>>(new Map());
  const lastViewportSyncRef = useRef({ lat: 0, lng: 0, altitude: DEFAULT_POV_ALTITUDE });
  const lastViewportSyncAtRef = useRef(0);
  const viewportHeight = useViewportHeightValue();

  useEffect(() => {
    const globe = globeRef.current;
    const container = containerRef.current;
    if (!globe || !container) return;
    let visible = true;
    const updateAnimation = () => {
      if (!activeRef.current || document.hidden || !visible) globe.pauseAnimation();
      else globe.resumeAnimation();
    };
    refreshAnimationRef.current = updateAnimation;
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      updateAnimation();
    });
    observer?.observe(container);
    document.addEventListener('visibilitychange', updateAnimation);
    updateAnimation();
    return () => {
      refreshAnimationRef.current = null;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', updateAnimation);
    };
  }, []);

  useEffect(() => {
    refreshAnimationRef.current?.();
  }, [active]);
  const globeMaterial = useMemo(() => {
    const material = new THREE.MeshPhongMaterial({
      color: new THREE.Color('#dbeafe'),
      emissive: new THREE.Color('#0f172a'),
      emissiveIntensity: 0.08,
      shininess: 7,
      specular: new THREE.Color('#475569'),
      bumpScale: 0.004,
    });
    return material;
  }, []);
  const workedGridTileMaterial2 = useMemo(() => new THREE.MeshBasicMaterial({
    color: new THREE.Color('rgb(239, 68, 68)'),
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  }), []);
  const workedGridTileMaterial4 = useMemo(() => new THREE.MeshBasicMaterial({
    color: new THREE.Color('rgb(239, 68, 68)'),
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  }), []);

  useEffect(() => () => {
    globeMaterial.dispose();
    workedGridTileMaterial2.dispose();
    workedGridTileMaterial4.dispose();
  }, [globeMaterial, workedGridTileMaterial2, workedGridTileMaterial4]);

  const landPolygons = useMemo(() => {
    const land = feature(landTopology as LandTopology, (landTopology as LandTopology).objects.land);
    return land.type === 'FeatureCollection'
      ? land.features as Feature<Geometry>[]
      : [land as Feature<Geometry>];
  }, []);

  const globeModel = useMemo(() => buildPagedQSOGlobeModel(qsos, stationInfo), [qsos, stationInfo]);
  const operatorsCtx = useContext(OperatorsContext);
  const operators = operatorsProp ?? operatorsCtx?.operators ?? EMPTY_OPERATORS;
  const inProgressModel = useMemo(
    () => buildInProgressQSOGlobeModel(operators, stationInfo),
    [operators, stationInfo],
  );
  const workedGridModel = useMemo(() => buildWorkedGridGlobeModel(workedGridItems), [workedGridItems]);
  const [showReception, setShowReception] = useState(true);
  const [receptionNow, setReceptionNow] = useState(() => Date.now());
  const hasReceptionSpots = (reception?.spots.length ?? 0) > 0;
  useEffect(() => {
    if (!hasReceptionSpots || !active) return;
    setReceptionNow(Date.now());
    const timer = setInterval(() => setReceptionNow(Date.now()), RECEPTION_TICK_MS);
    return () => clearInterval(timer);
  }, [hasReceptionSpots, active, reception]);
  const receptionTargetCalls = useMemo(() => new Set(
    operators
      .filter(op => op.currentSlot !== 'TX6')
      .flatMap(op => [op.context?.targetCall, ...(op.context?.targetCalls ?? [])])
      .flatMap(call => (call ? [call.trim().toUpperCase()] : [])),
  ), [operators]);
  const receptionHome = globeModel.homePoint;
  // The globe follows the logbook band filter, reception included.
  const bandReception = useMemo<ReceptionView | null>(() => (
    reception && bandFilter
      ? {
        ...reception,
        spots: reception.spots.filter(spot => (
          spot.frequency !== undefined && getBandFromFrequency(spot.frequency) === bandFilter
        )),
      }
      : reception
  ), [reception, bandFilter]);
  const [receptionEnableOpen, setReceptionEnableOpen] = useState(false);
  const [receptionEnabling, setReceptionEnabling] = useState(false);
  const [receptionEnableError, setReceptionEnableError] = useState<string | null>(null);
  // The server pushes a new snapshot to every logbook page once the setting
  // changes, so enabling here takes effect without a reload.
  const handleEnableReception = async () => {
    setReceptionEnabling(true);
    setReceptionEnableError(null);
    try {
      await api.updatePSKReporterReceptionConfig({ enabled: true });
      logger.info('Reception feedback enabled from the logbook globe');
      setReceptionEnableOpen(false);
    } catch (error) {
      logger.warn('Enabling reception feedback from the logbook globe failed', error);
      setReceptionEnableError(error instanceof ApiError ? error.userMessage : t('globe.receptionEnableFailed'));
    } finally {
      setReceptionEnabling(false);
    }
  };
  const [receptionPanelOpen, setReceptionPanelOpen] = useState(false);
  const receptionPanelCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearReceptionPanelCloseTimer = () => {
    if (receptionPanelCloseTimerRef.current) {
      clearTimeout(receptionPanelCloseTimerRef.current);
      receptionPanelCloseTimerRef.current = null;
    }
  };
  const openReceptionPanel = () => {
    clearReceptionPanelCloseTimer();
    setReceptionPanelOpen(true);
  };
  const scheduleReceptionPanelClose = () => {
    clearReceptionPanelCloseTimer();
    receptionPanelCloseTimerRef.current = setTimeout(() => {
      receptionPanelCloseTimerRef.current = null;
      setReceptionPanelOpen(false);
    }, RECEPTION_PANEL_CLOSE_DELAY_MS);
  };
  useEffect(() => () => {
    if (receptionPanelCloseTimerRef.current) clearTimeout(receptionPanelCloseTimerRef.current);
  }, []);
  const [receptionThemeId, setReceptionThemeId] = useState<ReceptionThemeId>(loadReceptionThemeId);
  const receptionTheme = getReceptionTheme(receptionThemeId);
  const handleReceptionThemeChange = (id: ReceptionThemeId) => {
    setReceptionThemeId(id);
    saveReceptionThemeId(id);
    logger.info('Page globe reception theme changed', { theme: id });
  };
  const receptionFogColorFn = useMemo(() => () => receptionTheme.fogColor, [receptionTheme]);
  const receptionModel = useMemo(
    () => buildReceptionGlobeModel(bandReception, receptionHome, receptionNow, receptionTargetCalls, receptionTheme),
    [bandReception, receptionHome, receptionNow, receptionTargetCalls, receptionTheme],
  );
  const receptionPings = useReceptionPings(
    receptionModel.stations,
    // A band switch is a new view: its stations appear settled, without rings.
    `${reception?.callsigns.join(',') ?? ''}|${bandFilter ?? ''}`,
    reception !== null,
    showReception && active,
    receptionTheme,
  );
  const defaultGlobeHeight = useMemo(() => {
    const effectiveWidth = globeWidth || GLOBE_WIDTH_FALLBACK;
    return Math.max(GLOBE_HEIGHT_MIN, Math.min(GLOBE_HEIGHT_MAX, Math.round(effectiveWidth * 0.33)));
  }, [globeWidth]);
  const globeHeight = useMemo(() => {
    if (!isExpanded) {
      return defaultGlobeHeight;
    }

    const nextViewportHeight = Math.max(viewportHeight, GLOBE_HEIGHT_MIN);
    return Math.max(GLOBE_HEIGHT_MIN, nextViewportHeight);
  }, [defaultGlobeHeight, isExpanded, viewportHeight]);
  const effectiveGlobeWidth = globeWidth || GLOBE_WIDTH_FALLBACK;
  const hasDesktopOverlay = globeWidth >= 1024 && (!!desktopLeftOverlay || !!desktopRightOverlay);
  const leftOverlayPaddingClassName = isElectron() && isMacOS()
    ? 'px-6 pb-6 pt-14 xl:px-8 xl:pt-16'
    : 'px-6 pb-6 pt-5 xl:px-8 xl:pt-6';

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    let frameId = 0;
    let retryCount = 0;

    const measureWidth = () => {
      const nextWidth = Math.floor(element.getBoundingClientRect().width);
      if (nextWidth > 0) {
        setGlobeWidth(nextWidth);
        return;
      }

      if (retryCount < 10) {
        retryCount += 1;
        frameId = window.requestAnimationFrame(measureWidth);
      }
    };

    const observer = new ResizeObserver((entries) => {
      const nextWidth = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (nextWidth > 0) {
        setGlobeWidth(nextWidth);
      }
    });

    observer.observe(element);
    measureWidth();

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadStationInfo = async () => {
      try {
        const response = await api.getStationInfo();
        if (!cancelled) {
          setStationInfo(response.data ?? null);
          logger.debug('Page globe station info loaded', {
            hasGrid: !!response.data?.qth?.grid,
            hasCoordinates: response.data?.qth?.latitude != null && response.data?.qth?.longitude != null,
          });
        }
      } catch (error) {
        logger.warn('Page globe station info request failed', error);
      }
    };

    loadStationInfo().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    logger.info('Page globe model prepared', {
      qsoCount: globeModel.summary.qsoCount,
      hasHome: !!globeModel.homePoint,
      remotePointCount: globeModel.remotePoints.length,
      arcCount: globeModel.arcs.length,
      droppedInvalidGrid: globeModel.summary.droppedInvalidGrid,
    });
  }, [globeModel]);

  useEffect(() => {
    const activeOperators = operators.filter((op) => op.currentSlot !== 'TX6');
    logger.info('Page globe in-progress model prepared', {
      operatorCount: operators.length,
      activeOperatorCount: activeOperators.length,
      inProgressArcCount: inProgressModel.arcs.length,
      inProgressRingCount: inProgressModel.rings.length,
      firstActiveSlot: activeOperators[0]?.currentSlot,
      firstActiveTargetCall: activeOperators[0]?.context?.targetCall,
      firstActiveTargetGrid: activeOperators[0]?.context?.targetGrid,
    });
  }, [inProgressModel, operators]);

  useEffect(() => {
    if (!showWorkedGrids) {
      return;
    }

    const cacheKey = `${logBookId}:${bandFilter || 'all'}`;
    const cached = workedGridCacheRef.current.get(cacheKey);
    if (cached) {
      workedGridCacheRef.current.delete(cacheKey);
      workedGridCacheRef.current.set(cacheKey, cached);
      setWorkedGridItems(cached);
      setWorkedGridError(null);
      setWorkedGridLoading(false);
      return;
    }

    let cancelled = false;

    const loadWorkedGrids = async () => {
      try {
        setWorkedGridLoading(true);
        setWorkedGridError(null);
        setWorkedGridItems([]);

        logger.info('Requesting worked grids for page globe', {
          logBookId,
          band: bandFilter || null,
        });

        const response = await api.getLogBookWorkedGrids(logBookId, bandFilter ? { band: bandFilter } : undefined);
        if (cancelled) {
          return;
        }

        workedGridCacheRef.current.set(cacheKey, response.data.items);
        while (workedGridCacheRef.current.size > WORKED_GRID_CACHE_LIMIT) {
          const oldestKey = workedGridCacheRef.current.keys().next().value;
          if (!oldestKey) {
            break;
          }
          workedGridCacheRef.current.delete(oldestKey);
        }
        setWorkedGridItems(response.data.items);
        logger.info('Worked grids for page globe loaded', {
          logBookId,
          band: bandFilter || null,
          count: response.data.items.length,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        logger.warn('Worked grids for page globe request failed', error);
        setWorkedGridItems([]);
        setWorkedGridError(t('globe.workedGridLoadFailed'));
      } finally {
        if (!cancelled) {
          setWorkedGridLoading(false);
        }
      }
    };

    loadWorkedGrids().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [bandFilter, logBookId, showWorkedGrids, t]);

  useEffect(() => {
    if (!globeRef.current || !globeModel.homePoint || loading) {
      return;
    }

    const controls = globeRef.current.controls() as unknown as GlobeControls;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.enableZoom = true;
    controls.update?.();

    const focusKey = `${globeModel.homePoint.grid}:${globeModel.homePoint.lat.toFixed(3)}:${globeModel.homePoint.lng.toFixed(3)}`;
    if (lastFocusKeyRef.current === focusKey) {
      return;
    }

    const animationDuration = hasInitialFocusRef.current
      ? FOCUS_POV_ANIMATION_MS
      : INITIAL_POV_ANIMATION_MS;

    logger.info('Page globe camera focus changed', {
      grid: globeModel.homePoint.grid,
      lat: globeModel.homePoint.lat,
      lng: globeModel.homePoint.lng,
      durationMs: animationDuration,
    });

    globeRef.current.pointOfView({
      lat: globeModel.homePoint.lat,
      lng: globeModel.homePoint.lng,
      altitude: DEFAULT_POV_ALTITUDE,
    }, animationDuration);
    setGlobeAltitude(DEFAULT_POV_ALTITUDE);
    setGlobeCenter({
      lat: globeModel.homePoint.lat,
      lng: globeModel.homePoint.lng,
    });

    hasInitialFocusRef.current = true;
    lastFocusKeyRef.current = focusKey;
  }, [globeModel.homePoint, loading]);

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || typeof globe.lights !== 'function') {
      return;
    }

    globe.lights().forEach((light) => {
      if (light instanceof THREE.DirectionalLight) {
        light.intensity = 1.65;
        light.position.set(1.4, 1.1, 1.2);
      }
      if (light instanceof THREE.AmbientLight) {
        light.intensity = 0.95;
      }
    });
  }, [globeModel]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    if (!isExpanded) {
      return;
    }

    const htmlStyle = document.documentElement.style;
    const bodyStyle = document.body.style;
    const previousHtmlOverflow = htmlStyle.overflow;
    const previousBodyOverflow = bodyStyle.overflow;
    const previousOverscrollBehavior = bodyStyle.overscrollBehavior;

    window.scrollTo({ top: 0, behavior: 'smooth' });
    htmlStyle.overflow = 'hidden';
    bodyStyle.overflow = 'hidden';
    bodyStyle.overscrollBehavior = 'none';

    return () => {
      htmlStyle.overflow = previousHtmlOverflow;
      bodyStyle.overflow = previousBodyOverflow;
      bodyStyle.overscrollBehavior = previousOverscrollBehavior;
    };
  }, [isExpanded]);

  const hasRenderableData = !!globeModel.homePoint && globeModel.remotePoints.length > 0;
  const shouldShowStatusOverlay = loading || !hasRenderableData;
  const statusMessage = loading
    ? t('globe.loadingCurrentPage')
    : !globeModel.homePoint
      ? t('globe.missingHomeCurrentPage')
      : t('globe.emptyCurrentPage');
  const visibleReceptionPoints = showReception ? receptionModel.points : null;
  const visiblePoints = useMemo<GlobePointDatum[]>(() => {
    const historyPoints = showQsoHistory ? globeModel.remotePoints : [];
    const stationPoints: GlobePointDatum[] = loading || !hasRenderableData
      ? []
      : globeModel.homePoint
        ? [globeModel.homePoint, ...historyPoints]
        : historyPoints;
    return visibleReceptionPoints && visibleReceptionPoints.length > 0
      ? [...visibleReceptionPoints, ...stationPoints]
      : stationPoints;
  }, [loading, hasRenderableData, globeModel.homePoint, globeModel.remotePoints, showQsoHistory, visibleReceptionPoints]);
  const visibleArcs = useMemo(() => loading || !hasRenderableData || !showQsoHistory
    ? inProgressModel.arcs
    : [...globeModel.arcs, ...inProgressModel.arcs], [loading, hasRenderableData, showQsoHistory, globeModel.arcs, inProgressModel.arcs]);
  // globe.gl binds one mesh per datum object. Reusing the same datum keeps the
  // mesh (and its patched material) across updates; only the KDE is recomputed.
  const receptionFogDatum = useMemo(() => ({ points: [] as ReceptionHeatPoint[] }), []);
  // The glow only changes when the quantised points do, and at most every few
  // seconds; the density pass is expensive without WebGPU.
  const heatSignature = getReceptionHeatSignature(receptionModel.heatPoints);
  const latestHeatPointsRef = useRef(receptionModel.heatPoints);
  latestHeatPointsRef.current = receptionModel.heatPoints;
  const [fogHeatPoints, setFogHeatPoints] = useState<ReceptionHeatPoint[]>(EMPTY_HEAT_POINTS);
  const lastFogUpdateAtRef = useRef(0);
  useEffect(() => {
    const apply = () => {
      lastFogUpdateAtRef.current = Date.now();
      setFogHeatPoints(latestHeatPointsRef.current);
    };
    const wait = RECEPTION_FOG_MIN_INTERVAL_MS - (Date.now() - lastFogUpdateAtRef.current);
    // Appearing or clearing is immediate; only refinements are spaced out.
    if (wait <= 0 || heatSignature === '' || fogHeatPoints.length === 0) {
      apply();
      return;
    }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
    // Keyed by the signature on purpose: the latest points are read from a ref.
  }, [heatSignature]);
  const receptionHeatmaps = useMemo<object[]>(() => {
    if (!showReception || fogHeatPoints.length === 0) {
      return EMPTY_HEATMAPS;
    }
    receptionFogDatum.points = fogHeatPoints;
    return [receptionFogDatum];
  }, [showReception, fogHeatPoints, receptionFogDatum]);
  const receptionFogVisible = receptionHeatmaps.length > 0;
  useEffect(() => {
    if (receptionHeatmaps.length === 0) return;
    let frame = 0;
    let remaining = RECEPTION_FOG_PATCH_FRAMES;
    // The layer applies data on later frames and may (re)create the mesh at any
    // of them, so every heatmap mesh is patched for a fixed number of frames
    // instead of stopping at the first one found.
    const patch = () => {
      applyHeatmapGlowMaterial(globeRef.current);
      if (--remaining > 0) {
        frame = window.requestAnimationFrame(patch);
      }
    };
    patch();
    return () => window.cancelAnimationFrame(frame);
  }, [receptionHeatmaps]);
  const visibleReceptionRings = showReception ? receptionModel.targetRings : null;
  const visibleRings = useMemo(() => {
    const historyRings = showQsoHistory
      ? globeModel.rings
      : globeModel.homeRing ? [globeModel.homeRing] : [];
    const rings = loading || !hasRenderableData
      ? inProgressModel.rings
      : [...historyRings, ...inProgressModel.rings];
    // Reception rings come first so the in-progress rings draw above them.
    return visibleReceptionRings && (visibleReceptionRings.length > 0 || receptionPings.length > 0)
      ? [...visibleReceptionRings, ...receptionPings, ...rings]
      : rings;
  }, [loading, hasRenderableData, showQsoHistory, globeModel.rings, globeModel.homeRing, inProgressModel.rings, visibleReceptionRings, receptionPings]);
  const receptionStationCount = receptionModel.stations.length;
  const showReceptionOffEntry = reception?.state === 'disabled' && reception.callsigns.length > 0;
  // Shown whenever the feature is on, so the feed state is always visible.
  const showReceptionChip = !!reception && reception.state !== 'disabled' && reception.callsigns.length > 0;
  const receptionStatus: 'heard' | 'waiting' | 'connecting' | 'reconnecting' = receptionStationCount > 0
    ? 'heard'
    : reception?.state === 'live'
      ? 'waiting'
      : reception?.state === 'reconnecting'
        ? 'reconnecting'
        : 'connecting';
  const receptionTooltip = useMemo(() => {
    const callsign = reception?.callsigns.join(', ') ?? '';
    if (receptionStationCount === 0) {
      const statusKey = receptionStatus === 'waiting'
        ? 'globe.receptionStatusWaiting'
        : receptionStatus === 'reconnecting'
          ? 'globe.receptionStatusReconnecting'
          : 'globe.receptionStatusConnecting';
      return (
        <div className="max-w-[280px] space-y-2 px-1 py-1.5 text-xs">
          <p className="font-medium">{t(statusKey, { callsign })}</p>
          <p className={GLOBE_TOOLTIP_MUTED_CLASS}>{t('globe.receptionDelayNote')}</p>
          <p className={`text-[10px] leading-snug ${GLOBE_TOOLTIP_FAINT_CLASS}`}>{RECEPTION_CREDIT}</p>
        </div>
      );
    }
    const farthestStations = [...receptionModel.stations]
      .filter(station => station.distanceKm !== undefined)
      .sort((left, right) => (right.distanceKm ?? 0) - (left.distanceKm ?? 0))
      .slice(0, RECEPTION_TOOLTIP_STATION_LIMIT);
    const latestMinutes = receptionModel.latestReportAt
      ? Math.max(0, Math.round((receptionNow - receptionModel.latestReportAt) / 60_000))
      : null;
    return (
      <div className="max-w-[280px] space-y-2 px-1 py-1.5 text-xs">
        <p className="font-medium">{t('globe.receptionTooltipTitle', { callsign })}</p>
        {farthestStations.length > 0 && (
          <ul className="space-y-0.5 font-mono text-[11px]">
            {farthestStations.map(station => (
              <li key={station.callsign} className="flex justify-between gap-4">
                <span>{station.callsign}</span>
                <span className={GLOBE_TOOLTIP_MUTED_CLASS}>{Math.round(station.distanceKm ?? 0).toLocaleString()} km</span>
              </li>
            ))}
          </ul>
        )}
        {latestMinutes !== null && (
          <p className={GLOBE_TOOLTIP_MUTED_CLASS}>{t('globe.receptionLatest', { count: latestMinutes })}</p>
        )}
        <p className={GLOBE_TOOLTIP_MUTED_CLASS}>{t('globe.receptionDelayNote')}</p>
        <p className={`text-[10px] leading-snug ${GLOBE_TOOLTIP_FAINT_CLASS}`}>{RECEPTION_CREDIT}</p>
      </div>
    );
  }, [receptionModel, receptionStationCount, receptionStatus, receptionNow, reception?.callsigns, t]);
  const useFourCharacterWorkedGrid = globeAltitude <= WORKED_GRID_SWITCH_ALTITUDE;
  const activeWorkedGridPolygons = showWorkedGrids
    ? (useFourCharacterWorkedGrid ? workedGridModel.precision4.polygons : workedGridModel.precision2.polygons)
    : [];
  const maxVisibleAngularDistance = useFourCharacterWorkedGrid
    ? Math.max(18, Math.min(42, 12 + globeAltitude * 12))
    : Math.max(
      WORKED_GRID_MIN_VISIBLE_DEGREES,
      Math.min(WORKED_GRID_MAX_VISIBLE_DEGREES, 24 + globeAltitude * 26),
    );
  const baseGridLatWindow = useFourCharacterWorkedGrid
    ? Math.max(5, Math.min(18, 3 + globeAltitude * 8))
    : Math.max(10, Math.min(46, 7 + globeAltitude * 18));
  const baseGridLngWindow = useFourCharacterWorkedGrid
    ? Math.max(7, Math.min(26, 5 + globeAltitude * 10))
    : Math.max(14, Math.min(64, 10 + globeAltitude * 24));
  const visibleWorkedGridPolygons = useMemo(
    () => activeWorkedGridPolygons.filter((polygon) => {
      const bounds = getGridBounds(polygon.grid);
      if (!bounds) {
        return false;
      }

      return angularDistanceDegrees(globeCenter.lat, globeCenter.lng, bounds.centerLat, bounds.centerLon) <= maxVisibleAngularDistance;
    }),
    [activeWorkedGridPolygons, globeCenter.lat, globeCenter.lng, maxVisibleAngularDistance],
  );
  const activeWorkedGridLabels = useMemo(
    () => (showWorkedGrids
      ? (useFourCharacterWorkedGrid
        ? workedGridModel.precision4.labels
        : workedGridModel.precision2.labels)
        .filter((label) => angularDistanceDegrees(globeCenter.lat, globeCenter.lng, label.lat, label.lng) <= maxVisibleAngularDistance)
        .slice(0, WORKED_GRID_LABEL_LIMIT)
      : []),
    [globeCenter.lat, globeCenter.lng, maxVisibleAngularDistance, showWorkedGrids, useFourCharacterWorkedGrid, workedGridModel.precision2.labels, workedGridModel.precision4.labels],
  );
  const pathsData = useMemo(() => {
    if (!showWorkedGrids) {
      return [];
    }

    const result: GlobeGridPath[] = [
      ...getMaidenheadGridLines(useFourCharacterWorkedGrid ? 4 : 2).filter((line) => {
        if (line.axis === 'lat') {
          return Math.abs(line.value - globeCenter.lat) <= baseGridLatWindow;
        }
        return shortestLongitudeDeltaDegrees(line.value, globeCenter.lng) <= baseGridLngWindow;
      }),
    ];

    for (const polygon of visibleWorkedGridPolygons) {
      const bounds = getGridBounds(polygon.grid);
      if (!bounds) {
        continue;
      }

      result.push({
        kind: 'worked-grid',
        precision: polygon.precision,
        grid: polygon.grid,
        count: polygon.count,
        points: [
          [bounds.latMin, bounds.lonMin],
          [bounds.latMin, bounds.lonMax],
          [bounds.latMax, bounds.lonMax],
          [bounds.latMax, bounds.lonMin],
          [bounds.latMin, bounds.lonMin],
        ],
      });
    }

    return result;
  }, [
    baseGridLatWindow,
    baseGridLngWindow,
    globeCenter.lat,
    globeCenter.lng,
    showWorkedGrids,
    useFourCharacterWorkedGrid,
    visibleWorkedGridPolygons,
  ]);
  const tilesData = useMemo(() => {
    if (!showWorkedGrids) {
      return [];
    }

    return visibleWorkedGridPolygons.map((polygon) => {
      const bounds = getGridBounds(polygon.grid);
      if (!bounds) {
        return null;
      }

      return {
        grid: polygon.grid,
        count: polygon.count,
        precision: polygon.precision,
        lat: bounds.centerLat,
        lng: bounds.centerLon,
        width: bounds.lonMax - bounds.lonMin,
        height: bounds.latMax - bounds.latMin,
      };
    }).filter((tile): tile is GlobeGridTile => !!tile);
  }, [showWorkedGrids, visibleWorkedGridPolygons]);
  const workedGridStatusText = !showWorkedGrids
    ? null
    : workedGridLoading
      ? t('globe.workedGridLoading')
      : workedGridError
        ? workedGridError
        : workedGridItems.length === 0
          ? t('globe.workedGridEmpty')
        : t('globe.workedGridLoaded', {
            count: workedGridItems.length,
            precision: useFourCharacterWorkedGrid ? 4 : 2,
          });

  const syncViewportState = (pov: GlobePointOfView, force = false) => {
    const nextLat = pov.lat ?? 0;
    const nextLng = pov.lng ?? 0;
    const nextAltitude = pov.altitude ?? lastViewportSyncRef.current.altitude;
    const previous = lastViewportSyncRef.current;

    if (!force && !showWorkedGrids) {
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const centerDelta = angularDistanceDegrees(previous.lat, previous.lng, nextLat, nextLng);
    const altitudeDelta = Math.abs(previous.altitude - nextAltitude);
    const precisionChanged = (previous.altitude <= WORKED_GRID_SWITCH_ALTITUDE) !== (nextAltitude <= WORKED_GRID_SWITCH_ALTITUDE);
    const centerThreshold = showWorkedGrids ? POV_SYNC_CENTER_EPSILON_WITH_GRIDS : POV_SYNC_CENTER_EPSILON_IDLE;
    const shouldSync = force
      || precisionChanged
      || now - lastViewportSyncAtRef.current >= POV_SYNC_INTERVAL_MS
      || centerDelta >= centerThreshold
      || altitudeDelta >= POV_SYNC_ALTITUDE_EPSILON;

    if (!shouldSync) {
      return;
    }

    lastViewportSyncRef.current = {
      lat: nextLat,
      lng: nextLng,
      altitude: nextAltitude,
    };
    lastViewportSyncAtRef.current = now;

    setGlobeCenter((currentValue) => (
      currentValue.lat === nextLat && currentValue.lng === nextLng
        ? currentValue
        : { lat: nextLat, lng: nextLng }
    ));
    setGlobeAltitude((currentValue) => (
      Math.abs(currentValue - nextAltitude) < 0.0001
        ? currentValue
        : nextAltitude
    ));
  };

  useEffect(() => {
    if (!showWorkedGrids || !globeRef.current) {
      return;
    }

    syncViewportState(globeRef.current.pointOfView(), true);
  }, [showWorkedGrids]);

  // Trackpad drag pans and pinch zooms like a native map; they bypass
  // OrbitControls, so the view state is synced here instead of in onZoom.
  useGlobeTrackpadGestures(containerRef, globeRef, (view) => syncViewportState(view));

  const handleExpandedToggle = () => {
    setIsExpanded((currentValue) => {
      const nextValue = !currentValue;
      logger.info('Page globe expanded state changed', {
        expanded: nextValue,
        viewportHeight,
      });
      return nextValue;
    });
  };
  const handlePageSizeChange = (keys: 'all' | Set<React.Key>) => {
    const selectedKey = keys === 'all' ? null : Array.from(keys)[0];
    const nextValue = Number(selectedKey);
    if (!Number.isFinite(nextValue) || nextValue <= 0 || nextValue === pageSize) {
      return;
    }

    logger.info('Page globe page size changed', { pageSize: nextValue });
    onPageSizeChange(nextValue);
  };
  const handleWorkedGridToggle = () => {
    setShowWorkedGrids((currentValue) => {
      const nextValue = !currentValue;
      logger.info('Page globe worked grid visibility changed', {
        enabled: nextValue,
        logBookId,
        band: bandFilter || null,
      });
      return nextValue;
    });
  };

  return (
    <section
      ref={containerRef}
      data-logbook-globe-banner="true"
      className="relative w-full overflow-hidden border-b border-default-200/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.18),transparent_30%),radial-gradient(circle_at_bottom,rgba(249,115,22,0.16),transparent_26%),linear-gradient(180deg,rgba(2,6,23,0.98),rgba(6,10,20,1))] transition-[min-height,height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
      style={{ minHeight: globeHeight, height: globeHeight }}
    >
      <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(circle_at_18%_18%,rgba(255,255,255,0.16),transparent_1.2%),radial-gradient(circle_at_82%_15%,rgba(255,255,255,0.12),transparent_1%),radial-gradient(circle_at_32%_76%,rgba(255,255,255,0.12),transparent_1%),radial-gradient(circle_at_70%_66%,rgba(255,255,255,0.10),transparent_1%),radial-gradient(circle_at_50%_50%,rgba(125,211,252,0.08),transparent_12%)] opacity-80" />

      <Globe
        ref={globeRef}
        width={effectiveGlobeWidth}
        height={globeHeight}
        backgroundColor="rgba(0,0,0,0)"
        backgroundImageUrl={STARFIELD_URL}
        globeImageUrl={EARTH_TEXTURE_URL}
        bumpImageUrl={EARTH_BUMP_URL}
        waitForGlobeReady={false}
        animateIn
        globeMaterial={globeMaterial}
        showGraticules={false}
        showAtmosphere
        atmosphereColor="#7dd3fc"
        atmosphereAltitude={0.17}
        polygonsData={landPolygons as object[]}
        polygonGeoJsonGeometry={getLandGeometry}
        polygonAltitude={0.0025}
        polygonCapColor={receptionFogVisible ? getDimmedLandCapColor : getLandCapColor}
        polygonSideColor={() => 'rgba(51, 65, 85, 0.08)'}
        polygonStrokeColor={receptionFogVisible ? getDimmedLandStrokeColor : getLandStrokeColor}
        pathsData={pathsData as object[]}
        pathPoints="points"
        pathPointLat={(point) => (point as [number, number])[0]}
        pathPointLng={(point) => (point as [number, number])[1]}
        pathColor={getGridPathColor}
        pathStroke={null}
        pathPointAlt={0.007}
        pathResolution={1}
        pathTransitionDuration={0}
        heatmapsData={receptionHeatmaps}
        heatmapPoints="points"
        heatmapPointLat="lat"
        heatmapPointLng="lng"
        heatmapPointWeight="weight"
        heatmapBandwidth={RECEPTION_FOG_BANDWIDTH}
        heatmapColorFn={receptionFogColorFn}
        heatmapColorSaturation={1.6}
        heatmapBaseAltitude={RECEPTION_FOG_ALTITUDE}
        heatmapsTransitionDuration={RECEPTION_FOG_TRANSITION_MS}
        tilesData={tilesData as object[]}
        tileLat="lat"
        tileLng="lng"
        tileWidth="width"
        tileHeight="height"
        tileAltitude={getGridTileAltitude}
        tileMaterial={(tile: object) => ((tile as GlobeGridTile).precision === 4 ? workedGridTileMaterial4 : workedGridTileMaterial2)}
        tileCurvatureResolution={2}
        tilesTransitionDuration={0}
        tileLabel={(tile) => {
          const workedTile = tile as GlobeGridTile;
          return `${workedTile.grid} · ${t('globe.pointCount', { count: workedTile.count })}`;
        }}
        pointsData={visiblePoints}
        pointLat="lat"
        pointLng="lng"
        pointAltitude={(point) => (isReceptionPoint(point)
          ? RECEPTION_POINT_ALTITUDE
          : (point as GlobeStationPoint).isHome ? 0.06 : 0.012)}
        pointRadius="size"
        pointResolution={10}
        pointColor="color"
        pointLabel={(point) => {
          if (isReceptionPoint(point)) {
            return buildReceptionPointCardHtml(point.station, receptionTheme, Date.now(), t);
          }
          const stationPoint = point as GlobeStationPoint;
          return stationPoint.isHome
            ? `${t('globe.homeLabel')}${stationPoint.grid ? ` · ${stationPoint.grid}` : ''}`
            : `${stationPoint.grid} · ${t('globe.pointCount', { count: stationPoint.count })}${stationPoint.callsigns.length > 0 ? `<br/>${stationPoint.callsigns.join(', ')}` : ''}`;
        }}
        arcsData={visibleArcs}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcColor="color"
        arcAltitude="altitude"
        arcStroke="stroke"
        arcCurveResolution={48}
        arcCircularResolution={6}
        arcDashLength="dashLength"
        arcDashGap="dashGap"
        arcDashAnimateTime="dashAnimateTime"
        arcLabel={(arc) => {
          const globeArc = arc as GlobeArc;
          return `${globeArc.callsign} · ${globeArc.grid}<br/>${globeArc.mode} · ${(globeArc.frequency / 1_000_000).toFixed(3)} MHz<br/>${formatUtcTime(globeArc.startTime)} UTC`;
        }}
        ringsData={visibleRings}
        ringLat="lat"
        ringLng="lng"
        ringColor="color"
        ringAltitude={0.01}
        ringMaxRadius="maxRadius"
        ringPropagationSpeed="propagationSpeed"
        ringRepeatPeriod="repeatPeriod"
        labelsData={activeWorkedGridLabels as object[]}
        labelLat="lat"
        labelLng="lng"
        labelText="text"
        labelColor={() => 'rgba(254,226,226,0.92)'}
        labelAltitude={0.012}
        labelSize={(label) => ((label as WorkedGridLabel).precision === 4 ? 0.42 : 0.7)}
        labelResolution={2}
        labelIncludeDot={false}
        labelLabel={(label) => {
          const workedGridLabel = label as WorkedGridLabel;
          return `${workedGridLabel.grid} · ${t('globe.pointCount', { count: workedGridLabel.count })}`;
        }}
        onGlobeReady={() => {
          logger.info('Page globe renderer ready', {
            width: effectiveGlobeWidth,
            height: globeHeight,
          });
          if (!globeRef.current) {
            return;
          }

          const controls = globeRef.current.controls() as unknown as GlobeControls;
          controls.autoRotate = true;
          controls.autoRotateSpeed = 0.35;
          controls.update?.();

          const pov = globeRef.current.pointOfView();
          syncViewportState(pov, true);
        }}
        onZoom={(pov) => {
          const controls = globeRef.current?.controls() as GlobeControls | undefined;
          if (controls) {
            controls.autoRotate = false;
          }
          syncViewportState(pov);
        }}
      />

      {shouldShowStatusOverlay && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6 text-center">
          <div className="rounded-full border border-white/10 bg-[rgba(2,6,23,0.5)] px-4 py-2 backdrop-blur-md">
            <div className="flex items-center gap-3 text-sm text-[rgba(226,232,240,0.82)]">
              {loading && <Spinner size="sm" />}
              <span>{statusMessage}</span>
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 left-4 z-30 flex flex-wrap items-center gap-2 sm:bottom-5 sm:left-5 lg:bottom-6 lg:left-6">
        <button
          type="button"
          onClick={handleExpandedToggle}
          aria-pressed={isExpanded}
          aria-label={isExpanded ? t('globe.exitFullscreen') : t('globe.enterFullscreen')}
          className="group inline-flex h-10 items-center justify-center rounded-full border border-white/10 bg-[rgba(15,23,42,0.52)] px-3 text-sm text-[rgba(226,232,240,0.84)] shadow-[0_10px_30px_rgba(2,6,23,0.28)] backdrop-blur-md transition-all duration-300 hover:border-white/20 hover:bg-[rgba(15,23,42,0.68)] hover:text-[rgba(248,250,252,0.96)]"
        >
          <span className="flex h-4 w-4 items-center justify-center">
            {isExpanded ? (
              <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M6 2H2v4M10 2h4v4M2 10v4h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6 2 2 6M10 2l4 4M6 14l-4-4M10 14l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M6 2H2v4M10 2h4v4M2 10v4h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6 6 2 2M10 6l4-4M6 10l-4 4M10 10l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        </button>

        <div className="flex h-10 items-center rounded-full border border-white/10 bg-[rgba(15,23,42,0.52)] pl-4 pr-2 text-sm text-[rgba(226,232,240,0.84)] shadow-[0_10px_30px_rgba(2,6,23,0.28)] backdrop-blur-md transition-all duration-300 hover:border-white/20 hover:bg-[rgba(15,23,42,0.68)]">
          <Select
            aria-label={t('globe.displayCount')}
            selectedKeys={[String(pageSize)]}
            disallowEmptySelection
            selectionMode="single"
            variant="flat"
            size="sm"
            className="w-[116px] min-w-[116px]"
            listboxProps={GLOBE_SELECT_LISTBOX_PROPS}
            classNames={GLOBE_SELECT_CLASSNAMES}
            onSelectionChange={handlePageSizeChange}
            renderValue={() => (
              <span className="text-sm text-[rgba(248,250,252,0.94)]">
                {t('globe.displayCountOption', { count: pageSize })}
              </span>
            )}
          >
            {pageSizeOptions.map((option) => (
              <SelectItem
                key={String(option)}
                textValue={t('globe.displayCountOption', { count: option })}
                className={GLOBE_SELECT_ITEM_CLASS}
              >
                {t('globe.displayCountOption', { count: option })}
              </SelectItem>
            ))}
          </Select>
        </div>

        {onBandFilterChange && (
          <div className={`flex h-10 items-center rounded-full border bg-[rgba(15,23,42,0.52)] pl-4 pr-2 text-sm text-[rgba(226,232,240,0.84)] shadow-[0_10px_30px_rgba(2,6,23,0.28)] backdrop-blur-md transition-all duration-300 hover:bg-[rgba(15,23,42,0.68)] ${bandFilter
            ? 'border-[rgba(125,211,252,0.32)] hover:border-[rgba(125,211,252,0.45)]'
            : 'border-white/10 hover:border-white/20'}`}
          >
            <Select
              aria-label={t('globe.bandFilter')}
              selectedKeys={[bandFilter || GLOBE_ALL_BANDS_KEY]}
              disallowEmptySelection
              selectionMode="single"
              variant="flat"
              size="sm"
              className="w-[92px] min-w-[92px]"
              listboxProps={GLOBE_SELECT_LISTBOX_PROPS}
              classNames={GLOBE_BAND_SELECT_CLASSNAMES}
              popoverProps={GLOBE_BAND_SELECT_POPOVER_PROPS}
              onSelectionChange={(keys) => {
                const selected = keys === 'all' ? undefined : String(Array.from(keys)[0] ?? '');
                if (!selected) return;
                const next = selected === GLOBE_ALL_BANDS_KEY ? undefined : selected;
                if (next === bandFilter) return;
                logger.info('Page globe band filter changed', { band: next ?? null });
                onBandFilterChange(next);
              }}
              renderValue={() => (
                <span className="text-sm text-[rgba(248,250,252,0.94)]">
                  {bandFilter || t('globe.allBands')}
                </span>
              )}
            >
              {[
                <SelectItem key={GLOBE_ALL_BANDS_KEY} textValue={t('globe.allBands')} className={GLOBE_SELECT_ITEM_CLASS}>
                  {t('globe.allBands')}
                </SelectItem>,
                ...LOGBOOK_BAND_OPTIONS.map(option => (
                  <SelectItem key={option.key} textValue={option.label} className={GLOBE_SELECT_ITEM_CLASS}>
                    {option.label}
                  </SelectItem>
                )),
              ]}
            </Select>
          </div>
        )}

        <GlobeIconToggle
          active={showQsoHistory}
          icon={faClockRotateLeft}
          label={showQsoHistory ? t('globe.hideQsoHistory') : t('globe.showQsoHistory')}
          onPress={() => setShowQsoHistory(value => !value)}
        />

        <GlobeIconToggle
          active={showWorkedGrids}
          icon={faTableCells}
          label={showWorkedGrids ? t('globe.hideWorkedGrids') : t('globe.showWorkedGrids')}
          onPress={handleWorkedGridToggle}
        />

        {showReceptionChip && (
          <div
            className="relative"
            onMouseEnter={openReceptionPanel}
            onMouseLeave={scheduleReceptionPanelClose}
            onFocus={openReceptionPanel}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                scheduleReceptionPanelClose();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setReceptionPanelOpen(false);
            }}
          >
            <button
              type="button"
              onClick={() => setShowReception(value => !value)}
              aria-pressed={showReception}
              aria-label={showReception ? t('globe.receptionHide') : t('globe.receptionShow')}
              className={`inline-flex h-10 items-center gap-2.5 rounded-full border bg-[rgba(15,23,42,0.52)] px-4 text-sm shadow-[0_10px_30px_rgba(2,6,23,0.28)] backdrop-blur-md transition-all duration-300 hover:bg-[rgba(15,23,42,0.68)] ${showReception
                ? 'text-[rgba(226,232,240,0.84)]'
                : 'border-white/10 text-[rgba(226,232,240,0.5)] hover:border-white/20'}`}
              style={showReception ? { borderColor: `rgba(${receptionTheme.accentRgb}, 0.32)` } : undefined}
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${!showReception
                  ? 'bg-[rgba(148,163,184,0.6)]'
                  : receptionStatus === 'reconnecting'
                    ? 'animate-pulse bg-[rgb(251,191,36)]'
                    : receptionStatus === 'connecting'
                      ? 'animate-pulse'
                      : ''}`}
                style={!showReception || receptionStatus === 'reconnecting'
                  ? undefined
                  : receptionStatus === 'waiting'
                    ? { border: `1.5px solid rgb(${receptionTheme.accentRgb})` }
                    : {
                      background: receptionTheme.swatch,
                      opacity: receptionStatus === 'connecting' ? 0.6 : 1,
                      boxShadow: receptionStatus === 'heard' ? `0 0 8px rgba(${receptionTheme.accentRgb}, 0.8)` : undefined,
                    }}
              />
              {receptionStationCount > 0 ? (
                <span className="whitespace-nowrap">
                  {t('globe.receptionStations', { count: receptionStationCount })}
                  {receptionModel.farthest?.distanceKm !== undefined && (
                    <span className="hidden sm:inline">
                      <span className="mx-1.5 text-[rgba(226,232,240,0.36)]">·</span>
                      {t('globe.receptionFarthest', {
                        distance: Math.round(receptionModel.farthest.distanceKm).toLocaleString(),
                      })}
                    </span>
                  )}
                </span>
              ) : (
                <span className="whitespace-nowrap">
                  {receptionStatus === 'waiting'
                    ? t('globe.receptionWaiting')
                    : receptionStatus === 'reconnecting'
                      ? t('globe.receptionReconnecting')
                      : t('globe.receptionConnecting')}
                </span>
              )}
            </button>

            {receptionPanelOpen && (
              // The bottom padding bridges the gap to the chip so the pointer
              // can move into the panel without closing it.
              <div className="absolute bottom-full left-0 z-40 pb-2">
                <div className={`w-[300px] rounded-xl p-2.5 ${GLOBE_TOOLTIP_CLASSNAMES.content}`}>
                  {receptionTooltip}
                  <div className="mt-2 border-t border-white/10 px-1 pt-2.5 text-xs">
                    <p className={GLOBE_TOOLTIP_MUTED_CLASS}>
                      {t('globe.receptionTheme')}
                      <span className="mx-1.5 text-[rgba(148,163,184,0.5)]">·</span>
                      <span className="text-[rgba(226,232,240,0.94)]">{t(receptionTheme.labelKey)}</span>
                    </p>
                    <div role="radiogroup" aria-label={t('globe.receptionTheme')} className="mt-2.5 flex items-center gap-3 pb-1">
                      {RECEPTION_THEMES.map(theme => {
                        const selected = theme.id === receptionTheme.id;
                        return (
                          <button
                            key={theme.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            aria-label={t(theme.labelKey)}
                            title={t(theme.labelKey)}
                            onClick={() => handleReceptionThemeChange(theme.id)}
                            className={`h-6 w-6 rounded-full transition-all duration-200 ${selected
                              ? 'scale-110 ring-2 ring-[rgba(248,250,252,0.85)] ring-offset-2 ring-offset-[rgb(15,23,42)]'
                              : 'opacity-60 hover:scale-105 hover:opacity-100'}`}
                            style={{ background: theme.swatch }}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {showReceptionOffEntry && (
          <Popover
            placement="top-start"
            isOpen={receptionEnableOpen}
            onOpenChange={(open) => {
              setReceptionEnableOpen(open);
              if (!open) setReceptionEnableError(null);
            }}
            classNames={{ content: GLOBE_TOOLTIP_CLASSNAMES.content }}
          >
            <PopoverTrigger>
              <button
                type="button"
                aria-label={t('globe.receptionOffTitle')}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[rgba(15,23,42,0.52)] text-[rgba(226,232,240,0.5)] shadow-[0_10px_30px_rgba(2,6,23,0.28)] backdrop-blur-md transition-all duration-300 hover:border-[rgba(45,212,191,0.36)] hover:bg-[rgba(15,23,42,0.68)] hover:text-[rgb(94,234,212)]"
              >
                <FontAwesomeIcon icon={faTowerBroadcast} className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="w-[300px] space-y-3 px-1.5 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faTowerBroadcast} className="h-3.5 w-3.5 text-[rgb(94,234,212)]" />
                  <p className="text-sm font-medium">{t('globe.receptionOffTitle')}</p>
                </div>
                <p className={`leading-relaxed ${GLOBE_TOOLTIP_MUTED_CLASS}`}>
                  {t('globe.receptionOffDesc', { callsign: reception?.callsigns.join(', ') ?? '' })}
                </p>
                {canEnableReception ? (
                  <div className="space-y-2">
                    <Button
                      size="sm"
                      radius="full"
                      className="w-full bg-[rgba(45,212,191,0.9)] font-medium text-[rgb(4,47,46)]"
                      isLoading={receptionEnabling}
                      onPress={() => { void handleEnableReception(); }}
                    >
                      {t('globe.receptionEnable')}
                    </Button>
                    {receptionEnableError && (
                      <p className="text-[rgb(252,165,165)]">{receptionEnableError}</p>
                    )}
                    <p className={GLOBE_TOOLTIP_FAINT_CLASS}>{t('globe.receptionEnableSettingsHint')}</p>
                  </div>
                ) : (
                  <p className="text-[rgba(253,230,138,0.9)]">{t('globe.receptionEnableAdminOnly')}</p>
                )}
                <p className={`text-[10px] leading-snug ${GLOBE_TOOLTIP_FAINT_CLASS}`}>{RECEPTION_CREDIT}</p>
              </div>
            </PopoverContent>
          </Popover>
        )}

      </div>

      {workedGridStatusText && (
        <div className="pointer-events-none absolute bottom-16 left-4 z-30 sm:bottom-[4.5rem] sm:left-5 lg:bottom-[5rem] lg:left-6">
          <div className="rounded-full border border-white/10 bg-[rgba(2,6,23,0.46)] px-3 py-1.5 text-xs text-[rgba(226,232,240,0.7)] backdrop-blur-md">
            {workedGridStatusText}
          </div>
        </div>
      )}

      {hasDesktopOverlay && (
        <div className="pointer-events-none absolute inset-0 z-20 hidden lg:grid lg:grid-cols-[minmax(300px,0.68fr)_minmax(0,1fr)_minmax(280px,0.54fr)] lg:items-stretch">
          <div className={`pointer-events-none flex items-start ${leftOverlayPaddingClassName}`}>
            {desktopLeftOverlay}
          </div>
          <div />
          <div className="pointer-events-auto flex min-h-0 flex-col items-end justify-start px-6 pb-6 pt-8 xl:px-8 xl:pt-10">
            {desktopRightOverlay}
          </div>
        </div>
      )}
    </section>
  );
};

export default RecentQSOGlobeCard;
