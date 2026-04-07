import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, SelectItem, Spinner } from '@heroui/react';
import type { QSORecord, StationInfo } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import * as THREE from 'three';
import { feature } from 'topojson-client';
import type { Feature, Geometry } from 'geojson';
import landTopology from 'world-atlas/land-110m.json';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { isElectron, isMacOS } from '../../utils/config';
import { useViewportHeightValue } from '../../hooks/useViewportHeight';
import {
  buildPagedQSOGlobeModel,
  type GlobeArc,
  type GlobeStationPoint,
} from '../../utils/logbookGlobe';

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

interface RecentQSOGlobeCardProps {
  qsos: QSORecord[];
  loading: boolean;
  pageSize: number;
  pageSizeOptions: number[];
  onPageSizeChange: (pageSize: number) => void;
  desktopLeftOverlay?: React.ReactNode;
  desktopRightOverlay?: React.ReactNode;
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
  qsos,
  loading,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  desktopLeftOverlay,
  desktopRightOverlay,
}) => {
  const { t } = useTranslation('logbook');
  const [stationInfo, setStationInfo] = useState<StationInfo | null>(null);
  const [globeWidth, setGlobeWidth] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const hasInitialFocusRef = useRef(false);
  const lastFocusKeyRef = useRef<string | null>(null);
  const viewportHeight = useViewportHeightValue();
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

  const landPolygons = useMemo(() => {
    const land = feature(landTopology as LandTopology, (landTopology as LandTopology).objects.land);
    return land.type === 'FeatureCollection'
      ? land.features as Feature<Geometry>[]
      : [land as Feature<Geometry>];
  }, []);

  const globeModel = useMemo(() => buildPagedQSOGlobeModel(qsos, stationInfo), [qsos, stationInfo]);
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
  const visiblePoints: GlobeStationPoint[] = loading || !hasRenderableData
    ? []
    : globeModel.homePoint
      ? [globeModel.homePoint, ...globeModel.remotePoints]
      : globeModel.remotePoints;
  const visibleArcs = loading || !hasRenderableData ? [] : globeModel.arcs;
  const visibleRings = loading || !hasRenderableData ? [] : globeModel.rings;
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
        showGraticules
        showAtmosphere
        atmosphereColor="#7dd3fc"
        atmosphereAltitude={0.17}
        polygonsData={landPolygons}
        polygonAltitude={0.0025}
        polygonCapColor={() => 'rgba(226, 232, 240, 0.2)'}
        polygonSideColor={() => 'rgba(51, 65, 85, 0.08)'}
        polygonStrokeColor={() => 'rgba(241, 245, 249, 0.2)'}
        pointsData={visiblePoints}
        pointLat="lat"
        pointLng="lng"
        pointAltitude={(point) => ((point as GlobeStationPoint).isHome ? 0.06 : 0.012)}
        pointRadius="size"
        pointResolution={18}
        pointColor="color"
        pointLabel={(point) => {
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
        arcCurveResolution={96}
        arcCircularResolution={8}
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
        }}
        onZoom={() => {
          const controls = globeRef.current?.controls() as GlobeControls | undefined;
          if (controls) {
            controls.autoRotate = false;
          }
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
            listboxProps={{
              itemClasses: {
                base: 'text-[rgba(248,250,252,0.94)] [&_svg]:text-[rgba(248,250,252,0.94)] data-[hover=true]:bg-white/10 data-[selectable=true]:focus:bg-white/10',
                title: 'text-[rgba(248,250,252,0.94)] group-data-[selected=true]:text-white',
              },
            }}
            classNames={{
              base: 'min-w-0',
              trigger: 'h-10 min-h-10 border-0 bg-transparent pl-0 pr-0 shadow-none data-[hover=true]:bg-transparent data-[open=true]:bg-transparent',
              innerWrapper: 'shadow-none',
              mainWrapper: 'shadow-none',
              value: 'pl-0 pr-0 text-sm text-[rgba(248,250,252,0.94)]',
              popoverContent: 'border border-white/10 bg-[rgba(15,23,42,0.92)] text-[rgba(248,250,252,0.94)] backdrop-blur-xl',
              selectorIcon: 'text-[rgba(226,232,240,0.72)]',
              listboxWrapper: 'max-h-60',
            }}
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
                className="text-[rgba(248,250,252,0.94)] [&_svg]:text-[rgba(248,250,252,0.94)]"
              >
                {t('globe.displayCountOption', { count: option })}
              </SelectItem>
            ))}
          </Select>
        </div>
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
