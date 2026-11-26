import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger, Select, SelectItem, Spinner, Tooltip } from '@heroui/react';
import type { LogBookWorkedGridItem, OperatorStatus, QSORecord, StationInfo } from '@tx5dr/contracts';
import { api, ApiError, getBandFromFrequency } from '@tx5dr/core';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleHalfStroke, faClockRotateLeft, faEarListen, faEarthAsia, faMap, faTableCells, faTowerBroadcast, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
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
  buildPagedQSOGlobeModel,
  buildInProgressQSOGlobeModel,
  keepDatumObjects,
  type GlobeArc,
  type GlobeStationPoint,
} from '../../utils/logbookGlobe';
import {
  GRID_SQUARE_SWITCH_ALTITUDE,
  buildGridStatusData,
  createMaidenheadGridLayer,
  gridSquareAt,
} from '../../utils/maidenheadGridLayer';
import { createSolarTerminatorLayer, getSubsolarPoint, latLngToGlobeDirection } from '../../utils/solarTerminator';
import { createGlobeHazeLayer } from '../../utils/globeAtmosphere';
import { PixelRatioGovernor, getPixelRatioLevels } from '../../utils/adaptivePixelRatio';
import { GLOBE_LAND_CAP_ALTITUDE, LAND_CAP_DEPTH_BIAS, applyGlobeLayerOrder, getCameraNear, type GlobeShellMesh } from '../../utils/globeShell';
import { intersectGlobe } from '../../utils/globePicking';
import { createGlobeMapProjection, intersectFlatMap } from '../../utils/globeMapProjection';
import { useGlobeMapView } from './useGlobeMapView';
import { createGlobeMarkerLayer, type GlobeMarker } from '../../utils/globeMarkerLayer';
import {
  buildLiveStations,
  getLiveStationOpacity,
  type LiveDecodeView,
  type LiveStation,
} from '../../utils/liveDecodes';
import { buildLiveDecodeCardHtml, buildSimpleGlobeCardHtml } from '../../utils/liveDecodeCard';
import { useDisplayNotificationSettings } from '../../hooks/useDisplayNotificationSettings';
import LiveTargetCard, { type LiveTargeting } from './LiveTargetCard';
import {
  buildReceptionGlobeModel,
  getReceptionHeatScale,
  getReceptionHeatSignature,
  type ReceptionStation,
  type ReceptionHeatPoint,
  type ReceptionView,
} from '../../utils/receptionGlobe';
import { useReceptionPings } from './useReceptionPings';
import { useGlobeTrackpadGestures } from './useGlobeTrackpadGestures';
import { buildReceptionPointCardHtml, getHeardMeAccent } from '../../utils/receptionPointCard';
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
const WORKED_GRID_CACHE_LIMIT = 4;
/** The day/night shading moves 0.25 degrees a minute; a minute is smooth enough. */
const TERMINATOR_TICK_MS = 60_000;
const EMPTY_OPERATORS: OperatorStatus[] = [];
const RECEPTION_TICK_MS = 30_000;
/** A press that moves less than this and ends within CLICK_MAX_MS is a click, not a drag. */
const CLICK_MAX_MOVE_PX = 4;
const CLICK_MAX_MS = 500;
/** The live ageing refresh lands just after each slot boundary. */
const LIVE_TICK_AFTER_BOUNDARY_MS = 50;
/** Neutral glyph colour of stations that are not needed. */
const LIVE_NEUTRAL_COLOR = '#e2e8f0';
/**
 * While stations are heard live, the logbook history is context: its arcs and
 * points step back so the stations worth calling stand out.
 */
const HISTORY_RECEDED_ALPHA = 0.4;

