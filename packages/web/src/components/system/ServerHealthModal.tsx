import React, { useState, useMemo, useRef, useCallback } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Button,
  Chip,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CoreCapabilityDiagnostics, CoreRadioCapabilities, ProcessSnapshot } from '@tx5dr/contracts';
import type { HealthLevel } from '../../hooks/useServerHealth';
import { getActiveCoreCapabilityDiagnostics } from '../../utils/coreCapabilityDiagnostics';

const MB = 1024 * 1024;

// ─── Sparkline ──────────────────────────────────────────────────────────────

interface SparklineSeries {
  values: number[];
  color: string;
  label: string;
  formatValue?: (v: number) => string;
}

interface SparklineProps {
  values: number[];
  height?: number;
  warnThreshold?: number;
  criticalThreshold?: number;
  color?: string;
  warnColor?: string;
  criticalColor?: string;
  timestamps?: number[];
  formatValue?: (v: number) => string;
  valueMin?: number;
  valueMaxFloor?: number;
  /** 多线模式：传入后忽略 values/color/warnThreshold/criticalThreshold */
  series?: SparklineSeries[];
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function Sparkline({
  values,
  height = 52,
  warnThreshold,
  criticalThreshold,
  color = 'hsl(var(--heroui-primary))',
  warnColor = 'hsl(var(--heroui-warning))',
  criticalColor = 'hsl(var(--heroui-danger))',
  timestamps,
  formatValue,
  valueMin,
  valueMaxFloor,
  series,
}: SparklineProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const primaryValues = series ? series[0].values : values;

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!wrapperRef.current || primaryValues.length < 2) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(Math.max(0, Math.min(1, relX)) * (primaryValues.length - 1));
    setHoveredIndex(idx);
  }, [primaryValues.length]);

  const handleMouseLeave = useCallback(() => {
    setHoveredIndex(null);
  }, []);

  if (primaryValues.length < 2) {
    return <div className="w-full" style={{ height }} />;
  }

  // Clamp tooltip so it doesn't overflow left/right
  const tooltipPct = hoveredIndex !== null ? (hoveredIndex / (primaryValues.length - 1)) * 100 : 50;
  const tooltipTranslate =
    tooltipPct < 15 ? '0%' : tooltipPct > 85 ? '-100%' : '-50%';

  const hoveredX = hoveredIndex !== null ? (hoveredIndex / (primaryValues.length - 1)) * 100 : null;

  // ── Multi-series mode ──────────────────────────────────────────────────────
  if (series && series.length > 0) {
    const allValues = series.flatMap(s => s.values);
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const range = max - min || 1;

    const computedSeries = series.map((s, idx) => {
      const pts = s.values.map((v, i) => {
        const x = (i / (s.values.length - 1)) * 100;
        const y = height - ((v - min) / range) * (height - 4) - 2;
        return `${x},${y}`;
      });
      const hoveredY =
        hoveredIndex !== null
          ? height - ((s.values[hoveredIndex] - min) / range) * (height - 4) - 2
          : null;
      return { ...s, pts, hoveredY, isFirst: idx === 0 };
    });

    return (
      <div
        ref={wrapperRef}
        className="w-full relative"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ height }}
      >
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          className="w-full h-full"
          style={{ display: 'block' }}
        >
          {/* Area fill only for first series */}
          {computedSeries.map((s) =>
            s.isFirst ? (
              <path
                key={`area-${s.label}`}
                d={`M${s.pts[0]} L${s.pts.join(' L')} L100,${height} L0,${height} Z`}
                fill={s.color}
                fillOpacity={0.12}
              />
            ) : null
          )}
          {/* Lines for all series */}
          {computedSeries.map((s) => (
            <polyline
              key={`line-${s.label}`}
              points={s.pts.join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Hover vertical line */}
          {hoveredIndex !== null && hoveredX !== null && (
            <line
              x1={hoveredX}
              y1={0}
              x2={hoveredX}
              y2={height}
              stroke="currentColor"
              strokeOpacity={0.4}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* Hover dots for each series */}
        {hoveredIndex !== null && hoveredX !== null &&
          computedSeries.map((s) =>
            s.hoveredY !== null ? (
              <div
                key={`dot-${s.label}`}
                className="absolute pointer-events-none"
                style={{
                  left: `${hoveredX}%`,
                  top: `${(s.hoveredY / height) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: s.color,
                }}
              />
            ) : null
          )
        }
        {/* Tooltip */}
        {hoveredIndex !== null && (
          <div
            className="absolute bottom-full mb-1.5 pointer-events-none z-50 bg-black/80 text-white text-xs rounded px-2 py-1 whitespace-nowrap"
            style={{
              left: `${tooltipPct}%`,
              transform: `translateX(${tooltipTranslate})`,
            }}
          >
            {timestamps?.[hoveredIndex] && (
              <div className="text-default-300 mb-0.5">{formatTimestamp(timestamps[hoveredIndex])}</div>
            )}
            {computedSeries.map((s) => (
              <div key={`tip-${s.label}`} className="flex items-center gap-1.5">
                <span
                  className="inline-block rounded-full flex-shrink-0"
                  style={{ width: 6, height: 6, backgroundColor: s.color }}
                />
                <span className="text-default-300">{s.label}</span>
                <span className="font-mono font-semibold ml-1">
                  {s.formatValue
                    ? s.formatValue(s.values[hoveredIndex])
                    : s.values[hoveredIndex].toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Single-series mode (original) ─────────────────────────────────────────
  const min = valueMin ?? Math.min(...values);
  const max = Math.max(Math.max(...values), valueMaxFloor ?? -Infinity);
  const range = max - min || 1;
  const latest = values[values.length - 1];

  const activeColor =
    criticalThreshold !== undefined && latest >= criticalThreshold
      ? criticalColor
      : warnThreshold !== undefined && latest >= warnThreshold
        ? warnColor
        : color;

  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });

  const areaPath = `M${pts[0]} L${pts.join(' L')} L100,${height} L0,${height} Z`;

  const hoveredY = hoveredIndex !== null
    ? height - ((values[hoveredIndex] - min) / range) * (height - 4) - 2
    : null;

  return (
    <div
      ref={wrapperRef}
      className="w-full relative"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ height }}
    >
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="w-full h-full"
        style={{ display: 'block' }}
      >
        <path d={areaPath} fill={activeColor} fillOpacity={0.12} />
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke={activeColor}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        {hoveredIndex !== null && hoveredX !== null && (
          <line
            x1={hoveredX}
            y1={0}
            x2={hoveredX}
            y2={height}
            stroke="currentColor"
            strokeOpacity={0.4}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hoveredIndex !== null && hoveredX !== null && hoveredY !== null && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: `${hoveredX}%`,
            top: `${(hoveredY / height) * 100}%`,
            transform: 'translate(-50%, -50%)',
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: activeColor,
          }}
        />
      )}
      {hoveredIndex !== null && (
        <div
          className="absolute bottom-full mb-1.5 pointer-events-none z-50 bg-black/80 text-white text-xs rounded px-2 py-1 whitespace-nowrap"
          style={{
            left: `${tooltipPct}%`,
            transform: `translateX(${tooltipTranslate})`,
          }}
        >
          {timestamps?.[hoveredIndex] && (
            <div className="text-default-300">{formatTimestamp(timestamps[hoveredIndex])}</div>
          )}
          <div className="font-mono font-semibold">
            {formatValue ? formatValue(values[hoveredIndex]) : values[hoveredIndex].toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MetricCard ──────────────────────────────────────────────────────────────

interface MetricCardProps {
  title: string;
  primaryLabel: string;
  primaryValue: React.ReactNode;
  rows?: { label: string; value: string; barPercent?: number }[];
  sparkValues: number[];
  sparkWarn?: number;
  sparkCritical?: number;
  sparkTimestamps?: number[];
  sparkFormatValue?: (v: number) => string;
  sparkValueMin?: number;
  sparkValueMaxFloor?: number;
  /** 多线模式：传入后 sparkValues/sparkWarn/sparkCritical/sparkFormatValue 被忽略 */
  sparkSeries?: SparklineSeries[];
}

function MetricCard({
  title,
  primaryLabel,
  primaryValue,
  rows,
  sparkValues,
  sparkWarn,
  sparkCritical,
  sparkTimestamps,
  sparkFormatValue,
  sparkValueMin,
  sparkValueMaxFloor,
  sparkSeries,
}: MetricCardProps) {
  return (
    <div className="bg-content2 rounded-xl p-4 flex flex-col gap-3">
      <div className="text-xs font-semibold text-default-500 uppercase tracking-wider">{title}</div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-xs text-default-400">{primaryLabel}</div>
          <div className="text-2xl font-mono font-semibold text-foreground leading-tight">{primaryValue}</div>
        </div>
      </div>
      <Sparkline
        values={sparkValues}
        height={52}
        warnThreshold={sparkSeries ? undefined : sparkWarn}
        criticalThreshold={sparkSeries ? undefined : sparkCritical}
        timestamps={sparkTimestamps}
        formatValue={sparkFormatValue}
        valueMin={sparkSeries ? undefined : sparkValueMin}
        valueMaxFloor={sparkSeries ? undefined : sparkValueMaxFloor}
        series={sparkSeries}
      />
      {rows && rows.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-1">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-2">
              <span className="text-xs text-default-500 w-20 flex-shrink-0">{row.label}</span>
              {row.barPercent !== undefined ? (
                <div className="flex-1 h-1.5 rounded-full bg-default-200 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-default-400 transition-all"
                    style={{ width: `${Math.min(row.barPercent, 100)}%` }}
                  />
                </div>
              ) : (
                <div className="flex-1" />
              )}
              <span className="text-xs font-mono text-default-600 text-right w-20">{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Uptime formatter ────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  return `${(bytes / MB).toFixed(0)} MB`;
}

function safeFixed(value: number | null | undefined, digits: number): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
}

function toCapacityPercent(value: number | null | undefined, capacity: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  const resolvedCapacity = capacity && capacity > 0 ? capacity : 100;
  return (value / resolvedCapacity) * 100;
}

function normalizedCpuPercent(value: number | null | undefined, capacity: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return toCapacityPercent(value, capacity);
}

function singleCoreNormalizedPercent(capacity: number | null | undefined): number {
  if (capacity == null || Number.isNaN(capacity) || capacity <= 0) return 100;
  return Math.min(Math.max(10000 / capacity, 0), 100);
}

function formatCpuLoad(
  total: number | null | undefined,
  capacity: number | null | undefined,
  normalizedTotal?: number | null
): string {
  const value = normalizedTotal ?? normalizedCpuPercent(total, capacity);
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function formatOptionalPercent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function formatOptionalNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toString();
}

function CpuDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-default-500">{label}</span>
      <span className="text-xs font-mono text-default-700">{value}</span>
    </div>
  );
}

function CpuLoadValue({ snapshot }: { snapshot: ProcessSnapshot }) {
  const { t } = useTranslation('settings');
  const [isOpen, setIsOpen] = useState(false);
  const normalizedTotal = snapshot.cpu.normalizedTotal ?? normalizedCpuPercent(snapshot.cpu.total, snapshot.cpu.capacity);

  return (
    <Popover
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      placement="top-start"
      showArrow
    >
      <PopoverTrigger>
        <span
          role="button"
          tabIndex={0}
          className="inline-flex cursor-help rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          onMouseEnter={() => setIsOpen(true)}
          onMouseLeave={() => setIsOpen(false)}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setIsOpen(false)}
        >
          {formatCpuLoad(snapshot.cpu.total, snapshot.cpu.capacity, snapshot.cpu.normalizedTotal)}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        <div className="flex w-full flex-col gap-2">
          <div className="text-xs font-semibold text-default-600 uppercase tracking-wider">
            {t('serverHealth.cpuFullData')}
          </div>
          <CpuDetailRow
            label={t('serverHealth.displayLoad')}
            value={formatOptionalPercent(normalizedTotal)}
          />
          <CpuDetailRow
            label={t('serverHealth.rawProcessCpu')}
            value={formatOptionalPercent(snapshot.cpu.total)}
          />
          <CpuDetailRow
            label={t('serverHealth.userRaw')}
            value={formatOptionalPercent(snapshot.cpu.user)}
          />
          <CpuDetailRow
            label={t('serverHealth.systemRaw')}
            value={formatOptionalPercent(snapshot.cpu.system)}
          />
          <CpuDetailRow
            label={t('serverHealth.availableCapacity')}
            value={formatOptionalPercent(snapshot.cpu.capacity)}
          />
          <div className="my-1 h-px bg-default-200" />
          <CpuDetailRow
            label={t('serverHealth.hostCpuTotal')}
            value={formatOptionalPercent(snapshot.hostCpu?.totalUsage)}
          />
          <CpuDetailRow
            label={t('serverHealth.logicalCores')}
            value={formatOptionalNumber(snapshot.hostCpu?.logicalCores)}
          />
          <CpuDetailRow
            label={t('serverHealth.availableParallelism')}
            value={formatOptionalNumber(snapshot.hostCpu?.availableParallelism)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Time range selector ─────────────────────────────────────────────────────

type TimeRange = 5 | 15 | 30;
const TIME_RANGES: TimeRange[] = [5, 15, 30];

// ─── Main component ──────────────────────────────────────────────────────────

interface ServerHealthModalProps {
  isOpen: boolean;
  onClose: () => void;
  snapshots: ProcessSnapshot[];
  health: HealthLevel;
  coreCapabilities: CoreRadioCapabilities | null;
  coreCapabilityDiagnostics: CoreCapabilityDiagnostics | null;
}

const healthChipColors: Record<HealthLevel, 'success' | 'warning' | 'danger' | 'default'> = {
  good: 'success',
  warn: 'warning',
  critical: 'danger',
  unknown: 'default',
};

export const ServerHealthModal: React.FC<ServerHealthModalProps> = ({
  isOpen,
  onClose,
  snapshots,
  health,
  coreCapabilities,
  coreCapabilityDiagnostics,
}) => {
  const { t } = useTranslation('settings');
  const [timeRange, setTimeRange] = useState<TimeRange>(15);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  // Slice snapshots to the selected time range
  const INTERVAL_S = 2;
  const displaySnapshots = useMemo(() => {
    const count = (timeRange * 60) / INTERVAL_S;
    return snapshots.slice(-count);
  }, [snapshots, timeRange]);

  const timestamps = useMemo(
    () => displaySnapshots.map(s => s.timestamp),
    [displaySnapshots]
  );
  const memValues = useMemo(
    () => displaySnapshots.map(s => (s.memory.heapUsed ?? 0) / MB),
    [displaySnapshots]
  );
  const rssValues = useMemo(
    () => displaySnapshots.map(s => (s.memory.rss ?? 0) / MB),
    [displaySnapshots]
  );
  const cpuValues = useMemo(
    () => displaySnapshots.map(s => s.cpu.normalizedTotal ?? normalizedCpuPercent(s.cpu.total, s.cpu.capacity) ?? 0),
    [displaySnapshots]
  );
  const elValues = useMemo(
    () => displaySnapshots.map(s => s.eventLoop.p99 ?? 0),
    [displaySnapshots]
  );
  const unsupportedCoreCapabilities = useMemo(
    () => getActiveCoreCapabilityDiagnostics(coreCapabilities, coreCapabilityDiagnostics),
    [coreCapabilities, coreCapabilityDiagnostics]
  );

  const statusLabel =
    health === 'good' ? t('serverHealth.statusGood') :
    health === 'warn' ? t('serverHealth.statusWarn') :
    health === 'critical' ? t('serverHealth.statusCritical') :
    t('serverHealth.statusUnknown');

  const capabilityLabelMap = useMemo(() => ({
    readFrequency: t('serverHealth.coreCapabilityLabels.readFrequency'),
    writeFrequency: t('serverHealth.coreCapabilityLabels.writeFrequency'),
    readRadioMode: t('serverHealth.coreCapabilityLabels.readRadioMode'),
    writeRadioMode: t('serverHealth.coreCapabilityLabels.writeRadioMode'),
  }), [t]);

  const timeRangeKey: Record<TimeRange, string> = {
    5: t('serverHealth.timeRange5m'),
    15: t('serverHealth.timeRange15m'),
    30: t('serverHealth.timeRange30m'),
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0 pb-2">
          <div className="flex items-center justify-between w-full pr-6">
            <span className="text-base font-semibold">{t('serverHealth.title')}</span>
            <div className="flex items-center gap-2">
              <Chip
                size="sm"
                color={healthChipColors[health]}
                variant="flat"
                className="text-xs"
              >
                {statusLabel}
              </Chip>
              {latest && (
                <span className="text-xs text-default-400 font-mono">
                  {t('serverHealth.uptime')}: {formatUptime(latest.uptimeSeconds)}
                </span>
              )}
            </div>
          </div>
        </ModalHeader>

        <ModalBody className="pb-6">
          {!latest ? (
            <div className="text-center text-default-400 text-sm py-8">
              {t('serverHealth.noData')}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Memory + CPU side by side */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Memory card */}
                <MetricCard
                  title={t('serverHealth.memory')}
                  primaryLabel={t('serverHealth.heapUsed')}
                  primaryValue={formatBytes(latest.memory.heapUsed)}
                  sparkValues={memValues.length > 0 ? memValues : [0]}
                  sparkTimestamps={timestamps}
                  sparkSeries={[
                    {
                      values: memValues.length > 0 ? memValues : [0],
                      color: 'hsl(var(--heroui-primary))',
                      label: t('serverHealth.heapUsed'),
                      formatValue: (v) => `${v.toFixed(0)} MB`,
                    },
                    {
                      values: rssValues.length > 0 ? rssValues : [0],
                      color: 'hsl(var(--heroui-secondary))',
                      label: t('serverHealth.rss'),
                      formatValue: (v) => `${v.toFixed(0)} MB`,
                    },
                  ]}
                  rows={[
                    {
                      label: t('serverHealth.rss'),
                      value: formatBytes(latest.memory.rss),
                      barPercent: (latest.memory.rss / (2048 * MB)) * 100,
                    },
                    {
                      label: t('serverHealth.heapTotal'),
                      value: formatBytes(latest.memory.heapTotal),
                      barPercent: (latest.memory.heapTotal / (latest.memory.rss || 1)) * 100,
                    },
                  ]}
                />

                {/* CPU card */}
                <MetricCard
                  title={t('serverHealth.cpuLoad')}
                  primaryLabel={t('serverHealth.total')}
                  primaryValue={<CpuLoadValue snapshot={latest} />}
                  sparkValues={cpuValues.length > 0 ? cpuValues : [0]}
                  sparkTimestamps={timestamps}
                  sparkFormatValue={(v) => `${v.toFixed(1)}%`}
                  sparkValueMin={0}
                  sparkValueMaxFloor={singleCoreNormalizedPercent(latest.cpu.capacity)}
                  rows={[
                    {
                      label: t('serverHealth.user'),
                      value: `${safeFixed(normalizedCpuPercent(latest.cpu.user, latest.cpu.capacity), 1)}%`,
                      barPercent: toCapacityPercent(latest.cpu.user, latest.cpu.capacity),
                    },
                    {
                      label: t('serverHealth.system'),
                      value: `${safeFixed(normalizedCpuPercent(latest.cpu.system, latest.cpu.capacity), 1)}%`,
                      barPercent: toCapacityPercent(latest.cpu.system, latest.cpu.capacity),
                    },
                  ]}
                />
              </div>

              {/* Event Loop - full width */}
              <div className="bg-content2 rounded-xl p-4 flex flex-col gap-3">
                <div className="text-xs font-semibold text-default-500 uppercase tracking-wider">{t('serverHealth.eventLoop')}</div>
                <div className="flex items-end gap-6">
                  <div>
                    <div className="text-xs text-default-400">{t('serverHealth.p99')}</div>
                    <div className="text-2xl font-mono font-semibold text-foreground leading-tight">
                      {safeFixed(latest.eventLoop.p99, 1)} ms
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-default-400">{t('serverHealth.p50')}</div>
                    <div className="text-lg font-mono text-default-600">{safeFixed(latest.eventLoop.p50, 1)} ms</div>
                  </div>
                  <div>
                    <div className="text-xs text-default-400">{t('serverHealth.mean')}</div>
                    <div className="text-lg font-mono text-default-600">{safeFixed(latest.eventLoop.mean, 1)} ms</div>
                  </div>
                </div>
                <Sparkline
                  values={elValues.length > 0 ? elValues : [0]}
                  height={52}
                  warnThreshold={50}
                  criticalThreshold={100}
                  timestamps={timestamps}
                  formatValue={(v) => `${v.toFixed(1)} ms`}
                />
              </div>

              {unsupportedCoreCapabilities.length > 0 && (
                <div className="bg-content2 rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-default-500 uppercase tracking-wider">
                      {t('serverHealth.coreCapabilityDiagnosticsTitle')}
                    </div>
                    <Chip
                      size="sm"
                      color="warning"
                      variant="flat"
                      className="text-xs"
                    >
                      {t('serverHealth.coreCapabilityCount', { count: unsupportedCoreCapabilities.length })}
                    </Chip>
                  </div>

                  <div className="flex flex-col gap-2">
                    {unsupportedCoreCapabilities.map((diagnostic) => (
                      <details
                        key={`${diagnostic.capability}-${diagnostic.recordedAt}`}
                        className="group rounded-lg border border-default-200 bg-content1 px-3 py-2"
                      >
                        <summary className="list-none cursor-pointer">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <Chip size="sm" color="warning" variant="flat" className="text-[11px]">
                                  {t('serverHealth.coreCapabilityUnsupported')}
                                </Chip>
                                <span className="text-sm font-semibold text-foreground">
                                  {capabilityLabelMap[diagnostic.capability]}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-default-500">
                                {t('serverHealth.recordedAt')}: {new Date(diagnostic.recordedAt).toLocaleString()}
                              </div>
                              <div className="mt-2 text-sm text-default-700 break-words">
                                {diagnostic.message}
                              </div>
                            </div>
                            <span className="mt-0.5 text-xs text-default-400 group-open:rotate-90 transition-transform">
                              &gt;
                            </span>
                          </div>
                        </summary>
                        <div className="mt-3 border-t border-default-200 pt-3">
                          <div className="text-xs text-default-500 mb-1">
                            {t('serverHealth.stackTrace')}
                          </div>
                          <pre className="text-xs leading-5 whitespace-pre-wrap break-all text-default-700 bg-default-100 rounded-md p-3 overflow-x-auto">
                            {diagnostic.stack}
                          </pre>
                        </div>
                      </details>
                    ))}
                  </div>
                </div>
              )}

              {/* Time range selector */}
              <div className="flex items-center gap-2 justify-end">
                {TIME_RANGES.map(r => (
                  <Button
                    key={r}
                    size="sm"
                    variant={timeRange === r ? 'flat' : 'light'}
                    color={timeRange === r ? 'primary' : 'default'}
                    onPress={() => setTimeRange(r)}
                    className="min-w-0 px-3 h-7 text-xs"
                  >
                    {timeRangeKey[r]}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};
