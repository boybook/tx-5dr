import React, { useState, useMemo, useRef, useCallback } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Button,
  Chip,
} from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { ProcessSnapshot } from '@tx5dr/contracts';
import type { HealthLevel } from '../hooks/useServerHealth';

const MB = 1024 * 1024;

// ─── Sparkline ──────────────────────────────────────────────────────────────

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
}: SparklineProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!wrapperRef.current || values.length < 2) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(Math.max(0, Math.min(1, relX)) * (values.length - 1));
    setHoveredIndex(idx);
  }, [values.length]);

  const handleMouseLeave = useCallback(() => {
    setHoveredIndex(null);
  }, []);

  if (values.length < 2) {
    return <div className="w-full" style={{ height }} />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
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

  const hoveredX = hoveredIndex !== null ? (hoveredIndex / (values.length - 1)) * 100 : null;
  const hoveredY = hoveredIndex !== null
    ? height - ((values[hoveredIndex] - min) / range) * (height - 4) - 2
    : null;

  // Clamp tooltip so it doesn't overflow left/right
  const tooltipPct = hoveredIndex !== null ? (hoveredIndex / (values.length - 1)) * 100 : 50;
  const tooltipTranslate =
    tooltipPct < 15 ? '0%' : tooltipPct > 85 ? '-100%' : '-50%';

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
  primaryValue: string;
  rows?: { label: string; value: string; barPercent?: number }[];
  sparkValues: number[];
  sparkWarn?: number;
  sparkCritical?: number;
  sparkTimestamps?: number[];
  sparkFormatValue?: (v: number) => string;
  children?: React.ReactNode;
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
        warnThreshold={sparkWarn}
        criticalThreshold={sparkCritical}
        timestamps={sparkTimestamps}
        formatValue={sparkFormatValue}
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

// ─── Time range selector ─────────────────────────────────────────────────────

type TimeRange = 5 | 15 | 30;
const TIME_RANGES: TimeRange[] = [5, 15, 30];

// ─── Main component ──────────────────────────────────────────────────────────

interface ServerHealthModalProps {
  isOpen: boolean;
  onClose: () => void;
  snapshots: ProcessSnapshot[];
  health: HealthLevel;
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
    () => displaySnapshots.map(s => s.memory.heapUsed / MB),
    [displaySnapshots]
  );
  const cpuValues = useMemo(
    () => displaySnapshots.map(s => s.cpu.total),
    [displaySnapshots]
  );
  const elValues = useMemo(
    () => displaySnapshots.map(s => s.eventLoop.p99),
    [displaySnapshots]
  );

  const statusLabel =
    health === 'good' ? t('serverHealth.statusGood') :
    health === 'warn' ? t('serverHealth.statusWarn') :
    health === 'critical' ? t('serverHealth.statusCritical') :
    t('serverHealth.statusUnknown');

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
                  sparkWarn={512}
                  sparkCritical={1024}
                  sparkTimestamps={timestamps}
                  sparkFormatValue={(v) => `${v.toFixed(0)} MB`}
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
                  title={t('serverHealth.cpu')}
                  primaryLabel={t('serverHealth.total')}
                  primaryValue={`${latest.cpu.total.toFixed(1)}%`}
                  sparkValues={cpuValues.length > 0 ? cpuValues : [0]}
                  sparkWarn={70}
                  sparkCritical={90}
                  sparkTimestamps={timestamps}
                  sparkFormatValue={(v) => `${v.toFixed(1)}%`}
                  rows={[
                    {
                      label: t('serverHealth.user'),
                      value: `${latest.cpu.user.toFixed(1)}%`,
                      barPercent: latest.cpu.user,
                    },
                    {
                      label: t('serverHealth.system'),
                      value: `${latest.cpu.system.toFixed(1)}%`,
                      barPercent: latest.cpu.system,
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
                      {latest.eventLoop.p99.toFixed(1)} ms
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-default-400">{t('serverHealth.p50')}</div>
                    <div className="text-lg font-mono text-default-600">{latest.eventLoop.p50.toFixed(1)} ms</div>
                  </div>
                  <div>
                    <div className="text-xs text-default-400">{t('serverHealth.mean')}</div>
                    <div className="text-lg font-mono text-default-600">{latest.eventLoop.mean.toFixed(1)} ms</div>
                  </div>
                </div>
                <Sparkline
                  values={elValues.length > 0 ? elValues : [0]}
                  height={52}
                  warnThreshold={30}
                  criticalThreshold={100}
                  timestamps={timestamps}
                  formatValue={(v) => `${v.toFixed(1)} ms`}
                />
              </div>

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