function scaleRgbaAlpha(color: string, factor: number): string {
  const match = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(color);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${(Number(match[4]) * factor).toFixed(3)})`;
}
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
/** Frames to keep re-applying the layer order after mount; land arrives a few frames late. */
const LAND_ORDER_PATCH_FRAMES = 180;
/** Frames to wait for globe.gl to load the night texture (about a minute). */
const EARTH_TEXTURE_WAIT_FRAMES = 3600;

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
/**
 * The pale land tint is added light: blending towards white would flatten the
 * texture and the relief beneath it, adding keeps every difference in them.
 * It steps back while the reception glow is shown, so the glow and the night
 * texture both stay readable.
 */
const LAND_TINT_RGB = [226, 232, 240] as const;
const LAND_TINT_LIFT = 0.15;
const LAND_TINT_DIMMED_LIFT = 0.1;
/** Shaded relief of the terrain (Natural Earth, public domain); 8K where the GPU takes it. */
const RELIEF_TEXTURE_URL = '/globe/relief-4k.jpg';
const RELIEF_TEXTURE_HD_URL = '/globe/relief-8k.jpg';
const RELIEF_TEXTURE_HD_MIN_SIZE = 8192;

function setLandTint(material: { color: { setRGB(r: number, g: number, b: number, colorSpace: string): unknown } }, lift: number): void {
  const [r, g, b] = LAND_TINT_RGB;
  material.color.setRGB((r / 255) * lift, (g / 255) * lift, (b / 255) * lift, THREE.SRGBColorSpace);
}
const getLandStrokeColor = () => 'rgba(241, 245, 249, 0.2)';
const getDimmedLandStrokeColor = () => 'rgba(241, 245, 249, 0.16)';
// Stable accessors: a new function on every render makes globe.gl re-digest
// all land polygons.
const getLandSideColor = () => 'rgba(51, 65, 85, 0.08)';
const RECEPTION_TOOLTIP_STATION_LIMIT = 5;
const RECEPTION_PANEL_CLOSE_DELAY_MS = 200;
const RECEPTION_CREDIT = 'Data from PSK Reporter by Philip Gladstone. Live spots from mqtt.pskreporter.info by Tom Fanning M0LTE.';

type GlobeMarkerData =
  | { kind: 'home'; grid: string }
  | { kind: 'history'; point: GlobeStationPoint }
  | { kind: 'reception'; station: ReceptionStation }
  | { kind: 'live'; station: LiveStation };

/**
 * Glyph size of a worked grid: the model sizes points in globe units by how
 * often the grid was worked (and lifts the latest QSO); markers are pixels.
 */
function getHistoryMarkerSize(modelSize: number): number {
  return Math.round(Math.min(12, 5 + modelSize * 3.4));
}

/** Glyph size of a receiver ring by its report strength. */
function getReceptionMarkerSize(snr: number | undefined): number {
  if (snr === undefined) return 8;
  if (snr >= -10) return 10;
  if (snr >= -18) return 8;
  return 7;
}

/**
 * Visual hierarchy of a live station (see liveDecodes.ts): needed CQ callers
 * stand out with colour, shape and their callsign; the rest steps back.
 */
function getLiveMarkerStyle(station: LiveStation): Pick<GlobeMarker, 'shape' | 'size' | 'color' | 'opacity' | 'hollow' | 'priority'> {
  const age = getLiveStationOpacity(station.ageSlots);
  switch (station.tier) {
    case 1:
      return { shape: 'diamond', size: 13, color: station.color ?? LIVE_NEUTRAL_COLOR, opacity: age, hollow: station.approximate, priority: 8 };
    case 2:
      return { shape: station.isCq ? 'diamond' : 'dot', size: 8, color: station.color ?? LIVE_NEUTRAL_COLOR, opacity: 0.9 * age, hollow: station.approximate, priority: 6 };
    case 3:
      return { shape: 'diamond', size: 9, color: LIVE_NEUTRAL_COLOR, opacity: (station.approximate ? 0.4 : 0.55) * age, hollow: station.approximate, priority: 4 };
    default:
      return { shape: 'dot', size: 4, color: LIVE_NEUTRAL_COLOR, opacity: 0.4 * age, hollow: false, priority: 1 };
  }
}

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

type GlobeShellLayer = { mesh: GlobeShellMesh; altitude: number; setGlobeRadius?: (radius: number) => void };

/** Places a shell layer at its altitude; layers placing their own geometry take the radius. */
function getCustomLayerObject(layer: object, globeRadius: number): GlobeShellMesh {
  const shell = layer as GlobeShellLayer;
  if (shell.setGlobeRadius) {
    shell.setGlobeRadius(globeRadius);
  } else {
    shell.mesh.scale.setScalar(globeRadius * (1 + shell.altitude));
  }
  return shell.mesh;
}

/**
 * Dash settings of an arc. globe.gl passes them to its arc shader as they
 * are, and a solid arc leaves them unset: an undefined uniform reaches the GPU
 * as NaN, and the shader's dash test on NaN is undefined, so some GPUs and
 * drivers would cut a solid arc into pieces or drop it.
 */
const getArcDashLength = (arc: object): number => (arc as GlobeArc).dashLength ?? 1;
const getArcDashGap = (arc: object): number => (arc as GlobeArc).dashGap ?? 0;
const getArcDashAnimateTime = (arc: object): number => (arc as GlobeArc).dashAnimateTime ?? 0;

/** An arc's opacity fades with the QSO's age; globe.gl recolours the same tube. */
const ARC_MUTABLE_FIELDS: readonly (keyof GlobeArc)[] = ['color'];
const NO_MUTABLE_FIELDS: readonly never[] = [];

/** The datums with the objects they had in the previous render kept (see keepDatumObjects). */
function useKeptObjects<T extends object>(items: T[], mutable: readonly (keyof T)[] = NO_MUTABLE_FIELDS): T[] {
  const shownRef = useRef<Map<string, T>>(new Map());
  return useMemo(() => {
    const kept = keepDatumObjects(shownRef.current, items, mutable);
    shownRef.current = kept.byKey;
    return kept.items;
  }, [items, mutable]);
}

/** Shell layers update themselves; the update hook only stops globe.gl from rebuilding them. */
function keepCustomLayerObject(): void {}

/**
 * Keeps depth precision steady across zoom levels (see getCameraNear): the
 * near plane follows the camera's height above the globe.
 */
function syncCameraNear(globe: GlobeMethods | null | undefined, altitude: number): void {
  if (!globe || typeof globe.camera !== 'function' || typeof globe.getGlobeRadius !== 'function') return;
  const camera = globe.camera() as { near: number; updateProjectionMatrix(): void };
  const near = getCameraNear(altitude * globe.getGlobeRadius());
  if (Math.abs(camera.near - near) <= near * 0.05) return;
  camera.near = near;
  camera.updateProjectionMatrix();
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

export interface RecentQSOGlobeCardProps {
  active?: boolean;
  logBookId: string;
  qsos: QSORecord[];
  loading: boolean;
  bandFilter?: string;
  /** Logbook mode filter; the worked grid overlay follows it. */
  modeFilter?: string;
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
  /** Stations heard in the latest receive slots. */
  liveDecodes?: LiveDecodeView | null;
  /** Calling a heard station from a pinned card; absent where the page cannot. */
  liveTargeting?: LiveTargeting | null;
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
  modeFilter,
  onBandFilterChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  desktopLeftOverlay,
  desktopRightOverlay,
  operators: operatorsProp,
  reception = null,
  canEnableReception = false,
  liveDecodes = null,
  liveTargeting = null,
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
  const [showTerminator, setShowTerminator] = useState(true);
  /** Coarse view state for the status text only; the shader follows the camera itself. */
  const [showGridSquares, setShowGridSquares] = useState(DEFAULT_POV_ALTITUDE <= GRID_SQUARE_SWITCH_ALTITUDE);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const activeRef = useRef(active);
  const refreshAnimationRef = useRef<(() => void) | null>(null);
  activeRef.current = active;
  const hasInitialFocusRef = useRef(false);
  const lastFocusKeyRef = useRef<string | null>(null);
  const workedGridCacheRef = useRef<Map<string, LogBookWorkedGridItem[]>>(new Map());
  /** Follows the pointer; its child holds the card and animates in and out. */
  const hoverCardRef = useRef<HTMLDivElement | null>(null);
  const hoverCardBodyRef = useRef<HTMLDivElement | null>(null);
  const markerLabelsRef = useRef<HTMLDivElement | null>(null);
  const [showLive, setShowLive] = useState(true);
  /** A heard station pinned by a click; `autoCall` when it was a double click. */
  const [pinned, setPinned] = useState<{
    key: number;
    station: LiveStation;
    anchor: { x: number; y: number };
    bounds: { width: number; height: number };
    autoCall: boolean;
  } | null>(null);
  const pinnedCallsign = pinned?.station.callsign ?? null;
  const pointerDownRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const hoverSizeRef = useRef({ width: 0, height: 0 });
  const [liveNow, setLiveNow] = useState(() => Date.now());
  // Scrolled into view in a visible tab: clocks and animations run only then.
  const [onScreen, setOnScreen] = useState(true);
  const running = active && onScreen;
  const { settings: highlightSettings } = useDisplayNotificationSettings();
  const viewportHeight = useViewportHeightValue();

  useEffect(() => {
    const globe = globeRef.current;
    const container = containerRef.current;
    if (!globe || !container) return;
    let visible = true;
    const updateAnimation = () => {
      const shown = !document.hidden && visible;
      setOnScreen(shown);
      if (!activeRef.current || !shown) globe.pauseAnimation();
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
  // Unrolls every layer into a flat map and back (see globeMapProjection).
  const mapProjection = useMemo(() => createGlobeMapProjection(), []);
  const { view: globeView, setView: setGlobeView, flatRef, getPanLimits } = useGlobeMapView(globeRef, mapProjection, running);
  // GPU overlays: each is one sphere shell shaded per pixel, so camera moves
  // never rebuild meshes or re-render React.
  const gridLayer = useMemo(() => createMaidenheadGridLayer(mapProjection), [mapProjection]);
  const terminatorLayer = useMemo(() => createSolarTerminatorLayer(undefined, mapProjection), [mapProjection]);
  const hazeLayer = useMemo(() => createGlobeHazeLayer(mapProjection), [mapProjection]);
  const markerLayer = useMemo(() => createGlobeMarkerLayer(mapProjection), [mapProjection]);
  const customLayers = useMemo(
    () => [gridLayer, terminatorLayer, hazeLayer, markerLayer],
    [gridLayer, terminatorLayer, hazeLayer, markerLayer],
  );
  useEffect(() => {
    markerLayer.setLabelContainer(markerLabelsRef.current);
    return () => markerLayer.setLabelContainer(null);
  }, [markerLayer]);

  // Rendering resolution follows the frame rate (see adaptivePixelRatio): it
  // drops while frames are late and returns once they are on time.
  const pixelRatioGovernorRef = useRef<PixelRatioGovernor | null>(null);
  useEffect(() => {
    const globe = globeRef.current;
    if (!running || !globe || typeof globe.renderer !== 'function') return;
    const renderer = globe.renderer() as { setPixelRatio?: (ratio: number) => void };
    if (typeof renderer.setPixelRatio !== 'function') return;
    const naturalRatio = Math.min(2, window.devicePixelRatio || 1);
    pixelRatioGovernorRef.current ??= new PixelRatioGovernor(getPixelRatioLevels(naturalRatio));
    const governor = pixelRatioGovernorRef.current;
    const apply = (ratio: number) => {
      renderer.setPixelRatio?.(ratio);
      gridLayer.setPixelScale(ratio / naturalRatio);
    };
    let last = performance.now();
    let frame = window.requestAnimationFrame(function measure(now: number) {
      const ratio = governor.frame(now - last, now);
      last = now;
      if (ratio !== null) {
        logger.debug('Page globe rendering resolution changed', { pixelRatio: ratio });
        apply(ratio);
      }
      frame = window.requestAnimationFrame(measure);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [running, gridLayer]);

  // The city lights read the globe's own night texture: one copy in memory,
  // uploaded once. globe.gl sets it on the material once it has loaded.
  useEffect(() => {
    let frame = 0;
    let remaining = EARTH_TEXTURE_WAIT_FRAMES;
    const attach = () => {
      const texture = (globeMaterial as { map?: unknown }).map;
      if (texture) {
        terminatorLayer.setEarthTexture(texture);
        return;
      }
      if (--remaining > 0) frame = window.requestAnimationFrame(attach);
    };
    attach();
    return () => window.cancelAnimationFrame(frame);
  }, [globeMaterial, terminatorLayer]);

  // The land tint: one material for every land cap, recoloured in place.
  const landCapMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: LAND_CAP_DEPTH_BIAS.factor,
      polygonOffsetUnits: LAND_CAP_DEPTH_BIAS.units,
    });
    setLandTint(material, LAND_TINT_LIFT);
    return material;
  }, []);
  useEffect(() => () => landCapMaterial.dispose(), [landCapMaterial]);

  // Terrain relief, loaded once as a single channel (a quarter of the memory
  // of colour). The ground shading reads it, so it shows in 3D and on the map.
  useEffect(() => {
    const renderer = globeRef.current && typeof globeRef.current.renderer === 'function'
      ? globeRef.current.renderer() as { capabilities?: { maxTextureSize?: number } }
      : null;
    if (!renderer) return;
    const url = (renderer.capabilities?.maxTextureSize ?? 0) >= RELIEF_TEXTURE_HD_MIN_SIZE
      ? RELIEF_TEXTURE_HD_URL
      : RELIEF_TEXTURE_URL;
    let disposed = false;
    let loaded: { dispose(): void } | null = null;
    new THREE.TextureLoader().load(url, (texture: {
      format: number;
      colorSpace: string;
      anisotropy: number;
      needsUpdate: boolean;
      dispose(): void;
    }) => {
      if (disposed) {
        texture.dispose();
        return;
      }
      texture.format = THREE.RedFormat;
      texture.colorSpace = THREE.NoColorSpace;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      loaded = texture;
      terminatorLayer.setReliefTexture(texture);
    }, undefined, () => logger.warn('Page globe relief texture failed to load', { url }));
    return () => {
      disposed = true;
      terminatorLayer.setReliefTexture(null);
      loaded?.dispose();
    };
  }, [terminatorLayer]);

  useEffect(() => () => {
    globeMaterial.dispose();
    gridLayer.dispose();
    terminatorLayer.dispose();
    hazeLayer.dispose();
    markerLayer.dispose();
  }, [globeMaterial, gridLayer, terminatorLayer, hazeLayer, markerLayer]);

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
    () => buildInProgressQSOGlobeModel(operators, stationInfo, globeModel.homePoint),
    [operators, stationInfo, globeModel.homePoint],
  );
  // Logbook reloads and operator updates rebuild the models; the arcs of the
  // same QSOs keep their objects, so globe.gl keeps their tubes (see keepDatumObjects).
  const historyArcs = useKeptObjects(globeModel.arcs, ARC_MUTABLE_FIELDS);
  const inProgressArcs = useKeptObjects(inProgressModel.arcs, ARC_MUTABLE_FIELDS);
  const workedGridStatus = useMemo(() => buildGridStatusData(workedGridItems), [workedGridItems]);
  useEffect(() => {
    gridLayer.setStatus(workedGridStatus);
  }, [gridLayer, workedGridStatus]);
  useEffect(() => {
    gridLayer.mesh.visible = showWorkedGrids;
    if (!showWorkedGrids && hoverCardBodyRef.current) hoverCardBodyRef.current.dataset.open = 'false';
  }, [gridLayer, showWorkedGrids]);
  useEffect(() => {
    terminatorLayer.setDaylightVisible(showTerminator);
    // The haze follows day and night only while they are shown.
    if (!showTerminator) hazeLayer.setSunDirection(null);
    if (!showTerminator || !running) return;
    const tick = () => {
      const now = new Date();
      terminatorLayer.setTime(now);
      const sun = getSubsolarPoint(now);
      hazeLayer.setSunDirection(latLngToGlobeDirection(sun.lat, sun.lng));
    };
    tick();
    const timer = window.setInterval(tick, TERMINATOR_TICK_MS);
    return () => window.clearInterval(timer);
  }, [terminatorLayer, hazeLayer, showTerminator, running]);
  const [showReception, setShowReception] = useState(true);
  const [receptionNow, setReceptionNow] = useState(() => Date.now());
  const hasReceptionSpots = (reception?.spots.length ?? 0) > 0;
  useEffect(() => {
    if (!hasReceptionSpots || !running) return;
    setReceptionNow(Date.now());
    const timer = setInterval(() => setReceptionNow(Date.now()), RECEPTION_TICK_MS);
    return () => clearInterval(timer);
  }, [hasReceptionSpots, running, reception]);
  // Operator updates arrive several times a second; the set is rebuilt (and
  // everything depending on it) only when the called stations change.
  const receptionTargetKey = useMemo(() => Array.from(new Set(
    operators
      .filter(op => op.currentSlot !== 'TX6')
      .flatMap(op => [op.context?.targetCall, ...(op.context?.targetCalls ?? [])])
      .flatMap(call => (call ? [call.trim().toUpperCase()] : [])),
  )).sort().join(' '), [operators]);
  const receptionTargetCalls = useMemo(
    () => new Set(receptionTargetKey ? receptionTargetKey.split(' ') : []),
    [receptionTargetKey],
  );
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
  const receptionModel = useMemo(
    () => buildReceptionGlobeModel(bandReception, receptionHome, receptionNow, receptionTargetCalls, receptionTheme),
    [bandReception, receptionHome, receptionNow, receptionTargetCalls, receptionTheme],
  );
  const receptionPings = useReceptionPings(
    receptionModel.stations,
    // A band switch is a new view: its stations appear settled, without rings.
    `${reception?.callsigns.join(',') ?? ''}|${bandFilter ?? ''}`,
    reception !== null,
    showReception && running,
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
    logger.debug('Page globe model prepared', {
      qsoCount: globeModel.summary.qsoCount,
      hasHome: !!globeModel.homePoint,
      remotePointCount: globeModel.remotePoints.length,
      arcCount: globeModel.arcs.length,
      droppedInvalidGrid: globeModel.summary.droppedInvalidGrid,
    });
  }, [globeModel]);

  useEffect(() => {
    const activeOperators = operators.filter((op) => op.currentSlot !== 'TX6');
    logger.debug('Page globe in-progress model prepared', {
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

    const cacheKey = `${logBookId}:${bandFilter || 'all'}:${modeFilter || 'all'}`;
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
          mode: modeFilter || null,
        });

        const response = await api.getLogBookWorkedGrids(logBookId, {
          ...(bandFilter ? { band: bandFilter } : {}),
          ...(modeFilter ? { mode: modeFilter } : {}),
        });
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
          mode: modeFilter || null,
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
  }, [bandFilter, modeFilter, logBookId, showWorkedGrids, t]);

  useEffect(() => {
    if (!globeRef.current || !globeModel.homePoint || loading) {
      return;
    }

    const controls = globeRef.current.controls() as unknown as GlobeControls;
    // The flat map stays where the user put it.
    controls.autoRotate = !flatRef.current;
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
    setShowGridSquares(DEFAULT_POV_ALTITUDE <= GRID_SQUARE_SWITCH_ALTITUDE);

    hasInitialFocusRef.current = true;
    lastFocusKeyRef.current = focusKey;
  }, [globeModel.homePoint, loading, flatRef]);

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
  // A reload keeps showing the records it replaces (the page keeps them until
  // the new ones arrive): change notices reload the logbook after every QSO
  // update, in bursts while a sync runs, and hiding the history each time
  // would flash every arc and marker off and on.
  const shouldShowStatusOverlay = !hasRenderableData;
  const statusMessage = loading
    ? t('globe.loadingCurrentPage')
    : !globeModel.homePoint
      ? t('globe.missingHomeCurrentPage')
      : t('globe.emptyCurrentPage');
  const liveHasSlots = (liveDecodes?.slots.length ?? 0) > 0;
  const liveSlotMs = liveDecodes?.slotMs;
  // Stations age by whole slots, so the clock only needs to move at slot
  // boundaries (and when new decodes arrive).
  useEffect(() => {
    if (!showLive || !running || !liveHasSlots || !liveSlotMs) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const wait = liveSlotMs - (Date.now() % liveSlotMs) + LIVE_TICK_AFTER_BOUNDARY_MS;
      timer = setTimeout(() => {
        setLiveNow(Date.now());
        schedule();
      }, wait);
    };
    setLiveNow(Date.now());
    schedule();
    return () => clearTimeout(timer);
  }, [showLive, running, liveHasSlots, liveSlotMs, liveDecodes]);
  const liveStations = useMemo(
    () => (showLive ? buildLiveStations(liveDecodes, liveNow, highlightSettings, receptionTargetCalls) : []),
    [showLive, liveDecodes, liveNow, highlightSettings, receptionTargetCalls],
  );
  // Needed CQ callers pop in once when they first appear, and every fresh
  // decode (a new station, or a newer slot of a known one) flashes briefly.
  // A reload or the first snapshot shows everything settled.
  const livePopRef = useRef<{
    primed: boolean;
    poppedAt: Map<string, number>;
    seen: Map<string, { slotStartMs: number; flashAt?: number }>;
  }>({ primed: false, poppedAt: new Map(), seen: new Map() });
  const globeMarkers = useMemo<GlobeMarker<GlobeMarkerData>[]>(() => {
    const markers: GlobeMarker<GlobeMarkerData>[] = [];
    const home = globeModel.homePoint;
    if (home) {
      markers.push({
        id: 'home', lat: home.lat, lng: home.lng, shape: 'home', size: 16, color: home.color,
        opacity: 1, priority: 10, data: { kind: 'home', grid: home.grid },
      });
    }
    if (hasRenderableData && showQsoHistory) {
      const historyOpacity = liveStations.length > 0 ? 0.5 : 0.85;
      for (const point of globeModel.remotePoints) {
        markers.push({
          id: `history:${point.grid}`, lat: point.lat, lng: point.lng, shape: 'dot', size: getHistoryMarkerSize(point.size), color: point.color,
          opacity: historyOpacity, priority: 2, data: { kind: 'history', point },
        });
      }
    }
    if (showReception) {
      for (const point of receptionModel.points) {
        markers.push({
          id: `reception:${point.station.callsign}`, lat: point.lat, lng: point.lng, shape: 'ring',
          size: getReceptionMarkerSize(point.station.snr), color: getHeardMeAccent(receptionTheme),
          opacity: 0.3 + point.station.freshness * 0.65, priority: 3, data: { kind: 'reception', station: point.station },
        });
      }
    }
    const pops = livePopRef.current;
    const tierOne = new Set<string>();
    const heard = new Set<string>();
    for (const station of liveStations) {
      heard.add(station.callsign);
      const seen = pops.seen.get(station.callsign);
      let flashAt = seen?.flashAt;
      if (pops.primed && (!seen || station.slotStartMs > seen.slotStartMs)) {
        flashAt = performance.now();
      }
      pops.seen.set(station.callsign, { slotStartMs: station.slotStartMs, flashAt });
      let popAt: number | undefined;
      if (station.tier === 1) {
        tierOne.add(station.callsign);
        popAt = pops.poppedAt.get(station.callsign);
        if (popAt === undefined && pops.primed) {
          popAt = performance.now();
          pops.poppedAt.set(station.callsign, popAt);
        }
      }
      markers.push({
        id: `live:${station.callsign}`, lat: station.lat, lng: station.lng, ...getLiveMarkerStyle(station),
        popAt, flashAt, label: station.tier === 1 ? station.callsign : undefined, data: { kind: 'live', station },
      });
    }
    for (const callsign of pops.seen.keys()) {
      if (!heard.has(callsign)) pops.seen.delete(callsign);
    }
    for (const callsign of pops.poppedAt.keys()) {
      if (!tierOne.has(callsign)) pops.poppedAt.delete(callsign);
    }
    if (liveStations.length > 0) pops.primed = true;
    return markers;
  }, [globeModel.homePoint, globeModel.remotePoints, hasRenderableData, showQsoHistory, showReception, receptionModel.points, receptionTheme, liveStations]);
  useEffect(() => {
    markerLayer.setMarkers(globeMarkers);
  }, [markerLayer, globeMarkers]);
  const liveCounts = useMemo(() => ({
    total: liveStations.length,
    actionable: liveStations.filter(station => station.tier === 1).length,
  }), [liveStations]);
  // History arcs recede by colour alone. globe.gl keys arcs by object, so the
  // same objects stay bound to their tube meshes and only the vertex colours
  // update; swapping in copies (or changing the stroke) rebuilds every tube
  // on every frame of a one-second transition.
  const historyRecedes = liveCounts.total > 0;
  const recededArcColors = useMemo(
    () => new Map(historyArcs.map(arc => [arc, scaleRgbaAlpha(arc.color, HISTORY_RECEDED_ALPHA)])),
    [historyArcs],
  );
  const getArcColor = useCallback(
    (arc: object) => (historyRecedes && recededArcColors.get(arc as GlobeArc)) || (arc as GlobeArc).color,
    [historyRecedes, recededArcColors],
  );
  const visibleArcs = useMemo(() => !hasRenderableData || !showQsoHistory
    ? inProgressArcs
    : [...historyArcs, ...inProgressArcs], [hasRenderableData, showQsoHistory, historyArcs, inProgressArcs]);
  /** Latest QSO with each worked grid, for its hover card. */
  const latestArcByGrid = useMemo(() => {
    const latest = new Map<string, GlobeArc>();
    for (const arc of globeModel.arcs) {
      const known = latest.get(arc.grid);
      if (!known || arc.startTime > known.startTime) latest.set(arc.grid, arc);
    }
    return latest;
  }, [globeModel.arcs]);
  // globe.gl binds one mesh per datum object. Reusing the same datum keeps the
  // mesh (and its patched material) across updates; only the KDE is recomputed.
  const receptionFogDatum = useMemo(() => ({ points: [] as ReceptionHeatPoint[] }), []);
  // The glow only changes when the quantised points do, and at most every few
  // seconds; the density pass is expensive without WebGPU.
  const heatSignature = getReceptionHeatSignature(receptionModel.heatPoints);
  const latestHeatPointsRef = useRef(receptionModel.heatPoints);
  latestHeatPointsRef.current = receptionModel.heatPoints;
  const [fogHeatPoints, setFogHeatPoints] = useState<ReceptionHeatPoint[]>(EMPTY_HEAT_POINTS);
  // The glow layer normalises to its strongest area; scale it back by how good
  // that area's reception actually is, so weak coverage reads as weak.
  const receptionHeatScale = useMemo(() => getReceptionHeatScale(fogHeatPoints), [fogHeatPoints]);
  const receptionFogColorFn = useMemo(
    () => () => (density: number) => receptionTheme.fogColor(density * receptionHeatScale),
    [receptionTheme, receptionHeatScale],
  );
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
    setLandTint(landCapMaterial, receptionFogVisible ? LAND_TINT_DIMMED_LIFT : LAND_TINT_LIFT);
  }, [landCapMaterial, receptionFogVisible]);
  useEffect(() => {
    if (receptionHeatmaps.length === 0) return;
    let frame = 0;
    let remaining = RECEPTION_FOG_PATCH_FRAMES;
    // The layer applies data on later frames and may (re)create the mesh at any
    // of them, so every heatmap mesh is patched for a fixed number of frames
    // instead of stopping at the first one found.
    const patch = () => {
      applyHeatmapGlowMaterial(globeRef.current);
      const globe = globeRef.current;
      if (globe && typeof globe.scene === 'function') applyGlobeLayerOrder(globe.scene());
      if (--remaining > 0) {
        frame = window.requestAnimationFrame(patch);
      }
    };
    patch();
    return () => window.cancelAnimationFrame(frame);
  }, [receptionHeatmaps]);
  // globe.gl builds the land caps a few frames after mount and offers no
  // render order option; order them before the night shade once they exist.
  // Should they ever be rebuilt unordered, land merely shows undimmed at night.
  useEffect(() => {
    let frame = 0;
    let remaining = LAND_ORDER_PATCH_FRAMES;
    let settleFrames = 30;
    const patch = () => {
      const globe = globeRef.current;
      const found = !!globe && typeof globe.scene === 'function' && applyGlobeLayerOrder(globe.scene());
      if (found) settleFrames -= 1;
      if (--remaining > 0 && settleFrames > 0) {
        frame = window.requestAnimationFrame(patch);
      }
    };
    patch();
    return () => window.cancelAnimationFrame(frame);
  }, [landPolygons]);
  const visibleReceptionRings = showReception ? receptionModel.targetRings : null;
  const visibleRings = useMemo(() => {
    const historyRings = showQsoHistory
      ? globeModel.rings
      : globeModel.homeRing ? [globeModel.homeRing] : [];
    const rings = !hasRenderableData
      ? inProgressModel.rings
      : [...historyRings, ...inProgressModel.rings];
    // Reception rings come first so the in-progress rings draw above them.
    return visibleReceptionRings && (visibleReceptionRings.length > 0 || receptionPings.length > 0)
      ? [...visibleReceptionRings, ...receptionPings, ...rings]
      : rings;
  }, [hasRenderableData, showQsoHistory, globeModel.rings, globeModel.homeRing, inProgressModel.rings, visibleReceptionRings, receptionPings]);
  // The models rebuild their rings on every reload, operator update and
  // reception refresh; a new ring object starts an extra pulse at once.
  const shownRings = useKeptObjects(visibleRings);
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
  const workedGridConfirmedCount = useMemo(
    () => workedGridItems.filter(item => (item.confirmedCount ?? 0) > 0).length,
    [workedGridItems],
  );
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
            confirmed: workedGridConfirmedCount,
            precision: showGridSquares ? 4 : 2,
          });

  // Camera moves call these every frame: React hears only actual changes.
  const showGridSquaresRef = useRef(showGridSquares);
  showGridSquaresRef.current = showGridSquares;
  const syncViewportState = (pov: GlobePointOfView) => {
    if (pov.altitude === undefined) return;
    syncCameraNear(globeRef.current, pov.altitude);
    const squares = pov.altitude <= GRID_SQUARE_SWITCH_ALTITUDE;
    if (showGridSquaresRef.current === squares) return;
    showGridSquaresRef.current = squares;
    setShowGridSquares(squares);
  };

  // Moving the view leaves a pinned card behind its station, so the user's own
  // drags, wheel and trackpad gestures close it. Auto-rotation does not: it
  // also moves the camera, and stops when a card is pinned.
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const closePinnedOnUserMove = () => {
    if (!pinnedRef.current) return;
    pinnedRef.current = null;
    setPinned(null);
  };

  // Trackpad drag pans and pinch zooms like a native map; they bypass
  // OrbitControls, so the view state is synced here instead of in onZoom.
  useGlobeTrackpadGestures(containerRef, globeRef, (view) => {
    closePinnedOnUserMove();
    syncViewportState(view);
  }, getPanLimits);

  const describeMarker = (marker: GlobeMarker): string => {
    const data = marker.data as GlobeMarkerData;
    switch (data.kind) {
      case 'home':
        return buildSimpleGlobeCardHtml([t('globe.homeLabel'), data.grid]);
      case 'history': {
        const latest = latestArcByGrid.get(data.point.grid);
        return buildSimpleGlobeCardHtml([
          data.point.grid,
          t('globe.pointCount', { count: data.point.count }),
          ...(data.point.callsigns.length > 0 ? [data.point.callsigns.join(', ')] : []),
          ...(latest
            ? [`${latest.mode} · ${(latest.frequency / 1_000_000).toFixed(3)} MHz · ${formatUtcTime(latest.startTime)} UTC`]
            : []),
        ]);
      }
      case 'reception':
        return buildReceptionPointCardHtml(data.station, receptionTheme, Date.now(), t);
      case 'live':
        return buildLiveDecodeCardHtml(data.station, globeModel.homePoint, t);
    }
  };
  const describeGrid = (clientX: number, clientY: number, globe: GlobeMethods, canvasRect: DOMRect): string | null => {
    const camera = globe.camera();
    const pointer = new THREE.Vector3(
      ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1,
      -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1,
      0.5,
    ).unproject(camera);
    // Mid-way between globe and map nothing is picked.
    const morph = mapProjection.morph;
    if (morph > 0 && morph < 1) return null;
    const coords = morph >= 1
      ? intersectFlatMap(camera.position, pointer.sub(camera.position), globe.getGlobeRadius())
      : intersectGlobe(camera.position, pointer.sub(camera.position), globe.getGlobeRadius());
    const grid = coords ? gridSquareAt(coords.lat, coords.lng) : null;
    if (!grid) return null;
    const status = workedGridStatus.byGrid.get(grid);
    if (!showGridSquares) return buildSimpleGlobeCardHtml([grid.slice(0, 2)]);
    return buildSimpleGlobeCardHtml(status
      ? [grid, t('globe.pointCount', { count: status.count }), ...(status.confirmedCount > 0 ? [t('globe.gridConfirmedCount', { count: status.confirmedCount })] : [])]
      : [grid]);
  };

  // Hover: markers are picked in screen space and grids by one ray-sphere
  // lookup, once per animation frame, written straight to the DOM so pointer
  // moves never re-render the card.
  const hoverFrameRef = useRef(0);
  useEffect(() => () => window.cancelAnimationFrame(hoverFrameRef.current), []);
  const handleGlobeHoverEnd = () => {
    window.cancelAnimationFrame(hoverFrameRef.current);
    if (hoverCardBodyRef.current) hoverCardBodyRef.current.dataset.open = 'false';
  };
  const handleGlobeHover = (event: React.PointerEvent<HTMLElement>) => {
    const down = pointerDownRef.current;
    if (down && !(Math.hypot(event.clientX - down.x, event.clientY - down.y) <= CLICK_MAX_MOVE_PX)) {
      closePinnedOnUserMove();
    }
    // Mouse only, and only over the globe itself, not the controls above it.
    if (event.pointerType !== 'mouse' || !(event.target instanceof HTMLCanvasElement)) {
      handleGlobeHoverEnd();
      return;
    }
    const { clientX, clientY } = event;
    window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      const hover = hoverCardRef.current;
      const body = hoverCardBodyRef.current;
      const globe = globeRef.current;
      if (!container || !hover || !body || !globe || typeof globe.camera !== 'function') return;
      const canvasRect = globe.renderer().domElement.getBoundingClientRect();
      if (canvasRect.width <= 0 || canvasRect.height <= 0) return;
      const picked = markerLayer.pick(clientX - canvasRect.left, clientY - canvasRect.top);
      // The pinned card already shows its station.
      const marker = picked && (picked.data as GlobeMarkerData).kind === 'live'
        && (picked.data as { station: LiveStation }).station.callsign === pinnedCallsign
        ? null
        : picked;
      const html = marker
        ? describeMarker(marker)
        : showWorkedGrids ? describeGrid(clientX, clientY, globe, canvasRect) : null;
      if (!html) {
        body.dataset.open = 'false';
        return;
      }
      // The card is measured only when its content changes: reading its size
      // on every move would force a layout each time.
      if (body.innerHTML !== html) {
        body.innerHTML = html;
        hoverSizeRef.current = { width: hover.offsetWidth, height: hover.offsetHeight };
      }
      const { width, height } = hoverSizeRef.current;
      const rect = container.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const flipX = x + 16 + width > rect.width;
      const flipY = y + 16 + height > rect.height;
      const left = flipX ? x - 16 - width : x + 16;
      const top = flipY ? y - 16 - height : y + 16;
      hover.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${Math.round(Math.max(0, top))}px)`;
      // Grows out of the corner nearest the pointer.
      body.style.setProperty('--globe-pop-origin', `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`);
      body.style.setProperty('--globe-pop-shift', flipY ? '4px' : '-4px');
      body.dataset.open = 'true';
    });
  };

  /** The live station under a client point, with the point relative to the container. */
  const pickLiveStation = (clientX: number, clientY: number) => {
    const container = containerRef.current;
    const globe = globeRef.current;
    if (!container || !globe || typeof globe.renderer !== 'function') return null;
    const canvasRect = globe.renderer().domElement.getBoundingClientRect();
    const marker = markerLayer.pick(clientX - canvasRect.left, clientY - canvasRect.top);
    const data = marker?.data as GlobeMarkerData | undefined;
    const rect = container.getBoundingClientRect();
    return {
      station: data?.kind === 'live' ? data.station : null,
      anchor: { x: clientX - rect.left, y: clientY - rect.top },
      bounds: { width: rect.width, height: rect.height },
    };
  };
  const pinStation = (clientX: number, clientY: number, autoCall: boolean) => {
    const hit = pickLiveStation(clientX, clientY);
    if (!hit?.station) {
      setPinned(null);
      return;
    }
    const controls = globeRef.current?.controls() as GlobeControls | undefined;
    if (controls) controls.autoRotate = false;
    handleGlobeHoverEnd();
    const station = hit.station;
    setPinned({ key: Date.now() + Math.random(), station, anchor: hit.anchor, bounds: hit.bounds, autoCall });
  };
  // A click pins the card; dragging the globe is not a click.
  const handleGlobePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    pointerDownRef.current = event.target instanceof HTMLCanvasElement
      ? { x: event.clientX, y: event.clientY, at: performance.now() }
      : null;
  };
  const handleGlobePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const down = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!down || !(event.target instanceof HTMLCanvasElement)) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    // Written to fail closed: an unreadable position is not a click.
    if (!(moved <= CLICK_MAX_MOVE_PX) || performance.now() - down.at > CLICK_MAX_MS) return;
    pinStation(event.clientX, event.clientY, false);
  };
  // A double click calls at once, as in the decode table.
  const handleGlobeDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLCanvasElement)) return;
    pinStation(event.clientX, event.clientY, true);
  };
  useEffect(() => {
    if (!pinned) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPinned(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pinned]);
  useEffect(() => {
    if (!showLive || !active) setPinned(null);
  }, [showLive, active]);

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
      onPointerMove={handleGlobeHover}
      onPointerLeave={handleGlobeHoverEnd}
      onPointerDown={handleGlobePointerDown}
      onPointerUp={handleGlobePointerUp}
      onDoubleClick={handleGlobeDoubleClick}
      onWheel={(event) => {
        if (event.target instanceof HTMLCanvasElement) closePinnedOnUserMove();
      }}
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
        // globe.gl's own hover tracking raycasts the whole scene (land, arcs,
        // rings) every 50 ms even while the pointer rests; markers and grid
        // squares are picked in screen space instead (see handleGlobeHover).
        enablePointerInteraction={false}
        animateIn
        globeMaterial={globeMaterial}
        showGraticules={false}
        showAtmosphere
        atmosphereColor="#7dd3fc"
        atmosphereAltitude={0.17}
        polygonsData={landPolygons as object[]}
        polygonGeoJsonGeometry={getLandGeometry}
        polygonAltitude={GLOBE_LAND_CAP_ALTITUDE}
        polygonCapMaterial={landCapMaterial}
        polygonSideColor={getLandSideColor}
        polygonStrokeColor={receptionFogVisible ? getDimmedLandStrokeColor : getLandStrokeColor}
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
        customLayerData={customLayers}
        customThreeObject={getCustomLayerObject}
        customThreeObjectUpdate={keepCustomLayerObject}
        arcsData={visibleArcs}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcColor={getArcColor}
        arcAltitude="altitude"
        arcStroke="stroke"
        arcCurveResolution={48}
        arcCircularResolution={6}
        arcDashLength={getArcDashLength}
        arcDashGap={getArcDashGap}
        arcDashAnimateTime={getArcDashAnimateTime}
        // An arc's shape is fixed by its own altitude, so globe.gl's transition
        // would only rebuild each new tube on every frame for a second.
        arcsTransitionDuration={0}
        ringsData={shownRings}
        ringLat="lat"
        ringLng="lng"
        ringColor="color"
        ringAltitude={0.01}
        ringMaxRadius="maxRadius"
        ringPropagationSpeed="propagationSpeed"
        ringRepeatPeriod="repeatPeriod"
        onGlobeReady={() => {
          logger.info('Page globe renderer ready', {
            width: effectiveGlobeWidth,
            height: globeHeight,
          });
          if (!globeRef.current) {
            return;
          }

          const controls = globeRef.current.controls() as unknown as GlobeControls;
          controls.autoRotate = !flatRef.current;
          controls.autoRotateSpeed = 0.35;
          controls.update?.();

          syncViewportState(globeRef.current.pointOfView());
        }}
        onZoom={(pov) => {
          const controls = globeRef.current?.controls() as GlobeControls | undefined;
          if (controls) {
            controls.autoRotate = false;
          }
          syncViewportState(pov);
        }}
      />

      {/* Callsigns of the actionable stations, positioned by the marker layer each frame. */}
      <div ref={markerLabelsRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-10" />

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

      <div className="absolute bottom-4 left-4 z-30 flex max-w-[calc(100%-8.5rem)] flex-wrap items-center gap-2 sm:bottom-5 sm:left-5 lg:bottom-6 lg:left-6">
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

        <GlobeIconToggle
          active={showLive}
          icon={faEarListen}
          label={showLive ? t('globe.hideLive') : t('globe.showLive')}
          onPress={() => setShowLive(value => !value)}
        />

        <GlobeIconToggle
          active={showTerminator}
          icon={faCircleHalfStroke}
          label={showTerminator ? t('globe.hideTerminator') : t('globe.showTerminator')}
          onPress={() => setShowTerminator(value => !value)}
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

            {/* Stays mounted so it can animate out; the bottom padding bridges the
                gap to the chip so the pointer can move into the panel. */}
            <div
              className="globe-pop absolute bottom-full left-0 z-40 pb-2"
              data-open={receptionPanelOpen}
              aria-hidden={!receptionPanelOpen}
            >
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

      {pinned && (
        <LiveTargetCard
          key={pinned.key}
          station={pinned.station}
          home={globeModel.homePoint}
          anchor={pinned.anchor}
          bounds={pinned.bounds}
          targeting={liveTargeting}
          autoCall={pinned.autoCall}
          onClose={() => setPinned(null)}
        />
      )}

      <div ref={hoverCardRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-30">
        <div ref={hoverCardBodyRef} className="globe-pop" data-open="false" />
      </div>

      {(workedGridStatusText || (showLive && liveCounts.total > 0)) && (
        <div className="pointer-events-none absolute bottom-16 left-4 z-30 flex flex-col items-start gap-1.5 sm:bottom-[4.5rem] sm:left-5 lg:bottom-[5rem] lg:left-6">
          {showLive && liveCounts.total > 0 && (
            <div className="flex items-center gap-3 rounded-full border border-white/10 bg-[rgba(2,6,23,0.46)] px-3 py-1.5 text-xs text-[rgba(226,232,240,0.7)] backdrop-blur-md">
              <span>{t('globe.liveSummary', { count: liveCounts.total, actionable: liveCounts.actionable })}</span>
              <span className="flex items-center gap-2.5">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rotate-45 rounded-[1px] bg-[rgba(226,232,240,0.85)]" aria-hidden="true" />
                  {t('globe.liveLegendCq')}
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-[rgba(226,232,240,0.85)]" aria-hidden="true" />
                  {t('globe.liveLegendBusy')}
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rotate-45 rounded-[1px] border border-[rgba(226,232,240,0.85)]" aria-hidden="true" />
                  {t('globe.liveLegendApproximate')}
                </span>
              </span>
            </div>
          )}
          {workedGridStatusText && (
            <div className="flex items-center gap-3 rounded-full border border-white/10 bg-[rgba(2,6,23,0.46)] px-3 py-1.5 text-xs text-[rgba(226,232,240,0.7)] backdrop-blur-md">
              <span>{workedGridStatusText}</span>
              {workedGridItems.length > 0 && !workedGridLoading && !workedGridError && (
                <span className="flex items-center gap-2.5">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-[rgb(239,68,68)]" aria-hidden="true" />
                    {t('globe.legendWorked')}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-[rgb(52,211,153)]" aria-hidden="true" />
                    {t('globe.legendConfirmed')}
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* How the whole map is drawn, apart from the layer toggles. */}
      <div
        role="radiogroup"
        aria-label={t('globe.viewMode')}
        className="absolute bottom-4 right-4 z-30 flex h-10 items-center gap-0.5 rounded-full border border-white/10 bg-[rgba(15,23,42,0.52)] p-1 shadow-[0_10px_30px_rgba(2,6,23,0.28)] backdrop-blur-md sm:bottom-5 sm:right-5 lg:bottom-6 lg:right-6"
      >
        {([
          { view: 'globe', icon: faEarthAsia, short: '3D', label: t('globe.viewGlobe') },
          { view: 'flat', icon: faMap, short: '2D', label: t('globe.viewFlat') },
        ] as const).map((option) => {
          const selected = globeView === option.view;
          return (
            <Tooltip key={option.view} content={option.label} placement="top" delay={150} closeDelay={0} classNames={GLOBE_TOOLTIP_CLASSNAMES}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={option.label}
                onClick={() => setGlobeView(option.view)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium tracking-wide transition-all duration-300 ${selected
                  ? 'bg-[rgba(30,58,95,0.75)] text-[rgba(224,242,254,0.95)] shadow-[inset_0_0_0_1px_rgba(125,211,252,0.3)]'
                  : 'text-[rgba(226,232,240,0.5)] hover:text-[rgba(226,232,240,0.85)]'}`}
              >
                <FontAwesomeIcon icon={option.icon} className="h-3 w-3" />
                <span>{option.short}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>

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
