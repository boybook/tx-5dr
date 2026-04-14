import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { Popover, PopoverTrigger, PopoverContent, Divider, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { api, calculateGridDistance } from '@tx5dr/core';
import { FlagDisplay } from '../../common/FlagDisplay';
import { useStationInfo } from '../../../store/radioStore';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CallsignInfoPopoverProps {
  callsign: string;
  /** LogbookAnalysis from the triggering row (provides grid/dxcc info) */
  logbookAnalysis?: { grid?: string; dxccEntity?: string };
  /** Country display fields from the triggering row */
  country?: string;
  countryZh?: string;
  countryEn?: string;
  countryCode?: string;
  flag?: string;
  children: React.ReactNode;
}

interface TrackingData {
  grid?: string;
  gridSource?: 'cq' | 'call';
  snrHistory: { snr: number; timestamp: number }[];
  lastSeenMs: number;
}

// ─── SNR Sparkline ──────────────────────────────────────────────────────────

const SPARKLINE_HEIGHT = 56;
const SNR_DEFAULT_MIN = -20;
const SNR_DEFAULT_MAX = 10;
const SNR_GRID_STEP = 10;
const SPARKLINE_PAD_TOP = 3;
const SPARKLINE_PAD_BOTTOM = 3;
const LABEL_WIDTH_PX = 24; // fixed pixel width for dB labels

function SnrSparkline({ values, timestamps }: { values: number[]; timestamps: string[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!wrapperRef.current || values.length < 2) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const chartLeft = LABEL_WIDTH_PX;
    const chartPx = rect.width - chartLeft;
    const relX = (e.clientX - rect.left - chartLeft) / chartPx;
    const idx = Math.round(Math.max(0, Math.min(1, relX)) * (values.length - 1));
    setHoveredIndex(idx);
  }, [values.length]);

  const handleMouseLeave = useCallback(() => setHoveredIndex(null), []);

  if (values.length < 2) return null;

  // Fixed scale: default -20 ~ +10, expand if data exceeds
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const scaleMin = Math.min(SNR_DEFAULT_MIN, Math.floor(dataMin / SNR_GRID_STEP) * SNR_GRID_STEP);
  const scaleMax = Math.max(SNR_DEFAULT_MAX, Math.ceil(dataMax / SNR_GRID_STEP) * SNR_GRID_STEP);
  const range = scaleMax - scaleMin;

  const drawableH = SPARKLINE_HEIGHT - SPARKLINE_PAD_TOP - SPARKLINE_PAD_BOTTOM;
  const valToY = (v: number) =>
    SPARKLINE_PAD_TOP + drawableH - ((v - scaleMin) / range) * drawableH;
  const valToYPct = (v: number) => (valToY(v) / SPARKLINE_HEIGHT) * 100;

  // Grid lines every 10 dB
  const gridLines: { db: number; yPct: number }[] = [];
  for (let db = scaleMin; db <= scaleMax; db += SNR_GRID_STEP) {
    gridLines.push({ db, yPct: valToYPct(db) });
  }

  // SVG viewBox is 100 wide, chart fills entire SVG (labels are HTML outside)
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100;
    return `${x},${valToY(v)}`;
  });

  const hoveredXPct = hoveredIndex !== null
    ? (hoveredIndex / (values.length - 1)) * 100
    : null;
  const hoveredYPct = hoveredIndex !== null ? valToYPct(values[hoveredIndex]) : null;

  const tooltipTranslate = hoveredXPct !== null
    ? (hoveredXPct < 15 ? '0%' : hoveredXPct > 85 ? '-100%' : '-50%')
    : '-50%';

  return (
    <div
      ref={wrapperRef}
      className="w-full relative"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ height: SPARKLINE_HEIGHT }}
    >
      {/* dB labels — rendered as HTML to avoid SVG non-scaling distortion */}
      <div className="absolute top-0 left-0 h-full pointer-events-none" style={{ width: LABEL_WIDTH_PX }}>
        {gridLines.map(({ db, yPct }) => (
          <span
            key={db}
            className="absolute right-0.5 text-[9px] text-current opacity-30 leading-none"
            style={{ top: `${yPct}%`, transform: 'translateY(-50%)' }}
          >
            {db}
          </span>
        ))}
      </div>
      {/* Chart area */}
      <div className="absolute top-0 h-full" style={{ left: LABEL_WIDTH_PX, right: 0 }}>
        <svg
          viewBox={`0 0 100 ${SPARKLINE_HEIGHT}`}
          preserveAspectRatio="none"
          className="w-full h-full"
          style={{ display: 'block' }}
        >
          {/* Horizontal grid lines */}
          {gridLines.map(({ db }) => (
            <line
              key={db}
              x1={0} y1={valToY(db)} x2={100} y2={valToY(db)}
              stroke="currentColor" strokeOpacity={0.1} strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Area fill */}
          <path
            d={`M${pts[0]} L${pts.join(' L')} L100,${SPARKLINE_HEIGHT - SPARKLINE_PAD_BOTTOM} L0,${SPARKLINE_HEIGHT - SPARKLINE_PAD_BOTTOM} Z`}
            fill="hsl(var(--heroui-primary))"
            fillOpacity={0.12}
          />
          {/* Line */}
          <polyline
            points={pts.join(' ')}
            fill="none"
            stroke="hsl(var(--heroui-primary))"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          {/* Hover vertical line */}
          {hoveredIndex !== null && hoveredXPct !== null && (
            <line
              x1={hoveredXPct} y1={0} x2={hoveredXPct} y2={SPARKLINE_HEIGHT}
              stroke="currentColor" strokeOpacity={0.4} strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* Hover dot */}
        {hoveredIndex !== null && hoveredXPct !== null && hoveredYPct !== null && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: `${hoveredXPct}%`,
              top: `${hoveredYPct}%`,
              transform: 'translate(-50%, -50%)',
              width: 7, height: 7, borderRadius: '50%',
              backgroundColor: 'hsl(var(--heroui-primary))',
            }}
          />
        )}
        {/* Tooltip */}
        {hoveredIndex !== null && hoveredXPct !== null && (
          <div
            className="absolute bottom-full mb-1 pointer-events-none z-50 bg-black/80 text-white text-[10px] rounded px-1.5 py-0.5 whitespace-nowrap"
            style={{ left: `${hoveredXPct}%`, transform: `translateX(${tooltipTranslate})` }}
          >
            <span className="text-default-300">{timestamps[hoveredIndex]}</span>
            {' '}
            <span className="font-medium">{values[hoveredIndex]} dB</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Popover Content ────────────────────────────────────────────────────────

function PopoverBody({ callsign, tracking, logbookAnalysis, country, countryZh, countryEn, countryCode, flag }: {
  callsign: string;
  tracking: TrackingData;
  logbookAnalysis?: { grid?: string; dxccEntity?: string };
  country?: string;
  countryZh?: string;
  countryEn?: string;
  countryCode?: string;
  flag?: string;
}) {
  const { t, i18n } = useTranslation('common');
  const isZh = i18n.language === 'zh';
  const stationInfo = useStationInfo();
  const myGrid = stationInfo?.qth?.grid;

  const grid = tracking.grid || logbookAnalysis?.grid;

  const distance = useMemo(() => {
    if (!myGrid || !grid) return null;
    const d = calculateGridDistance(myGrid, grid);
    if (d === null) return null;
    return Math.round(d);
  }, [myGrid, grid]);

  const countryName = isZh
    ? (countryZh || countryEn || country)
    : (countryEn || country);

  const snrValues = tracking.snrHistory.map(h => h.snr);
  const snrTimestamps = tracking.snrHistory.map(h => {
    const d = new Date(h.timestamp);
    return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
  });
  const avgSnr = snrValues.length > 0
    ? Math.round(snrValues.reduce((a, b) => a + b, 0) / snrValues.length)
    : null;
  const lastSnr = snrValues.length > 0 ? snrValues[snrValues.length - 1] : null;

  const dxccEntity = logbookAnalysis?.dxccEntity;

  return (
    <div className="p-2.5 w-[264px]">
      {/* Header: Callsign + Country */}
      <div className="flex items-center justify-between">
        <span className="font-mono font-semibold text-sm">{callsign}</span>
        {countryName && (
          <span className="flex items-center gap-1 text-xs text-default-500">
            <FlagDisplay flag={flag} countryCode={countryCode} />
            {countryName}
          </span>
        )}
      </div>

      {/* Grid + DXCC + Distance */}
      <div className="flex items-center justify-between mt-1.5 text-xs text-default-500">
        <span>
          {t('callsignPopover.grid')}: {grid || t('callsignPopover.noGrid')}
          {dxccEntity && <span className="ml-1.5 text-default-400">{dxccEntity}</span>}
        </span>
        {distance !== null && (
          <span className="text-default-400">
            {distance.toLocaleString()} km
          </span>
        )}
      </div>

      {/* SNR Chart */}
      {snrValues.length >= 2 && (
        <>
          <Divider className="my-2" />
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-default-500">{t('callsignPopover.signal')}</span>
            <span className="text-default-400">
              {t('callsignPopover.avg')}: {avgSnr} dB
              {lastSnr !== null && <span className="ml-2">{t('callsignPopover.last')}: {lastSnr} dB</span>}
            </span>
          </div>
          <SnrSparkline values={snrValues} timestamps={snrTimestamps} />
        </>
      )}

      {/* Single SNR value when < 2 data points */}
      {snrValues.length === 1 && (
        <>
          <Divider className="my-2" />
          <div className="flex items-center justify-between text-xs">
            <span className="text-default-500">{t('callsignPopover.signal')}</span>
            <span className="text-default-400">{snrValues[0]} dB</span>
          </div>
        </>
      )}

      {/* Footer: Seen count */}
      <div className="text-[10px] text-default-400 mt-1.5 text-right">
        {t('callsignPopover.seenTimes', { count: tracking.snrHistory.length })}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export const CallsignInfoPopover: React.FC<CallsignInfoPopoverProps> = ({
  callsign,
  logbookAnalysis,
  country,
  countryZh,
  countryEn,
  countryCode,
  flag,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tracking, setTracking] = useState<TrackingData | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedCallsignRef = useRef<string | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    openTimerRef.current = setTimeout(() => setIsOpen(true), 300);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; }
    closeTimerRef.current = setTimeout(() => setIsOpen(false), 150);
  }, []);

  // Fetch tracking data when popover opens
  useEffect(() => {
    if (!isOpen || fetchedCallsignRef.current === callsign) return;

    let cancelled = false;
    setLoading(true);
    fetchedCallsignRef.current = callsign;

    api.getCallsignTracking(callsign)
      .then(res => {
        if (!cancelled) {
          setTracking(res.data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [isOpen, callsign]);

  // Reset when callsign changes
  useEffect(() => {
    fetchedCallsignRef.current = null;
    setTracking(null);
  }, [callsign]);

  return (
    <Popover
      placement="right"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      showArrow
      offset={8}
      triggerScaleOnOpen={false}
    >
      <PopoverTrigger>
        <div
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {children}
        </div>
      </PopoverTrigger>
      <PopoverContent
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {loading ? (
          <div className="p-3 flex items-center justify-center">
            <Spinner size="sm" />
          </div>
        ) : tracking ? (
          <PopoverBody
            callsign={callsign}
            tracking={tracking}
            logbookAnalysis={logbookAnalysis}
            country={country}
            countryZh={countryZh}
            countryEn={countryEn}
            countryCode={countryCode}
            flag={flag}
          />
        ) : (
          <div className="p-2 text-xs text-default-400">{callsign}</div>
        )}
      </PopoverContent>
    </Popover>
  );
};
