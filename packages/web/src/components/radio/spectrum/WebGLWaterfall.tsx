import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../../utils/logger';
import type { SpectrumAxis, SpectrumRenderBatch, SpectrumStreamController } from '../../../spectrum/SpectrumStreamController';
import {
  buildSpectrumThemeColorLut,
  DEFAULT_SPECTRUM_THEME_ID,
  getSafeSpectrumThemeCurve,
  type SpectrumThemeId,
} from './spectrumThemes';

const logger = createLogger('WebGLWaterfall');

export interface AutoRangeConfig {
  updateInterval: number;      // 更新频率（帧数），默认10
  minPercentile: number;        // 最小值百分位数（0-100），默认15
  maxPercentile: number;        // 最大值百分位数（0-100），默认99
  rangeExpansionFactor: number; // 范围扩展因子，默认4.0
}

export interface RxFrequency {
  operatorId: string;
  callsign: string;
  frequency: number;
}

export interface TxFrequency {
  operatorId: string;
  frequency: number;
  callsign?: string;
}

export interface BasebandInteractionRange {
  min: number;
  max: number;
}

export interface InteractionFrequencyRange {
  min: number;
  max: number;
}

export interface TxBandOverlay {
  id: string;
  label: string;
  lineFrequency: number;
  rangeStartFrequency: number;
  rangeEndFrequency: number;
  draggable?: boolean;
}

export interface FrequencyBandOverlay {
  id: string;
  label: string;
  centerFrequency: number;
  rangeStartFrequency: number;
  rangeEndFrequency: number;
  draggable?: boolean;
  resizable?: boolean;
  minCenterFrequency?: number;
  maxCenterFrequency?: number;
  minWidthHz?: number;
  maxWidthHz?: number;
  stepHz?: number;
  centerStepHz?: number;
  widthStepHz?: number;
  description?: string;
}

export interface FrequencyBandOverlayChange {
  centerFrequency: number;
  rangeStartFrequency: number;
  rangeEndFrequency: number;
  widthHz: number;
}

export interface PresetMarker {
  id: string;
  frequency: number;
  label: string;
  description?: string | null;
  clickable?: boolean;
}

interface WebGLWaterfallProps {
  controller: SpectrumStreamController;
  className?: string;
  height?: number;
  minDb?: number;
  maxDb?: number;
  autoRange?: boolean;
  autoRangeConfig?: AutoRangeConfig;
  rxFrequencies?: RxFrequency[];
  txFrequencies?: TxFrequency[];
  txBandOverlays?: TxBandOverlay[];
  frequencyBandOverlays?: FrequencyBandOverlay[];
  presetMarkers?: PresetMarker[];
  frequencyRangeMode?: 'baseband' | 'absolute-center' | 'absolute-fixed' | 'absolute-windowed';
  referenceFrequencyHz?: number | null;
  basebandInteractionRange?: BasebandInteractionRange;
  interactionFrequencyMode?: 'baseband' | 'absolute';
  interactionFrequencyRange?: InteractionFrequencyRange | null;
  interactionFrequencyStepHz?: number | null;
  onTxFrequencyChange?: (operatorId: string, frequency: number) => void;
  onTxBandOverlayFrequencyChange?: (id: string, frequency: number) => void;
  onFrequencyBandOverlayPreviewChange?: (id: string, change: FrequencyBandOverlayChange) => void;
  onFrequencyBandOverlayCommit?: (id: string, change: FrequencyBandOverlayChange) => void;
  onPresetMarkerClick?: (frequency: number) => void;
  onDragFrequencyPreview?: (frequency: number) => void;
  onDragFrequencyChange?: (frequency: number) => void;
  onDragFrequencyActiveChange?: (active: boolean) => void;
  enableHorizontalWheelFrequency?: boolean;
  dragFrequencyStepHz?: number | null;
  dragFrequencyCommitIntervalMs?: number;
  onDoubleClickSetFrequency?: (frequency: number) => void;
  onRightClickSetFrequency?: (frequency: number) => void;
  onActualRangeChange?: (range: { min: number; max: number } | null) => void;
  hoverFrequency?: number | null;
  markerAxis?: SpectrumAxis | null;
  markerOnly?: boolean;
  /** 纹理总行数，不足时底部用暗色填充，实现从顶部逐渐填充的效果 */
  totalRows?: number;
  /** 当前是否处于发射状态，用于 TX/RX 自动范围分离 */
  isTransmitting?: boolean;
  /** 瀑布图颜色和强度曲线主题 */
  themeId?: SpectrumThemeId;
  /** 是否显示数字模式周期开始分割线 */
  showCycleMarkers?: boolean;
  /** 数字模式周期长度（毫秒），例如 FT8=15000、FT4=7500 */
  cycleSlotMs?: number | null;
}

const FREQUENCY_GESTURE_DRAG_THRESHOLD_PX = 4;
export const WATERFALL_DRAG_FREQUENCY_COMMIT_INTERVAL_MS = 80;
export const WATERFALL_HORIZONTAL_WHEEL_SESSION_IDLE_MS = 350;
export const WATERFALL_HORIZONTAL_WHEEL_FREQUENCY_SCALE = 0.25;
export const WATERFALL_WHEEL_DELTA_PIXEL = 0;
export const WATERFALL_WHEEL_DELTA_LINE = 1;
export const WATERFALL_WHEEL_DELTA_PAGE = 2;
export const WATERFALL_MAX_DEVICE_PIXEL_RATIO = 1.5;
export const WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ = 15;

export function getWaterfallDragCommitDelayMs(
  nowMs: number,
  lastCommitAtMs: number | null | undefined,
  intervalMs = WATERFALL_DRAG_FREQUENCY_COMMIT_INTERVAL_MS,
): number {
  if (
    typeof lastCommitAtMs !== 'number'
    || !Number.isFinite(lastCommitAtMs)
    || lastCommitAtMs <= 0
  ) {
    return 0;
  }

  return Math.max(0, intervalMs - (nowMs - lastCommitAtMs));
}

export function getWaterfallDragTunedFrequency(
  startFrequency: number,
  dragDistancePx: number,
  hzPerPixel: number,
): number {
  return startFrequency - dragDistancePx * hzPerPixel;
}

export function normalizeWaterfallWheelDeltaX(
  event: Pick<WheelEvent, 'deltaX' | 'deltaMode'>,
  pageWidthPx: number,
): number {
  if (!Number.isFinite(event.deltaX) || event.deltaX === 0) {
    return 0;
  }
  switch (event.deltaMode) {
    case WATERFALL_WHEEL_DELTA_LINE:
      return event.deltaX * 16;
    case WATERFALL_WHEEL_DELTA_PAGE:
      return event.deltaX * Math.max(1, pageWidthPx);
    case WATERFALL_WHEEL_DELTA_PIXEL:
    default:
      return event.deltaX;
  }
}

export function shouldHandleWaterfallHorizontalWheel(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'ctrlKey'>,
): boolean {
  if (event.ctrlKey) {
    return false;
  }
  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  return absX >= 0.5 && absX > absY * 1.25;
}

export function getWaterfallHorizontalWheelTunedFrequency(
  startFrequency: number,
  accumulatedDeltaXPx: number,
  hzPerPixel: number,
  scale = WATERFALL_HORIZONTAL_WHEEL_FREQUENCY_SCALE,
): number {
  return startFrequency + accumulatedDeltaXPx * hzPerPixel * scale;
}

export function getWaterfallCanvasPixelRatio(devicePixelRatio: number | null | undefined): number {
  return Math.max(
    1,
    Math.min(
      WATERFALL_MAX_DEVICE_PIXEL_RATIO,
      typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1,
    ),
  );
}

export function createWaterfallUploadBuffer(width: number, height: number): Uint8Array {
  return new Uint8Array(Math.max(0, width) * Math.max(0, height));
}

export type WaterfallLocalGestureSource = 'mouse-drag' | 'horizontal-wheel';

export interface WaterfallLocalGestureFrequencyOverride {
  source: WaterfallLocalGestureSource;
  frequency: number;
}

export function clearWaterfallGestureOverrideForSource(
  current: WaterfallLocalGestureFrequencyOverride | null,
  source: WaterfallLocalGestureSource,
): WaterfallLocalGestureFrequencyOverride | null {
  return current?.source === source ? null : current;
}

interface HorizontalWheelFrequencyRuntime {
  enabled: boolean;
  hasAxis: boolean;
  minFrequency: number;
  maxFrequency: number;
  interactionFrequencyMode: 'baseband' | 'absolute';
  effectiveDragFrequencyStepHz: number | null | undefined;
  dragFrequencyCommitIntervalMs: number;
  isMouseFrequencyDragActive: boolean;
  getCurrentReferenceInteractionFrequency: () => number | null;
  clampInteractionFrequency: (frequency: number, stepHz?: number | null) => number;
  clampBasebandFrequency: (frequency: number, stepHz?: number | null) => number;
  onDragFrequencyPreview: ((frequency: number) => void) | undefined;
  onDragFrequencyChange: ((frequency: number) => void) | undefined;
  onDragFrequencyActiveChange: ((active: boolean) => void) | undefined;
}

export function ensureWaterfallScratchRow(current: Uint8Array | null, width: number): Uint8Array {
  if (!current || current.length !== width) {
    return new Uint8Array(Math.max(0, width));
  }
  return current;
}

export function getWaterfallFrequencyPositionPercent(
  displayFrequency: number,
  minFrequency: number,
  maxFrequency: number,
  visualOffsetHz = WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ,
): number {
  return ((displayFrequency + visualOffsetHz - minFrequency) / (maxFrequency - minFrequency)) * 100;
}

function areAxesEqual(left: SpectrumAxis | null, right: SpectrumAxis | null): boolean {
  return Boolean(
    left
    && right
    && left.minHz === right.minHz
    && left.maxHz === right.maxHz
    && left.binCount === right.binCount
  ) || (left === null && right === null);
}

export function easeSpectrumAxisTransition(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  // A steep ease-in-out keeps the view settled near both ends, then crosses the middle quickly.
  return t < 0.5
    ? 0.5 * Math.pow(t * 2, 4)
    : 1 - 0.5 * Math.pow((1 - t) * 2, 4);
}

export function interpolateSpectrumAxis(
  fromAxis: SpectrumAxis,
  toAxis: SpectrumAxis,
  progress: number
): SpectrumAxis {
  const t = easeSpectrumAxisTransition(progress);
  return {
    minHz: fromAxis.minHz + (toAxis.minHz - fromAxis.minHz) * t,
    maxHz: fromAxis.maxHz + (toAxis.maxHz - fromAxis.maxHz) * t,
    binCount: toAxis.binCount,
  };
}

function calculateSpectrumAxisTransitionDuration(fromAxis: SpectrumAxis, toAxis: SpectrumAxis): number {
  const fromSpan = fromAxis.maxHz - fromAxis.minHz;
  const toSpan = toAxis.maxHz - toAxis.minHz;
  if (!Number.isFinite(fromSpan) || !Number.isFinite(toSpan) || fromSpan <= 0 || toSpan <= 0) {
    return 0;
  }

  const fromCenter = fromAxis.minHz + fromSpan / 2;
  const toCenter = toAxis.minHz + toSpan / 2;
  const centerShiftRatio = Math.abs(toCenter - fromCenter) / Math.max(fromSpan, toSpan, 1);
  const spanShiftRatio = Math.abs(toSpan - fromSpan) / Math.max(fromSpan, toSpan, 1);
  if (centerShiftRatio < 0.002 && spanShiftRatio < 0.002) {
    return 0;
  }

  return Math.max(90, Math.min(360, 120 + (centerShiftRatio + spanShiftRatio) * 180));
}

type MutableRef<T> = { current: T };

export interface WaterfallTextureMemoryRefs {
  scratchRowRef: MutableRef<Uint8Array | null>;
  lastDataLengthRef: MutableRef<number>;
  textureHeightRef: MutableRef<number>;
  rowCountRef: MutableRef<number>;
  headRowRef: MutableRef<number>;
}

export function releaseWaterfallTextureMemoryRefs(refs: WaterfallTextureMemoryRefs): void {
  refs.scratchRowRef.current = null;
  refs.lastDataLengthRef.current = 0;
  refs.textureHeightRef.current = 1;
  refs.rowCountRef.current = 0;
  refs.headRowRef.current = 0;
}

export interface CycleMarkerPosition {
  id: string;
  topPercent: number;
  timestamp: number;
}

export function buildCycleMarkerPositions(
  rowTimestamps: ArrayLike<number>,
  cycleSlotMs: number | null | undefined,
  visibleRows = rowTimestamps.length
): CycleMarkerPosition[] {
  const safeVisibleRows = Math.max(1, visibleRows);
  if (!cycleSlotMs || !Number.isFinite(cycleSlotMs) || cycleSlotMs <= 0 || rowTimestamps.length < 2) {
    return [];
  }

  const markers: CycleMarkerPosition[] = [];
  const seenBoundaries = new Set<number>();
  const rowCount = rowTimestamps.length;

  for (let index = 0; index < rowCount - 1; index += 1) {
    const newerTimestamp = rowTimestamps[index];
    const olderTimestamp = rowTimestamps[index + 1];
    if (
      !Number.isFinite(newerTimestamp)
      || !Number.isFinite(olderTimestamp)
      || newerTimestamp <= olderTimestamp
    ) {
      continue;
    }

    const firstBoundary = Math.floor(olderTimestamp / cycleSlotMs) * cycleSlotMs + cycleSlotMs;
    for (let boundary = firstBoundary; boundary <= newerTimestamp; boundary += cycleSlotMs) {
      if (boundary <= olderTimestamp || seenBoundaries.has(boundary)) {
        continue;
      }

      const offsetWithinPair = (newerTimestamp - boundary) / (newerTimestamp - olderTimestamp);
      const topPercent = ((index + 0.5 + offsetWithinPair) / safeVisibleRows) * 100;
      if (!Number.isFinite(topPercent) || topPercent < 0 || topPercent > 100) {
        continue;
      }

      seenBoundaries.add(boundary);
      markers.push({
        id: `${boundary}-${index}`,
        topPercent,
        timestamp: boundary,
      });
    }
  }

  return markers;
}

export const WebGLWaterfall: React.FC<WebGLWaterfallProps> = ({
  controller,
  className = '',
  height = 200,
  minDb = -35,
  maxDb = 10,
  autoRange = true,
  autoRangeConfig = {
    updateInterval: 10,
    minPercentile: 15,
    maxPercentile: 99,
    rangeExpansionFactor: 4.0,
  },
  rxFrequencies = [],
  txFrequencies = [],
  txBandOverlays = [],
  frequencyBandOverlays = [],
  presetMarkers = [],
  frequencyRangeMode = 'baseband',
  referenceFrequencyHz = null,
  basebandInteractionRange = { min: 0, max: 3000 },
  interactionFrequencyMode = 'baseband',
  interactionFrequencyRange = null,
  interactionFrequencyStepHz = null,
  onTxFrequencyChange,
  onTxBandOverlayFrequencyChange,
  onFrequencyBandOverlayPreviewChange,
  onFrequencyBandOverlayCommit,
  onPresetMarkerClick,
  onDragFrequencyPreview,
  onDragFrequencyChange,
  onDragFrequencyActiveChange,
  enableHorizontalWheelFrequency = false,
  dragFrequencyStepHz = null,
  dragFrequencyCommitIntervalMs = WATERFALL_DRAG_FREQUENCY_COMMIT_INTERVAL_MS,
  onDoubleClickSetFrequency,
  onRightClickSetFrequency,
  onActualRangeChange,
  hoverFrequency,
  markerAxis = null,
  markerOnly = false,
  totalRows,
  isTransmitting = false,
  themeId = DEFAULT_SPECTRUM_THEME_ID,
  showCycleMarkers = false,
  cycleSlotMs = null,
}) => {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cycleMarkerLayerRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const textureRef = useRef<WebGLTexture | null>(null);
  const transitionTextureRef = useRef<WebGLTexture | null>(null);
  const animationRef = useRef<number>();
  const [webglSupported, setWebglSupported] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [viewState, setViewState] = React.useState<{ axis: SpectrumAxis | null; hasData: boolean }>({
    axis: null,
    hasData: false,
  });
  const [actualRange, setActualRange] = React.useState<{min: number, max: number} | null>(null);
  const [cycleMarkers, setCycleMarkers] = React.useState<CycleMarkerPosition[]>([]);

  // TX拖动状态
  const [draggingOperatorId, setDraggingOperatorId] = React.useState<string | null>(null);
  // 拖动时的本地频率覆盖（乐观更新 + 冷却期保护）
  const [localFrequencyOverride, setLocalFrequencyOverride] =
    React.useState<{ operatorId: string; frequency: number } | null>(null);
  const [cooldownOperatorId, setCooldownOperatorId] = React.useState<string | null>(null);
  const dragDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const latestDragFrequencyRef = useRef<{ operatorId: string; frequency: number } | null>(null);
  const [draggingBandOverlayId, setDraggingBandOverlayId] = React.useState<string | null>(null);
  const [localBandOverlayOverride, setLocalBandOverlayOverride] =
    React.useState<{ id: string; frequency: number } | null>(null);
  const [cooldownBandOverlayId, setCooldownBandOverlayId] = React.useState<string | null>(null);
  const latestBandOverlayFrequencyRef = useRef<{ id: string; frequency: number } | null>(null);
  const [draggingFrequencyBandOverlay, setDraggingFrequencyBandOverlay] = React.useState<{
    id: string;
    dragTarget: 'center' | 'start' | 'end';
    startX: number;
    startCenterFrequency: number;
    startWidthHz: number;
    hzPerPixel: number;
  } | null>(null);
  const [localFrequencyBandOverride, setLocalFrequencyBandOverride] =
    React.useState<{ id: string } & FrequencyBandOverlayChange | null>(null);
  const [hoveredFrequencyBandEdgeId, setHoveredFrequencyBandEdgeId] = React.useState<string | null>(null);
  const latestFrequencyBandChangeRef = useRef<{ id: string } & FrequencyBandOverlayChange | null>(null);
  const [frequencyGestureDragState, setFrequencyGestureDragState] = React.useState<{
    startX: number;
    startFrequency: number;
    hzPerPixel: number;
    hasExceededThreshold: boolean;
  } | null>(null);
  const [localGestureFrequencyOverride, setLocalGestureFrequencyOverride] =
    React.useState<WaterfallLocalGestureFrequencyOverride | null>(null);
  const gestureDragDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const gestureCooldownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const latestGestureFrequencyRef = useRef<number | null>(null);
  const lastCommittedGestureFrequencyRef = useRef<number | null>(null);
  const lastGestureCommitAtRef = useRef<number | null>(null);
  const horizontalWheelStateRef = useRef<{
    startFrequency: number;
    accumulatedDeltaXPx: number;
    hzPerPixel: number;
    active: boolean;
  } | null>(null);
  const horizontalWheelCommitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const horizontalWheelIdleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const latestHorizontalWheelFrequencyRef = useRef<number | null>(null);
  const lastCommittedHorizontalWheelFrequencyRef = useRef<number | null>(null);
  const lastHorizontalWheelCommitAtRef = useRef<number | null>(null);
  const horizontalWheelRuntimeRef = useRef<HorizontalWheelFrequencyRuntime | null>(null);

  // RX Popover hover状态
  const [hoveredRxMarkerId, setHoveredRxMarkerId] = React.useState<string | null>(null);
  const [hoveredPresetMarkerId, setHoveredPresetMarkerId] = React.useState<string | null>(null);

  // TX Popover hover状态（多操作员时使用）
  const [hoveredTxOperatorId, setHoveredTxOperatorId] = React.useState<string | null>(null);

  // 性能优化：缓存相关引用
  const positionBufferRef = useRef<WebGLBuffer | null>(null);
  const texCoordBufferRef = useRef<WebGLBuffer | null>(null);
  const colorMapTextureRef = useRef<WebGLTexture | null>(null);
  const lastDataLengthRef = useRef<number>(0);
  const rangeUpdateCounterRef = useRef<number>(0);
  const cachedRangeRef = useRef<{min: number, max: number} | null>(null);
  const scratchRowRef = useRef<Uint8Array | null>(null);
  const heightRef = useRef(height);
  useEffect(() => { heightRef.current = height; }, [height]);
  const minDbRef = useRef(minDb);
  const maxDbRef = useRef(maxDb);
  useEffect(() => { minDbRef.current = minDb; }, [minDb]);
  useEffect(() => { maxDbRef.current = maxDb; }, [maxDb]);
  const actualRangeRef = useRef<{min: number, max: number} | null>(null);
  const colorMapRef = useRef<Uint8Array>(buildSpectrumThemeColorLut(DEFAULT_SPECTRUM_THEME_ID));
  const themeCurveRef = useRef(getSafeSpectrumThemeCurve(DEFAULT_SPECTRUM_THEME_ID));
  // TX/RX 自动范围分离：多段冻结机制
  // 每个冻结段记录一段历史行的行数和对应的范围
  const frozenSegmentsRef = useRef<Array<{ rowCount: number; range: { min: number; max: number } }>>([]);
  const activeRowCountRef = useRef<number>(0); // 当前状态已累积的行数
  const prevTransmittingRef = useRef<boolean | undefined>(undefined);
  const displayRowsRef = useRef<ArrayLike<number>[]>([]);
  const displayRowTimestampsRef = useRef<number[]>([]);
  const headRowRef = useRef<number>(0);
  const rowCountRef = useRef<number>(0);
  // 平滑滚动相关
  const headRowLocationRef = useRef<WebGLUniformLocation | null>(null);
  const textureHeightLocationRef = useRef<WebGLUniformLocation | null>(null);
  const scrollRowsLocationRef = useRef<WebGLUniformLocation | null>(null);
  const resolutionLocationRef = useRef<WebGLUniformLocation | null>(null);
  const minDbLocationRef = useRef<WebGLUniformLocation | null>(null);
  const maxDbLocationRef = useRef<WebGLUniformLocation | null>(null);
  const axisTransitionActiveLocationRef = useRef<WebGLUniformLocation | null>(null);
  const axisTransitionProgressLocationRef = useRef<WebGLUniformLocation | null>(null);
  const currentAxisLocationRef = useRef<WebGLUniformLocation | null>(null);
  const transitionAxisLocationRef = useRef<WebGLUniformLocation | null>(null);
  const transitionHeadRowLocationRef = useRef<WebGLUniformLocation | null>(null);
  const transitionTextureHeightLocationRef = useRef<WebGLUniformLocation | null>(null);
  const verticalScrollAnimRef = useRef<number>();
  const axisTransitionAnimRef = useRef<number>();
  const lastDataTimeRef = useRef(0);
  const frameIntervalRef = useRef(100);
  const lastAnimatedFrameTokenRef = useRef<string | number | null>(null);
  const currentAxisRef = useRef<SpectrumAxis | null>(null);
  const textureHeightRef = useRef<number>(Math.max(totalRows ?? 0, 1));
  const renderRef = useRef<() => void>(() => {});
  const handleResizeRef = useRef<() => void>(() => {});
  const rebuildTextureRef = useRef<(rows: ArrayLike<number>[], axis: SpectrumAxis | null) => void>(() => {});
  const processRenderBatchRef = useRef<(batch: SpectrumRenderBatch | null) => void>(() => {});
  const axis = viewState.axis ?? markerAxis;

  const applyCycleMarkerScrollOffset = useCallback((offsetRows: number) => {
    const markerLayer = cycleMarkerLayerRef.current;
    if (!markerLayer) {
      return;
    }

    const visibleRows = Math.max(textureHeightRef.current, displayRowTimestampsRef.current.length, 1);
    const offsetPercent = (offsetRows / visibleRows) * 100;
    markerLayer.style.transform = offsetPercent === 0 ? '' : `translateY(-${offsetPercent}%)`;
  }, []);

  const refreshCycleMarkers = useCallback((rowTimestamps: number[] = displayRowTimestampsRef.current) => {
    const visibleRows = Math.max(textureHeightRef.current, rowTimestamps.length, 1);
    const nextMarkers = buildCycleMarkerPositions(rowTimestamps, showCycleMarkers ? cycleSlotMs : null, visibleRows);
    setCycleMarkers(currentMarkers => {
      if (
        currentMarkers.length === nextMarkers.length
        && currentMarkers.every((marker, index) => {
          const nextMarker = nextMarkers[index];
          return nextMarker
            && marker.timestamp === nextMarker.timestamp
            && Math.abs(marker.topPercent - nextMarker.topPercent) < 0.001;
        })
      ) {
        return currentMarkers;
      }
      return nextMarkers;
    });
  }, [cycleSlotMs, showCycleMarkers]);

  const resetAutoRangeState = useCallback(() => {
    rangeUpdateCounterRef.current = 0;
    cachedRangeRef.current = null;
    actualRangeRef.current = null;
    frozenSegmentsRef.current = [];
    activeRowCountRef.current = 0;
    setActualRange(null);
    onActualRangeChange?.(null);
  }, [onActualRangeChange]);

  // 优化后的数据范围计算 - 使用采样和缓存
  // 当存在冻结段时，只从活跃行（当前状态）采样
  const calculateDataRange = useCallback((spectrumData: ArrayLike<number>[]) => {
    const calculateInternal = () => {
    if (spectrumData.length === 0) return { min: minDb, max: maxDb };

    // 每N帧更新一次范围，减少计算频率
    rangeUpdateCounterRef.current++;
    if (rangeUpdateCounterRef.current % autoRangeConfig.updateInterval !== 0 && cachedRangeRef.current) {
      return cachedRangeRef.current;
    }

    let min = Infinity;
    let max = -Infinity;
    const values: number[] = [];

    // 确定采样范围：如果存在冻结段且活跃行数足够，只采样活跃行
    const activeRows = activeRowCountRef.current;
    const sampleEndRow = (frozenSegmentsRef.current.length > 0 && activeRows > 0 && activeRows < spectrumData.length)
      ? activeRows
      : spectrumData.length;

    // 采样策略：对于大数据集，只采样部分数据
    const sampleRate = sampleEndRow > 50 ? 2 : 1;
    const maxSamples = 5000; // 最多采样5000个点
    let sampleCount = 0;

    for (let i = 0; i < sampleEndRow && sampleCount < maxSamples; i += sampleRate) {
      const row = spectrumData[i];
      const rowSampleRate = row.length > 100 ? Math.ceil(row.length / 100) : 1;

      for (let j = 0; j < row.length; j += rowSampleRate) {
        const value = row[j];
        if (isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
          values.push(value);
          sampleCount++;
        }
      }
    }

    // 如果没有有效数据，使用默认范围
    if (!isFinite(min) || !isFinite(max)) {
      return { min: minDb, max: maxDb };
    }

    // 快速百分位数计算（使用部分排序）
    values.sort((a, b) => a - b);
    const pMin = values[Math.floor(values.length * (autoRangeConfig.minPercentile / 100))];
    const p25 = values[Math.floor(values.length * 0.25)];
    const median = values[Math.floor(values.length * 0.5)];
    const p75 = values[Math.floor(values.length * 0.75)];
    const pMax = values[Math.floor(values.length * (autoRangeConfig.maxPercentile / 100))];

    // 使用优化的动态范围策略
    const medianRange = p75 - p25;
    const dynamicMin = Math.max(pMin, median - medianRange);
    const dynamicMax = Math.max(pMax, median + medianRange * autoRangeConfig.rangeExpansionFactor);

    const result = {
      min: dynamicMin,
      max: dynamicMax
    };

    // 缓存结果
    cachedRangeRef.current = result;

    return result;
    };

    return calculateInternal();
  }, [minDb, maxDb, autoRangeConfig]);

  const colorMap = useMemo(() => buildSpectrumThemeColorLut(themeId), [themeId]);
  const themeCurve = useMemo(() => getSafeSpectrumThemeCurve(themeId), [themeId]);
  colorMapRef.current = colorMap;
  themeCurveRef.current = themeCurve;

  // 顶点着色器源码
  const vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    
    uniform vec2 u_resolution;
    
    varying vec2 v_texCoord;
    
    void main() {
      vec2 clipSpace = ((a_position / u_resolution) * 2.0) - 1.0;
      gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
      v_texCoord = a_texCoord;
    }
  `;

  // 片段着色器源码
  const fragmentShaderSource = `
    precision mediump float;

    uniform sampler2D u_texture;
    uniform sampler2D u_transitionTexture;
    uniform sampler2D u_colorMap;
    uniform float u_minDb;
    uniform float u_maxDb;
    uniform bool u_useFloatTexture;
    uniform float u_headRow;
    uniform float u_textureHeight;
    uniform float u_scrollRows;
    uniform bool u_axisTransitionActive;
    uniform float u_axisTransitionProgress;
    uniform vec2 u_currentAxis;
    uniform vec2 u_transitionAxis;
    uniform float u_transitionHeadRow;
    uniform float u_transitionTextureHeight;
    uniform float u_themeGamma;
    uniform float u_themeContrast;
    uniform float u_themeBias;

    varying vec2 v_texCoord;

    float sampleWaterfallTexture(
      sampler2D sourceTexture,
      float xCoord,
      float headRow,
      float textureHeight,
      float scrollRows
    ) {
      if (xCoord < 0.0 || xCoord > 1.0) {
        return 0.0;
      }

      float safeTextureHeight = max(textureHeight, 1.0);
      // Map the vertical edge to the last texel row instead of wrapping back to the top.
      float rowSpan = max(safeTextureHeight - 1.0, 0.0);
      float sourceRow = mod(headRow + v_texCoord.y * rowSpan + scrollRows, safeTextureHeight);
      float sourceY = (sourceRow + 0.5) / safeTextureHeight;
      return texture2D(sourceTexture, vec2(clamp(xCoord, 0.0, 1.0), sourceY)).r;
    }

    void main() {
      float currentX = v_texCoord.x;
      float transitionX = v_texCoord.x;

      if (u_axisTransitionActive) {
        float progress = clamp(u_axisTransitionProgress, 0.0, 1.0);
        vec2 visualAxis = mix(u_transitionAxis, u_currentAxis, progress);
        float visualFrequency = mix(visualAxis.x, visualAxis.y, v_texCoord.x);
        float currentSpan = max(u_currentAxis.y - u_currentAxis.x, 1.0);
        float transitionSpan = max(u_transitionAxis.y - u_transitionAxis.x, 1.0);
        currentX = (visualFrequency - u_currentAxis.x) / currentSpan;
        transitionX = (visualFrequency - u_transitionAxis.x) / transitionSpan;
      }

      float value = sampleWaterfallTexture(
        u_texture,
        currentX,
        u_headRow,
        u_textureHeight,
        u_scrollRows
      );

      if (u_axisTransitionActive) {
        float previousValue = sampleWaterfallTexture(
          u_transitionTexture,
          transitionX,
          u_transitionHeadRow,
          u_transitionTextureHeight,
          0.0
        );
        value = mix(previousValue, value, clamp(u_axisTransitionProgress, 0.0, 1.0));
      }

      float normalized;
      
      if (u_useFloatTexture) {
        // 对于Float纹理，直接归一化dB值
        float range = u_maxDb - u_minDb;
        if (range > 0.0) {
          normalized = (value - u_minDb) / range;
        } else {
          normalized = 0.5;
        }
      } else {
        // 对于UNSIGNED_BYTE纹理，值已经归一化了
        normalized = value;
      }
      
      // 确保值在有效范围内
      normalized = clamp(normalized, 0.0, 1.0);
      
      // Apply the selected theme tone curve without touching the source spectrum data.
      normalized = clamp((normalized - 0.5) * max(u_themeContrast, 0.01) + 0.5 + u_themeBias, 0.0, 1.0);
      normalized = pow(normalized, max(u_themeGamma, 0.01));
      
      vec4 color = texture2D(u_colorMap, vec2(normalized, 0.5));
      gl_FragColor = color;
    }
  `;

  // 创建着色器
  const createShader = useCallback((gl: WebGLRenderingContext, type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      logger.error('Shader compilation error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }, []);

  // 创建程序
  const createProgram = useCallback((gl: WebGLRenderingContext) => {
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    if (!vertexShader || !fragmentShader) return null;

    const program = gl.createProgram();
    if (!program) return null;

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      logger.error('Program linking error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }

    return program;
  }, [createShader]);

  const uploadColorMapTexture = useCallback((
    gl: WebGLRenderingContext,
    texture: WebGLTexture,
    colorMapData: Uint8Array
  ) => {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colorMapData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }, []);

  const applyThemeCurveUniforms = useCallback((
    gl: WebGLRenderingContext,
    program: WebGLProgram,
    curve: { gamma: number; contrast: number; bias: number }
  ) => {
    gl.useProgram(program);
    gl.uniform1f(gl.getUniformLocation(program, 'u_themeGamma'), curve.gamma);
    gl.uniform1f(gl.getUniformLocation(program, 'u_themeContrast'), curve.contrast);
    gl.uniform1f(gl.getUniformLocation(program, 'u_themeBias'), curve.bias);
  }, []);

  // 初始化WebGL
  const initWebGL = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return false;

    try {
      const gl = canvas.getContext('webgl', {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      }) as WebGLRenderingContext || canvas.getContext('experimental-webgl') as WebGLRenderingContext;
      
      if (!gl) {
        setWebglSupported(false);
        setError('NOT_SUPPORTED');
        return false;
      }

      glRef.current = gl;

      // 创建程序
      const program = createProgram(gl);
      if (!program) return false;

      programRef.current = program;
      gl.useProgram(program);

      // 创建并缓存颜色映射纹理
      const colorMapTexture = gl.createTexture();
      colorMapTextureRef.current = colorMapTexture;
      uploadColorMapTexture(gl, colorMapTexture, colorMapRef.current);
      applyThemeCurveUniforms(gl, program, themeCurveRef.current);

      // 创建数据纹理
      const dataTexture = gl.createTexture();
      textureRef.current = dataTexture;
      const transitionTexture = gl.createTexture();
      transitionTextureRef.current = transitionTexture;
      if (transitionTexture) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, transitionTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }

      // 设置顶点数据
      const positions = new Float32Array([
        0, 0,
        canvas.width, 0,
        0, canvas.height,
        canvas.width, canvas.height,
      ]);

      const texCoords = new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 1,
      ]);

      // 创建并缓存位置缓冲区
      const positionBuffer = gl.createBuffer();
      positionBufferRef.current = positionBuffer;
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      // 创建并缓存纹理坐标缓冲区
      const texCoordBuffer = gl.createBuffer();
      texCoordBufferRef.current = texCoordBuffer;
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

      const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
      gl.enableVertexAttribArray(texCoordLocation);
      gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

      // 设置uniform
      resolutionLocationRef.current = gl.getUniformLocation(program, 'u_resolution');
      gl.uniform2f(resolutionLocationRef.current, canvas.width, canvas.height);

      minDbLocationRef.current = gl.getUniformLocation(program, 'u_minDb');
      gl.uniform1f(minDbLocationRef.current, minDbRef.current);

      maxDbLocationRef.current = gl.getUniformLocation(program, 'u_maxDb');
      gl.uniform1f(maxDbLocationRef.current, maxDbRef.current);

      const useFloatTextureLocation = gl.getUniformLocation(program, 'u_useFloatTexture');
      gl.uniform1i(useFloatTextureLocation, 0);

      headRowLocationRef.current = gl.getUniformLocation(program, 'u_headRow');
      textureHeightLocationRef.current = gl.getUniformLocation(program, 'u_textureHeight');
      scrollRowsLocationRef.current = gl.getUniformLocation(program, 'u_scrollRows');
      axisTransitionActiveLocationRef.current = gl.getUniformLocation(program, 'u_axisTransitionActive');
      axisTransitionProgressLocationRef.current = gl.getUniformLocation(program, 'u_axisTransitionProgress');
      currentAxisLocationRef.current = gl.getUniformLocation(program, 'u_currentAxis');
      transitionAxisLocationRef.current = gl.getUniformLocation(program, 'u_transitionAxis');
      transitionHeadRowLocationRef.current = gl.getUniformLocation(program, 'u_transitionHeadRow');
      transitionTextureHeightLocationRef.current = gl.getUniformLocation(program, 'u_transitionTextureHeight');
      gl.uniform1f(headRowLocationRef.current, 0.0);
      gl.uniform1f(textureHeightLocationRef.current, textureHeightRef.current);
      gl.uniform1f(scrollRowsLocationRef.current, 0.0);
      gl.uniform1i(axisTransitionActiveLocationRef.current, 0);
      gl.uniform1f(axisTransitionProgressLocationRef.current, 1.0);
      gl.uniform2f(currentAxisLocationRef.current, 0.0, 1.0);
      gl.uniform2f(transitionAxisLocationRef.current, 0.0, 1.0);
      gl.uniform1f(transitionHeadRowLocationRef.current, 0.0);
      gl.uniform1f(transitionTextureHeightLocationRef.current, 1.0);

      // 设置纹理单元
      const textureLocation = gl.getUniformLocation(program, 'u_texture');
      gl.uniform1i(textureLocation, 0);

      const colorMapLocation = gl.getUniformLocation(program, 'u_colorMap');
      gl.uniform1i(colorMapLocation, 1);

      const transitionTextureLocation = gl.getUniformLocation(program, 'u_transitionTexture');
      gl.uniform1i(transitionTextureLocation, 2);

      // 激活纹理单元
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, colorMapTexture);

      return true;
    } catch (err) {
      setWebglSupported(false);
      setError(err instanceof Error ? err.message : 'INIT_FAILED');
      return false;
    }
  }, [applyThemeCurveUniforms, createProgram, uploadColorMapTexture]);

  // 渲染
  const render = useCallback(() => {
    const gl = glRef.current;
    const canvas = canvasRef.current;
    
    if (!gl || !canvas) return;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, []);

  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  useEffect(() => {
    const gl = glRef.current;
    const program = programRef.current;
    const colorMapTexture = colorMapTextureRef.current;
    if (!gl || !program || !colorMapTexture || gl.isContextLost()) {
      return;
    }

    uploadColorMapTexture(gl, colorMapTexture, colorMap);
    applyThemeCurveUniforms(gl, program, themeCurve);
    render();
  }, [applyThemeCurveUniforms, colorMap, render, themeCurve, uploadColorMapTexture]);

  const updateViewState = useCallback((nextAxis: SpectrumAxis | null, hasData: boolean) => {
    currentAxisRef.current = nextAxis;
    setViewState(current => {
      if (current.hasData === hasData && areAxesEqual(current.axis, nextAxis)) {
        return current;
      }
      return {
        axis: nextAxis,
        hasData,
      };
    });
  }, []);

  const updateActualRangeState = useCallback((range: { min: number; max: number } | null) => {
    if (range === null) {
      if (actualRangeRef.current !== null) {
        actualRangeRef.current = null;
        setActualRange(null);
        onActualRangeChange?.(null);
      }
      return;
    }

    if (
      actualRangeRef.current
      && Math.abs(actualRangeRef.current.min - range.min) <= 0.5
      && Math.abs(actualRangeRef.current.max - range.max) <= 0.5
    ) {
      return;
    }

    actualRangeRef.current = range;
    setActualRange(range);
    onActualRangeChange?.(range);
  }, [onActualRangeChange]);

  const writeNormalizedRow = useCallback((
    target: Uint8Array,
    rowIndex: number,
    row: ArrayLike<number>,
    width: number,
    rangeMin: number,
    rangeScale: number
  ) => {
    const start = rowIndex * width;
    for (let x = 0; x < width; x += 1) {
      const normalizedValue = (row[x] - rangeMin) * rangeScale;
      target[start + x] = Math.max(0, Math.min(255, Math.floor(normalizedValue)));
    }
  }, []);

  const updateTextureMetadata = useCallback((textureHeight: number, headRow: number) => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost()) {
      return;
    }

    textureHeightRef.current = textureHeight;
    headRowRef.current = headRow;
    gl.useProgram(program);
    if (headRowLocationRef.current) {
      gl.uniform1f(headRowLocationRef.current, headRow);
    }
    if (textureHeightLocationRef.current) {
      gl.uniform1f(textureHeightLocationRef.current, textureHeight);
    }
  }, []);

  const updateCurrentAxisUniform = useCallback((nextAxis: SpectrumAxis | null) => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost() || !currentAxisLocationRef.current || !nextAxis) {
      return;
    }

    gl.useProgram(program);
    gl.uniform2f(currentAxisLocationRef.current, nextAxis.minHz, nextAxis.maxHz);
  }, []);

  const stopAxisTransition = useCallback((shouldRender = false) => {
    if (axisTransitionAnimRef.current) {
      cancelAnimationFrame(axisTransitionAnimRef.current);
      axisTransitionAnimRef.current = undefined;
    }

    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost()) {
      return;
    }

    gl.useProgram(program);
    if (axisTransitionActiveLocationRef.current) {
      gl.uniform1i(axisTransitionActiveLocationRef.current, 0);
    }
    if (axisTransitionProgressLocationRef.current) {
      gl.uniform1f(axisTransitionProgressLocationRef.current, 1);
    }
    if (shouldRender) {
      render();
    }
  }, [render]);

  const prepareAxisTransitionTexture = useCallback((fromAxis: SpectrumAxis, toAxis: SpectrumAxis): boolean => {
    const gl = glRef.current;
    const program = programRef.current;
    const currentTexture = textureRef.current;
    const transitionTexture = transitionTextureRef.current;
    const previousTextureHeight = textureHeightRef.current;

    if (
      !gl
      || !program
      || !currentTexture
      || !transitionTexture
      || gl.isContextLost()
      || previousTextureHeight <= 0
      || fromAxis.binCount <= 0
      || toAxis.binCount <= 0
    ) {
      return false;
    }

    textureRef.current = transitionTexture;
    transitionTextureRef.current = currentTexture;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, transitionTexture);

    gl.useProgram(program);
    if (transitionAxisLocationRef.current) {
      gl.uniform2f(transitionAxisLocationRef.current, fromAxis.minHz, fromAxis.maxHz);
    }
    if (transitionHeadRowLocationRef.current) {
      gl.uniform1f(transitionHeadRowLocationRef.current, headRowRef.current);
    }
    if (transitionTextureHeightLocationRef.current) {
      gl.uniform1f(transitionTextureHeightLocationRef.current, previousTextureHeight);
    }
    if (currentAxisLocationRef.current) {
      gl.uniform2f(currentAxisLocationRef.current, toAxis.minHz, toAxis.maxHz);
    }
    return true;
  }, []);

  const startAxisTransition = useCallback((fromAxis: SpectrumAxis | null, toAxis: SpectrumAxis | null) => {
    stopAxisTransition(false);
    updateCurrentAxisUniform(toAxis);

    if (!fromAxis || !toAxis || areAxesEqual(fromAxis, toAxis)) {
      stopAxisTransition(false);
      return;
    }

    const duration = calculateSpectrumAxisTransitionDuration(fromAxis, toAxis);
    if (duration <= 0 || !prepareAxisTransitionTexture(fromAxis, toAxis)) {
      stopAxisTransition(false);
      return;
    }

    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost()) {
      return;
    }

    const startedAt = performance.now();
    gl.useProgram(program);
    if (axisTransitionActiveLocationRef.current) {
      gl.uniform1i(axisTransitionActiveLocationRef.current, 1);
    }
    if (axisTransitionProgressLocationRef.current) {
      gl.uniform1f(axisTransitionProgressLocationRef.current, 0);
    }

    const animate = () => {
      const currentGl = glRef.current;
      const currentProgram = programRef.current;
      if (!currentGl || !currentProgram || currentGl.isContextLost()) {
        axisTransitionAnimRef.current = undefined;
        return;
      }

      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      const easedProgress = easeSpectrumAxisTransition(progress);
      currentGl.useProgram(currentProgram);
      if (axisTransitionProgressLocationRef.current) {
        currentGl.uniform1f(axisTransitionProgressLocationRef.current, easedProgress);
      }
      render();

      if (progress < 1) {
        axisTransitionAnimRef.current = requestAnimationFrame(animate);
        return;
      }

      axisTransitionAnimRef.current = undefined;
      if (axisTransitionActiveLocationRef.current) {
        currentGl.uniform1i(axisTransitionActiveLocationRef.current, 0);
      }
      if (axisTransitionProgressLocationRef.current) {
        currentGl.uniform1f(axisTransitionProgressLocationRef.current, 1);
      }
      render();
    };

    axisTransitionAnimRef.current = requestAnimationFrame(animate);
  }, [prepareAxisTransitionTexture, render, stopAxisTransition, updateCurrentAxisUniform]);

  const buildSegments = useCallback((actualHeight: number, currentMin: number, currentMax: number) => {
    const segments: Array<{ rowCount: number; rangeMin: number; rangeScale: number }> = [];
    const frozen = frozenSegmentsRef.current;
    const activeRows = Math.min(activeRowCountRef.current, actualHeight);
    const activeRange = currentMax - currentMin;

    segments.push({
      rowCount: activeRows,
      rangeMin: currentMin,
      rangeScale: activeRange > 0 ? 255 / activeRange : 1,
    });

    if (autoRange) {
      for (const segment of frozen) {
        const frozenRange = segment.range.max - segment.range.min;
        segments.push({
          rowCount: segment.rowCount,
          rangeMin: segment.range.min,
          rangeScale: frozenRange > 0 ? 255 / frozenRange : 1,
        });
      }
    }

    if (frozen.length > 0) {
      const totalFrozenRows = frozen.reduce((sum, segment) => sum + segment.rowCount, 0);
      if (activeRows + totalFrozenRows > actualHeight) {
        let remaining = actualHeight - activeRows;
        let keepCount = 0;
        for (const segment of frozen) {
          if (remaining <= 0) {
            break;
          }
          remaining -= segment.rowCount;
          keepCount += 1;
        }
        if (keepCount < frozen.length) {
          frozenSegmentsRef.current = frozen.slice(0, keepCount);
        }
      }
    }

    return segments;
  }, [autoRange]);

  const rebuildTexture = useCallback((spectrumData: ArrayLike<number>[], nextAxis: SpectrumAxis | null) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    const width = nextAxis?.binCount ?? spectrumData[0]?.length ?? 0;

    if (!gl || !texture || !program || gl.isContextLost() || width <= 0) {
      return;
    }
    updateCurrentAxisUniform(nextAxis);

    const actualHeight = spectrumData.length;
    const textureHeight = totalRows ? Math.max(actualHeight, totalRows) : Math.max(actualHeight, 1);
    const dataSize = width * textureHeight;
    const textureData = createWaterfallUploadBuffer(width, textureHeight);

    let currentMin = minDb;
    let currentMax = maxDb;

    if (autoRange && actualHeight > 0) {
      const range = calculateDataRange(spectrumData);
      currentMin = range.min;
      currentMax = range.max;
      updateActualRangeState(range);
    } else if (!autoRange) {
      updateActualRangeState(null);
    }

    const segments = buildSegments(actualHeight, currentMin, currentMax);
    const fallbackScale = currentMax > currentMin ? 255 / (currentMax - currentMin) : 1;

    let rowOffset = 0;
    for (const segment of segments) {
      const segmentEnd = Math.min(rowOffset + segment.rowCount, actualHeight);
      for (let y = rowOffset; y < segmentEnd; y += 1) {
        writeNormalizedRow(textureData, y, spectrumData[y], width, segment.rangeMin, segment.rangeScale);
      }
      rowOffset = segmentEnd;
      if (rowOffset >= actualHeight) {
        break;
      }
    }

    for (let y = rowOffset; y < actualHeight; y += 1) {
      writeNormalizedRow(textureData, y, spectrumData[y], width, currentMin, fallbackScale);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, textureHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, textureData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    lastDataLengthRef.current = dataSize;

    rowCountRef.current = actualHeight;
    updateTextureMetadata(textureHeight, 0);
  }, [
    autoRange,
    buildSegments,
    calculateDataRange,
    minDb,
    maxDb,
    totalRows,
    updateCurrentAxisUniform,
    updateActualRangeState,
    updateTextureMetadata,
    writeNormalizedRow,
  ]);

  useEffect(() => {
    rebuildTextureRef.current = rebuildTexture;
  }, [rebuildTexture]);

  const releaseTextureStorage = useCallback((shouldRender = true) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const transitionTexture = transitionTextureRef.current;
    const program = programRef.current;
    releaseWaterfallTextureMemoryRefs({
      scratchRowRef,
      lastDataLengthRef,
      textureHeightRef,
      rowCountRef,
      headRowRef,
    });

    if (!gl || !texture || gl.isContextLost()) {
      return;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1));
    if (transitionTexture) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, transitionTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1));
    }

    if (program && scrollRowsLocationRef.current) {
      gl.useProgram(program);
      gl.uniform1f(scrollRowsLocationRef.current, 0);
    }
    if (program && axisTransitionActiveLocationRef.current) {
      gl.useProgram(program);
      gl.uniform1i(axisTransitionActiveLocationRef.current, 0);
    }
    if (program && axisTransitionProgressLocationRef.current) {
      gl.useProgram(program);
      gl.uniform1f(axisTransitionProgressLocationRef.current, 1);
    }
    if (program && headRowLocationRef.current) {
      gl.useProgram(program);
      gl.uniform1f(headRowLocationRef.current, 0);
    }
    if (program && textureHeightLocationRef.current) {
      gl.useProgram(program);
      gl.uniform1f(textureHeightLocationRef.current, 1);
    }
    if (shouldRender) {
      render();
    }
  }, [render]);

  const appendRowsToTexture = useCallback((rowsToAppend: ArrayLike<number>[], nextAxis: SpectrumAxis | null) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    const width = nextAxis?.binCount ?? rowsToAppend[rowsToAppend.length - 1]?.length ?? 0;

    if (!gl || !texture || !program || gl.isContextLost() || width <= 0 || rowsToAppend.length === 0) {
      return;
    }
    updateCurrentAxisUniform(nextAxis);

    const spectrumData = displayRowsRef.current;
    const actualHeight = spectrumData.length;
    const previousTextureHeight = textureHeightRef.current;
    const textureHeight = totalRows ? Math.max(actualHeight, totalRows) : Math.max(actualHeight, 1);

    let txModeChanged = false;
    if (autoRange && isTransmitting !== prevTransmittingRef.current && prevTransmittingRef.current !== undefined) {
      if (cachedRangeRef.current && activeRowCountRef.current > 0) {
        frozenSegmentsRef.current.unshift({
          rowCount: activeRowCountRef.current,
          range: { ...cachedRangeRef.current },
        });
      }
      cachedRangeRef.current = null;
      rangeUpdateCounterRef.current = 0;
      activeRowCountRef.current = 0;
      txModeChanged = true;
    }
    prevTransmittingRef.current = isTransmitting;
    activeRowCountRef.current = Math.min(actualHeight, activeRowCountRef.current + rowsToAppend.length);

    let currentMin = minDb;
    let currentMax = maxDb;
    let rangeChanged = false;

    if (autoRange) {
      const range = calculateDataRange(spectrumData);
      currentMin = range.min;
      currentMax = range.max;
      rangeChanged = !actualRangeRef.current
        || Math.abs(actualRangeRef.current.min - currentMin) > 0.5
        || Math.abs(actualRangeRef.current.max - currentMax) > 0.5;
      updateActualRangeState(range);
    } else {
      updateActualRangeState(null);
    }

    if (txModeChanged || rangeChanged || previousTextureHeight !== textureHeight || rowCountRef.current === 0) {
      rebuildTexture(spectrumData, nextAxis);
      return;
    }

    const rangeScale = currentMax > currentMin ? 255 / (currentMax - currentMin) : 1;
    let headRow = headRowRef.current;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    for (const row of rowsToAppend) {
      headRow = (headRow - 1 + textureHeight) % textureHeight;
      const scratchRow = ensureWaterfallScratchRow(scratchRowRef.current, width);
      scratchRowRef.current = scratchRow;
      writeNormalizedRow(scratchRow, 0, row, width, currentMin, rangeScale);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        headRow,
        width,
        1,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        scratchRow
      );
    }

    rowCountRef.current = Math.min(textureHeight, rowCountRef.current + rowsToAppend.length);
    updateTextureMetadata(textureHeight, headRow);
  }, [
    autoRange,
    calculateDataRange,
    isTransmitting,
    minDb,
    maxDb,
    rebuildTexture,
    totalRows,
    updateCurrentAxisUniform,
    updateActualRangeState,
    updateTextureMetadata,
    writeNormalizedRow,
  ]);

  // 处理canvas尺寸变化
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // 获取容器的实际尺寸
    const containerRect = container.getBoundingClientRect();
    const pixelRatio = getWaterfallCanvasPixelRatio(window.devicePixelRatio);

    // 使用容器的宽度和传入的height（通过 ref 读取，避免 handleResize 随 height 变化重建）
    const canvasWidth = containerRect.width;
    const canvasHeight = heightRef.current;
    const nextCanvasWidth = Math.max(1, Math.round(canvasWidth * pixelRatio));
    const nextCanvasHeight = Math.max(1, Math.round(canvasHeight * pixelRatio));

    // 防止零尺寸导致 WebGL 错误（布局切换时容器可能瞬间为 0）
    if (canvasWidth <= 0 || canvasHeight <= 0) return;
    
    // 只在尺寸真正改变时更新
    if (canvas.width === nextCanvasWidth && 
        canvas.height === nextCanvasHeight) {
      return;
    }
    
    canvas.width = nextCanvasWidth;
    canvas.height = nextCanvasHeight;
    
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    const gl = glRef.current;
    const program = programRef.current;
    
    if (gl && program && !gl.isContextLost()) {
      gl.useProgram(program);

      // 更新viewport
      gl.viewport(0, 0, canvas.width, canvas.height);
      
      // 更新分辨率uniform
      if (resolutionLocationRef.current) {
        gl.uniform2f(resolutionLocationRef.current, canvas.width, canvas.height);
      }
      
      // 重用已有的缓冲区，只更新数据
      const positions = new Float32Array([
        0, 0,
        canvas.width, 0,
        0, canvas.height,
        canvas.width, canvas.height,
      ]);

      if (positionBufferRef.current) {
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBufferRef.current);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        const positionLocation = gl.getAttribLocation(program, 'a_position');
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      }
      
      // 立即重新渲染
      render();
    }
  }, [render]);

  useEffect(() => {
    handleResizeRef.current = handleResize;
  }, [handleResize]);

  // 初始化（使用 useLayoutEffect 确保 WebGL 在浏览器绘制前完成初始化，避免黑帧闪烁）
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // WebGL context loss 处理
    const handleContextLost = (e: Event) => {
      e.preventDefault();
      logger.warn('WebGL context lost');
      if (verticalScrollAnimRef.current) cancelAnimationFrame(verticalScrollAnimRef.current);
      if (axisTransitionAnimRef.current) cancelAnimationFrame(axisTransitionAnimRef.current);
    };
    const handleContextRestored = () => {
      logger.info('WebGL context restored, reinitializing');
      if (initWebGL()) {
        handleResizeRef.current();
        // 恢复后重新上传已有的纹理数据，避免显示黑屏
        if (displayRowsRef.current.length > 0) {
          rebuildTextureRef.current(displayRowsRef.current, currentAxisRef.current);
          renderRef.current();
        }
      }
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    if (initWebGL()) {
      handleResizeRef.current();
    }

    const resizeObserver = new ResizeObserver((_entries) => {
      // 防抖处理，避免频繁调用
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      animationRef.current = requestAnimationFrame(() => {
        handleResizeRef.current();
      });
    });

    // 监听组件容器的尺寸变化
    const container = containerRef.current;
    if (container) {
      resizeObserver.observe(container);
    }

    return () => {
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      resizeObserver.disconnect();
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (verticalScrollAnimRef.current) {
        cancelAnimationFrame(verticalScrollAnimRef.current);
      }
      if (axisTransitionAnimRef.current) {
        cancelAnimationFrame(axisTransitionAnimRef.current);
      }
      // 释放 WebGL 资源，防止泄漏
      const gl = glRef.current;
      if (gl) {
        releaseTextureStorage(false);
        if (programRef.current) { gl.deleteProgram(programRef.current); programRef.current = null; }
        if (textureRef.current) { gl.deleteTexture(textureRef.current); textureRef.current = null; }
        if (transitionTextureRef.current) { gl.deleteTexture(transitionTextureRef.current); transitionTextureRef.current = null; }
        if (colorMapTextureRef.current) { gl.deleteTexture(colorMapTextureRef.current); colorMapTextureRef.current = null; }
        if (positionBufferRef.current) { gl.deleteBuffer(positionBufferRef.current); positionBufferRef.current = null; }
        if (texCoordBufferRef.current) { gl.deleteBuffer(texCoordBufferRef.current); texCoordBufferRef.current = null; }
        try {
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch (error) {
          logger.debug('WEBGL_lose_context cleanup failed', error);
        }
        glRef.current = null;
      }
    };
  }, [initWebGL, releaseTextureStorage]);

  const processRenderBatch = useCallback((batch: SpectrumRenderBatch | null) => {
    if (!batch) {
      return;
    }

    if (verticalScrollAnimRef.current) {
      cancelAnimationFrame(verticalScrollAnimRef.current);
      verticalScrollAnimRef.current = undefined;
    }

    if (batch.mode === 'reset' || batch.rows.length === 0 || !batch.axis) {
      stopAxisTransition(false);
      displayRowsRef.current = [];
      displayRowTimestampsRef.current = [];
      rowCountRef.current = 0;
      headRowRef.current = 0;
      lastAnimatedFrameTokenRef.current = null;
      lastDataTimeRef.current = 0;
      applyCycleMarkerScrollOffset(0);
      setCycleMarkers([]);
      updateViewState(null, false);
      resetAutoRangeState();
      releaseTextureStorage();
      return;
    }

    const nextAxis = batch.axis;
    const maxRows = totalRows ?? batch.rows.length;

    if (batch.mode === 'replace') {
      const previousAxis = currentAxisRef.current;
      if (displayRowsRef.current.length > 0 && previousAxis && !areAxesEqual(previousAxis, nextAxis)) {
        startAxisTransition(previousAxis, nextAxis);
      } else {
        stopAxisTransition(false);
        updateCurrentAxisUniform(nextAxis);
      }

      displayRowsRef.current = batch.rows.slice(0, maxRows);
      displayRowTimestampsRef.current = batch.rowTimestamps.slice(0, maxRows);
      rowCountRef.current = displayRowsRef.current.length;
      headRowRef.current = 0;
      lastAnimatedFrameTokenRef.current = batch.frameToken;
      refreshCycleMarkers(displayRowTimestampsRef.current);
      rebuildTexture(displayRowsRef.current, nextAxis);
      updateViewState(nextAxis, true);

      const gl = glRef.current;
      const program = programRef.current;
      if (gl && program && !gl.isContextLost() && scrollRowsLocationRef.current) {
        gl.useProgram(program);
        gl.uniform1f(scrollRowsLocationRef.current, 0);
      }
      applyCycleMarkerScrollOffset(0);
      render();
      return;
    }

    for (let index = 0; index < batch.rows.length; index += 1) {
      displayRowsRef.current.unshift(batch.rows[index]);
      displayRowTimestampsRef.current.unshift(batch.rowTimestamps[index]);
    }
    if (displayRowsRef.current.length > maxRows) {
      displayRowsRef.current.length = maxRows;
    }
    if (displayRowTimestampsRef.current.length > maxRows) {
      displayRowTimestampsRef.current.length = maxRows;
    }
    refreshCycleMarkers(displayRowTimestampsRef.current);

    appendRowsToTexture(batch.rows, nextAxis);
    updateViewState(nextAxis, true);

    const shouldAnimateScroll = batch.frameToken !== null && batch.frameToken !== lastAnimatedFrameTokenRef.current;
    lastAnimatedFrameTokenRef.current = batch.frameToken;

    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost() || !scrollRowsLocationRef.current) {
      applyCycleMarkerScrollOffset(0);
      return;
    }

    if (!shouldAnimateScroll) {
      gl.useProgram(program);
      gl.uniform1f(scrollRowsLocationRef.current, 0);
      applyCycleMarkerScrollOffset(0);
      render();
      return;
    }

    const now = performance.now();
    if (lastDataTimeRef.current > 0) {
      const interval = Math.min(now - lastDataTimeRef.current, 500);
      frameIntervalRef.current = frameIntervalRef.current * 0.7 + interval * 0.3;
    }
    lastDataTimeRef.current = now;

    const startRows = Math.min(batch.rows.length, Math.max(rowCountRef.current, 1));
    const animDuration = batch.hasBacklog
      ? Math.max(45, Math.min(140, frameIntervalRef.current * Math.max(0.45, batch.rows.length * 0.3)))
      : Math.max(50, Math.min(180, frameIntervalRef.current * Math.max(0.9, batch.rows.length * 0.45)));
    const animStartTime = now;

    gl.useProgram(program);
    gl.uniform1f(scrollRowsLocationRef.current, startRows);
    applyCycleMarkerScrollOffset(startRows);
    render();

    const animate = () => {
      const elapsed = performance.now() - animStartTime;
      const progress = Math.min(1, elapsed / animDuration);
      const eased = easeSpectrumAxisTransition(progress);
      const offset = startRows * (1 - eased);

      const currentGl = glRef.current;
      const currentProgram = programRef.current;
      if (currentGl && currentProgram && !currentGl.isContextLost() && scrollRowsLocationRef.current) {
        currentGl.useProgram(currentProgram);
        currentGl.uniform1f(scrollRowsLocationRef.current, offset);
        applyCycleMarkerScrollOffset(offset);
        render();
      }

      if (progress < 1) {
        verticalScrollAnimRef.current = requestAnimationFrame(animate);
      } else {
        verticalScrollAnimRef.current = undefined;
        applyCycleMarkerScrollOffset(0);
      }
    };

    verticalScrollAnimRef.current = requestAnimationFrame(animate);
  }, [
    appendRowsToTexture,
    applyCycleMarkerScrollOffset,
    refreshCycleMarkers,
    releaseTextureStorage,
    rebuildTexture,
    render,
    resetAutoRangeState,
    startAxisTransition,
    stopAxisTransition,
    totalRows,
    updateCurrentAxisUniform,
    updateViewState,
  ]);

  useEffect(() => {
    processRenderBatchRef.current = processRenderBatch;
  }, [processRenderBatch]);

  useEffect(() => {
    refreshCycleMarkers();
  }, [refreshCycleMarkers]);

  useEffect(() => {
    processRenderBatchRef.current(controller.primeRenderBatch());

    const handleFrameTick = () => {
      processRenderBatchRef.current(controller.consumeRenderBatch());
    };

    return controller.subscribeFrameTick(handleFrameTick);
  }, [controller]);

  useEffect(() => {
    if (!viewState.hasData) {
      resetAutoRangeState();
    }
  }, [viewState.hasData, resetAutoRangeState]);

  useEffect(() => {
    if (hoveredRxMarkerId === null) {
      return;
    }
    if (!rxFrequencies.some(({ operatorId }) => operatorId === hoveredRxMarkerId)) {
      setHoveredRxMarkerId(null);
    }
  }, [hoveredRxMarkerId, rxFrequencies]);

  useEffect(() => {
    resetAutoRangeState();
  }, [
    autoRange,
    axis?.binCount,
    axis?.minHz,
    axis?.maxHz,
    resetAutoRangeState,
  ]);

  useEffect(() => {
    if (!autoRange) return;
    resetAutoRangeState();
  }, [
    autoRange,
    autoRangeConfig.updateInterval,
    autoRangeConfig.minPercentile,
    autoRangeConfig.maxPercentile,
    autoRangeConfig.rangeExpansionFactor,
    resetAutoRangeState,
  ]);

  // height属性变化时重新调整尺寸
  useEffect(() => {
    const timer = setTimeout(() => {
      handleResize();
    }, 0);

    return () => clearTimeout(timer);
  }, [height, handleResize]);

  // 参数变化只重建纹理/重绘，不重建 WebGL context
  useEffect(() => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program) return;

    gl.useProgram(program);
    if (minDbLocationRef.current) {
      gl.uniform1f(minDbLocationRef.current, minDb);
    }
    if (maxDbLocationRef.current) {
      gl.uniform1f(maxDbLocationRef.current, maxDb);
    }

    if (displayRowsRef.current.length > 0 && currentAxisRef.current) {
      rebuildTexture(displayRowsRef.current, currentAxisRef.current);
    }
    render();
  }, [minDb, maxDb, rebuildTexture, render]);

  useEffect(() => {
    if (!displayRowsRef.current.length || !currentAxisRef.current) {
      return;
    }
    rebuildTexture(displayRowsRef.current, currentAxisRef.current);
    render();
  }, [
    autoRange,
    autoRangeConfig.updateInterval,
    autoRangeConfig.minPercentile,
    autoRangeConfig.maxPercentile,
    autoRangeConfig.rangeExpansionFactor,
    rebuildTexture,
    render,
  ]);


  if (!webglSupported || error) {
    const errorMessage = error === 'NOT_SUPPORTED' ? t('webgl.notSupported')
      : error === 'INIT_FAILED' ? t('webgl.initFailed', { message: t('webgl.unknownError') })
      : error ? t('webgl.initFailed', { message: error })
      : null;
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ height: `${height}px` }}>
        <div className="text-red-400 text-center">
          <div>{t('webgl.renderFailed')}</div>
          {errorMessage && <div className="text-sm mt-2">{errorMessage}</div>}
        </div>
      </div>
    );
  }

  const FREQ_POSITION_OFFSET = WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ;
  const isAbsoluteDisplayMode = frequencyRangeMode === 'absolute-center' || frequencyRangeMode === 'absolute-fixed';
  const isAbsoluteWindowedMode = frequencyRangeMode === 'absolute-windowed';
  const minFrequency = axis?.minHz ?? 0;
  const maxFrequency = axis?.maxHz ?? 0;
  const hasAxis = Boolean(axis && axis.binCount > 0 && maxFrequency > minFrequency);

  const snapFrequency = useCallback((frequency: number, overrideStepHz?: number | null) => {
    const stepHz = typeof overrideStepHz === 'number' && Number.isFinite(overrideStepHz) && overrideStepHz > 0
      ? overrideStepHz
      : typeof interactionFrequencyStepHz === 'number' && Number.isFinite(interactionFrequencyStepHz) && interactionFrequencyStepHz > 0
        ? interactionFrequencyStepHz
        : 1;
    return Math.round(frequency / stepHz) * stepHz;
  }, [interactionFrequencyStepHz]);

  const effectiveDragFrequencyStepHz = typeof dragFrequencyStepHz === 'number' && Number.isFinite(dragFrequencyStepHz) && dragFrequencyStepHz > 0
    ? dragFrequencyStepHz
    : interactionFrequencyStepHz;

  const clampBasebandFrequency = useCallback((frequency: number, stepHz?: number | null) => {
    return snapFrequency(Math.max(basebandInteractionRange.min, Math.min(basebandInteractionRange.max, frequency)), stepHz);
  }, [basebandInteractionRange.max, basebandInteractionRange.min, snapFrequency]);

  const clampInteractionFrequency = useCallback((frequency: number, stepHz?: number | null) => {
    if (!interactionFrequencyRange) {
      return snapFrequency(frequency, stepHz);
    }
    return snapFrequency(Math.max(interactionFrequencyRange.min, Math.min(interactionFrequencyRange.max, frequency)), stepHz);
  }, [interactionFrequencyRange, snapFrequency]);

  const snapBandValue = useCallback((value: number, stepHz: number | null | undefined) => {
    const normalizedStepHz = typeof stepHz === 'number' && Number.isFinite(stepHz) && stepHz > 0
      ? stepHz
      : 1;
    return Math.round(value / normalizedStepHz) * normalizedStepHz;
  }, []);

  const getDisplayFrequency = useCallback((basebandFrequency: number) => {
    if (!hasAxis) return null;
    if (isAbsoluteWindowedMode) {
      return basebandFrequency;
    }
    if (isAbsoluteDisplayMode) {
      const referenceFrequency = referenceFrequencyHz ?? null;
      if (referenceFrequency === null) {
        return null;
      }
      return referenceFrequency + basebandFrequency;
    }
    return basebandFrequency;
  }, [hasAxis, isAbsoluteDisplayMode, isAbsoluteWindowedMode, referenceFrequencyHz]);

  // 计算频率到位置的百分比
  const getFrequencyPosition = useCallback((displayFrequency: number, visualOffsetHz = FREQ_POSITION_OFFSET) => {
    if (!hasAxis) return 0;
    return getWaterfallFrequencyPositionPercent(displayFrequency, minFrequency, maxFrequency, visualOffsetHz);
  }, [hasAxis, maxFrequency, minFrequency]);

  const getMarkerPosition = useCallback((basebandFrequency: number) => {
    const displayFrequency = getDisplayFrequency(basebandFrequency);
    if (displayFrequency === null) return null;

    const position = getFrequencyPosition(displayFrequency);
    if (!Number.isFinite(position) || position < 0 || position > 100) {
      return null;
    }

    return position;
  }, [getDisplayFrequency, getFrequencyPosition]);

  // 从鼠标位置计算频率
  const getFrequencyFromMousePosition = useCallback((clientX: number, visualOffsetHz = FREQ_POSITION_OFFSET) => {
    const container = containerRef.current;
    if (!container || !hasAxis) return 0;

    const containerRect = container.getBoundingClientRect();
    const relativeX = clientX - containerRect.left;
    const percentage = Math.max(0, Math.min(1, relativeX / containerRect.width));

    const displayFrequency = minFrequency + percentage * (maxFrequency - minFrequency) - visualOffsetHz;
    const basebandFrequency = isAbsoluteDisplayMode
      ? displayFrequency - (referenceFrequencyHz ?? minFrequency)
      : displayFrequency;

    return clampBasebandFrequency(basebandFrequency);
  }, [clampBasebandFrequency, hasAxis, isAbsoluteDisplayMode, maxFrequency, minFrequency, referenceFrequencyHz]);

  const getInteractionFrequencyFromMousePosition = useCallback((clientX: number, visualOffsetHz = FREQ_POSITION_OFFSET, stepHz?: number | null) => {
    const container = containerRef.current;
    if (!container || !hasAxis) return 0;

    const containerRect = container.getBoundingClientRect();
    const relativeX = clientX - containerRect.left;
    const percentage = Math.max(0, Math.min(1, relativeX / containerRect.width));
    const displayFrequency = minFrequency + percentage * (maxFrequency - minFrequency) - visualOffsetHz;

    if (interactionFrequencyMode === 'absolute') {
      return clampInteractionFrequency(displayFrequency, stepHz);
    }

    const basebandFrequency = isAbsoluteDisplayMode
      ? displayFrequency - (referenceFrequencyHz ?? minFrequency)
      : displayFrequency;
    return clampBasebandFrequency(basebandFrequency, stepHz);
  }, [
    clampBasebandFrequency,
    clampInteractionFrequency,
    hasAxis,
    interactionFrequencyMode,
    isAbsoluteDisplayMode,
    maxFrequency,
    minFrequency,
    referenceFrequencyHz,
  ]);

  const getInteractionFrequencyPosition = useCallback((frequency: number, visualOffsetHz = FREQ_POSITION_OFFSET) => {
    if (interactionFrequencyMode === 'absolute') {
      const position = getFrequencyPosition(frequency, visualOffsetHz);
      return Number.isFinite(position) ? position : null;
    }
    const displayFrequency = getDisplayFrequency(frequency);
    if (displayFrequency === null) return null;
    const position = getFrequencyPosition(displayFrequency, visualOffsetHz);
    return Number.isFinite(position) ? position : null;
  }, [getDisplayFrequency, getFrequencyPosition, interactionFrequencyMode]);

  const getCurrentReferenceInteractionFrequency = useCallback(() => {
    const referenceFrequency = referenceFrequencyHz ?? null;
    if (
      interactionFrequencyMode === 'absolute'
      && typeof referenceFrequency === 'number'
      && Number.isFinite(referenceFrequency)
    ) {
      return clampInteractionFrequency(referenceFrequency, effectiveDragFrequencyStepHz);
    }
    return null;
  }, [clampInteractionFrequency, effectiveDragFrequencyStepHz, interactionFrequencyMode, referenceFrequencyHz]);

  const commitFrequencyGestureValue = useCallback((frequency: number) => {
    if (!onDragFrequencyChange || lastCommittedGestureFrequencyRef.current === frequency) {
      return;
    }

    onDragFrequencyChange(frequency);
    lastCommittedGestureFrequencyRef.current = frequency;
    lastGestureCommitAtRef.current = Date.now();
  }, [onDragFrequencyChange]);

  const scheduleFrequencyGestureCommit = useCallback((frequency: number) => {
    const nowMs = Date.now();
    const delayMs = getWaterfallDragCommitDelayMs(
      nowMs,
      lastGestureCommitAtRef.current,
      dragFrequencyCommitIntervalMs,
    );

    if (delayMs <= 0) {
      if (gestureDragDebounceRef.current) {
        clearTimeout(gestureDragDebounceRef.current);
        gestureDragDebounceRef.current = null;
      }
      commitFrequencyGestureValue(frequency);
      return;
    }

    if (gestureDragDebounceRef.current) {
      clearTimeout(gestureDragDebounceRef.current);
    }
    gestureDragDebounceRef.current = setTimeout(() => {
      gestureDragDebounceRef.current = null;
      const latestFrequency = latestGestureFrequencyRef.current;
      if (typeof latestFrequency === 'number') {
        commitFrequencyGestureValue(latestFrequency);
      }
    }, delayMs);
  }, [commitFrequencyGestureValue, dragFrequencyCommitIntervalMs]);

  const buildFrequencyBandChange = useCallback((
    overlay: FrequencyBandOverlay,
    dragState: NonNullable<typeof draggingFrequencyBandOverlay>,
    clientX: number,
  ): FrequencyBandOverlayChange => {
    const minWidthHz = typeof overlay.minWidthHz === 'number' ? overlay.minWidthHz : 1;
    const maxWidthHz = typeof overlay.maxWidthHz === 'number' ? overlay.maxWidthHz : Number.POSITIVE_INFINITY;
    const minCenter = typeof overlay.minCenterFrequency === 'number' ? overlay.minCenterFrequency : Number.NEGATIVE_INFINITY;
    const maxCenter = typeof overlay.maxCenterFrequency === 'number' ? overlay.maxCenterFrequency : Number.POSITIVE_INFINITY;
    const startWidth = Math.max(1, dragState.startWidthHz);

    let centerFrequency = dragState.startCenterFrequency;
    let widthHz = startWidth;

    if (dragState.dragTarget === 'center') {
      const deltaHz = (clientX - dragState.startX) * dragState.hzPerPixel;
      centerFrequency = Math.max(minCenter, Math.min(maxCenter, snapBandValue(
        dragState.startCenterFrequency + deltaHz,
        overlay.centerStepHz ?? overlay.stepHz,
      )));
    } else {
      const edgeFrequency = getInteractionFrequencyFromMousePosition(clientX, 0);
      widthHz = Math.abs(edgeFrequency - dragState.startCenterFrequency) * 2;
      widthHz = Math.max(minWidthHz, Math.min(maxWidthHz, snapBandValue(widthHz, overlay.widthStepHz ?? overlay.stepHz)));
    }

    return {
      centerFrequency,
      rangeStartFrequency: centerFrequency - widthHz / 2,
      rangeEndFrequency: centerFrequency + widthHz / 2,
      widthHz,
    };
  }, [getInteractionFrequencyFromMousePosition, snapBandValue]);

  const handleGenericFrequencyDragMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!onDragFrequencyChange || event.button !== 0 || !hasAxis) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-waterfall-marker-interactive="true"]')) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (gestureCooldownTimerRef.current) {
      clearTimeout(gestureCooldownTimerRef.current);
      gestureCooldownTimerRef.current = null;
    }

    const rect = container.getBoundingClientRect();
    const hzPerPixel = rect.width > 0
      ? (maxFrequency - minFrequency) / rect.width
      : 0;
    const startFrequency = getCurrentReferenceInteractionFrequency()
      ?? getInteractionFrequencyFromMousePosition(event.clientX, FREQ_POSITION_OFFSET, effectiveDragFrequencyStepHz);

    latestGestureFrequencyRef.current = startFrequency;
    lastCommittedGestureFrequencyRef.current = null;
    lastGestureCommitAtRef.current = null;
    onDragFrequencyActiveChange?.(true);
    setLocalGestureFrequencyOverride({ source: 'mouse-drag', frequency: startFrequency });
    setFrequencyGestureDragState({
      startX: event.clientX,
      startFrequency,
      hzPerPixel,
      hasExceededThreshold: false,
    });
  }, [
    clampInteractionFrequency,
    effectiveDragFrequencyStepHz,
    getCurrentReferenceInteractionFrequency,
    getInteractionFrequencyFromMousePosition,
    hasAxis,
    interactionFrequencyMode,
    maxFrequency,
    minFrequency,
    onDragFrequencyChange,
    referenceFrequencyHz,
  ]);

  // 拖动处理函数
  const handleMouseDown = useCallback((operatorId: string) => {
    // 如果有正在进行的冷却，先清除
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
    setCooldownOperatorId(null);
    setDraggingOperatorId(operatorId);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingOperatorId || !onTxFrequencyChange) return;

    const newFrequency = getFrequencyFromMousePosition(e.clientX);

    // 乐观更新：立即更新本地位置
    setLocalFrequencyOverride({ operatorId: draggingOperatorId, frequency: newFrequency });
    latestDragFrequencyRef.current = { operatorId: draggingOperatorId, frequency: newFrequency };

    // 200ms 防抖发送到服务端
    if (dragDebounceRef.current) clearTimeout(dragDebounceRef.current);
    dragDebounceRef.current = setTimeout(() => {
      const latest = latestDragFrequencyRef.current;
      if (latest && onTxFrequencyChange) {
        onTxFrequencyChange(latest.operatorId, latest.frequency);
      }
    }, 200);
  }, [draggingOperatorId, onTxFrequencyChange, getFrequencyFromMousePosition]);

  const handleBandOverlayMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingBandOverlayId || !onTxBandOverlayFrequencyChange) return;

    const newFrequency = getInteractionFrequencyFromMousePosition(e.clientX);
    setLocalBandOverlayOverride({ id: draggingBandOverlayId, frequency: newFrequency });
    latestBandOverlayFrequencyRef.current = { id: draggingBandOverlayId, frequency: newFrequency };

    if (dragDebounceRef.current) clearTimeout(dragDebounceRef.current);
    dragDebounceRef.current = setTimeout(() => {
      const latest = latestBandOverlayFrequencyRef.current;
      if (latest && onTxBandOverlayFrequencyChange) {
        onTxBandOverlayFrequencyChange(latest.id, latest.frequency);
      }
    }, 200);
  }, [draggingBandOverlayId, getInteractionFrequencyFromMousePosition, onTxBandOverlayFrequencyChange]);

  const handleFrequencyBandOverlayMouseDown = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    overlay: FrequencyBandOverlay,
    dragTarget: 'center' | 'start' | 'end',
  ) => {
    if (event.button !== 0 || !hasAxis || (!overlay.draggable && dragTarget === 'center') || (!overlay.resizable && dragTarget !== 'center')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const hzPerPixel = rect.width > 0 ? (maxFrequency - minFrequency) / rect.width : 0;
    const widthHz = Math.abs(overlay.rangeEndFrequency - overlay.rangeStartFrequency);
    const change = {
      id: overlay.id,
      centerFrequency: overlay.centerFrequency,
      rangeStartFrequency: overlay.rangeStartFrequency,
      rangeEndFrequency: overlay.rangeEndFrequency,
      widthHz,
    };
    latestFrequencyBandChangeRef.current = change;
    setLocalFrequencyBandOverride(change);
    setDraggingFrequencyBandOverlay({
      id: overlay.id,
      dragTarget,
      startX: event.clientX,
      startCenterFrequency: overlay.centerFrequency,
      startWidthHz: widthHz,
      hzPerPixel,
    });
  }, [hasAxis, maxFrequency, minFrequency]);

  const handleMouseUp = useCallback(() => {
    if (!draggingOperatorId) return;

    // 清除防抖，立即 flush 最新值
    if (dragDebounceRef.current) {
      clearTimeout(dragDebounceRef.current);
      dragDebounceRef.current = null;
    }
    const latest = latestDragFrequencyRef.current;
    if (latest && onTxFrequencyChange) {
      onTxFrequencyChange(latest.operatorId, latest.frequency);
    }

    // 进入 500ms 冷却期（保留 localFrequencyOverride 防止闪回）
    const opId = draggingOperatorId;
    setDraggingOperatorId(null);
    setCooldownOperatorId(opId);
    cooldownTimerRef.current = setTimeout(() => {
      setCooldownOperatorId(null);
      setLocalFrequencyOverride(null);
      latestDragFrequencyRef.current = null;
      cooldownTimerRef.current = null;
    }, 500);
  }, [draggingOperatorId, onTxFrequencyChange]);

  const handleBandOverlayMouseUp = useCallback(() => {
    if (!draggingBandOverlayId) return;

    if (dragDebounceRef.current) {
      clearTimeout(dragDebounceRef.current);
      dragDebounceRef.current = null;
    }

    const latest = latestBandOverlayFrequencyRef.current;
    if (latest && onTxBandOverlayFrequencyChange) {
      onTxBandOverlayFrequencyChange(latest.id, latest.frequency);
    }

    const overlayId = draggingBandOverlayId;
    setDraggingBandOverlayId(null);
    setCooldownBandOverlayId(overlayId);
    cooldownTimerRef.current = setTimeout(() => {
      setCooldownBandOverlayId(null);
      setLocalBandOverlayOverride(null);
      latestBandOverlayFrequencyRef.current = null;
      cooldownTimerRef.current = null;
    }, 500);
  }, [draggingBandOverlayId, onTxBandOverlayFrequencyChange]);

  // 监听拖动事件
  useEffect(() => {
    if (draggingOperatorId) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [draggingOperatorId, handleMouseMove, handleMouseUp]);

  useEffect(() => {
    if (draggingBandOverlayId) {
      document.addEventListener('mousemove', handleBandOverlayMouseMove);
      document.addEventListener('mouseup', handleBandOverlayMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleBandOverlayMouseMove);
        document.removeEventListener('mouseup', handleBandOverlayMouseUp);
      };
    }
  }, [draggingBandOverlayId, handleBandOverlayMouseMove, handleBandOverlayMouseUp]);

  useEffect(() => {
    if (!draggingFrequencyBandOverlay) {
      return;
    }

    const handleFrequencyBandMouseMove = (event: MouseEvent) => {
      const overlay = frequencyBandOverlays.find(item => item.id === draggingFrequencyBandOverlay.id);
      if (!overlay) {
        return;
      }
      const change = buildFrequencyBandChange(overlay, draggingFrequencyBandOverlay, event.clientX);
      const next = { id: overlay.id, ...change };
      latestFrequencyBandChangeRef.current = next;
      setLocalFrequencyBandOverride(next);
      onFrequencyBandOverlayPreviewChange?.(overlay.id, change);
    };

    const handleFrequencyBandMouseUp = () => {
      const latest = latestFrequencyBandChangeRef.current;
      if (latest) {
        const { id, ...change } = latest;
        onFrequencyBandOverlayCommit?.(id, change);
      }
      setDraggingFrequencyBandOverlay(null);
      setLocalFrequencyBandOverride(null);
      latestFrequencyBandChangeRef.current = null;
    };

    document.addEventListener('mousemove', handleFrequencyBandMouseMove);
    document.addEventListener('mouseup', handleFrequencyBandMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleFrequencyBandMouseMove);
      document.removeEventListener('mouseup', handleFrequencyBandMouseUp);
    };
  }, [
    buildFrequencyBandChange,
    draggingFrequencyBandOverlay,
    frequencyBandOverlays,
    onFrequencyBandOverlayCommit,
    onFrequencyBandOverlayPreviewChange,
  ]);

  useEffect(() => {
    if (!frequencyGestureDragState || !onDragFrequencyChange) {
      return;
    }

    const handleGestureMouseMove = (event: MouseEvent) => {
      const dragDistance = event.clientX - frequencyGestureDragState.startX;
      const hasExceededThreshold = frequencyGestureDragState.hasExceededThreshold
        || Math.abs(dragDistance) >= FREQUENCY_GESTURE_DRAG_THRESHOLD_PX;

      if (!hasExceededThreshold) {
        return;
      }

      const nextRawFrequency = getWaterfallDragTunedFrequency(
        frequencyGestureDragState.startFrequency,
        dragDistance,
        frequencyGestureDragState.hzPerPixel,
      );
      const nextFrequency = interactionFrequencyMode === 'absolute'
        ? clampInteractionFrequency(
            nextRawFrequency,
            effectiveDragFrequencyStepHz,
          )
        : clampBasebandFrequency(
            nextRawFrequency,
            effectiveDragFrequencyStepHz,
          );

      if (!frequencyGestureDragState.hasExceededThreshold) {
        setFrequencyGestureDragState(current => (
          current
            ? {
                ...current,
                hasExceededThreshold: true,
              }
            : current
        ));
      }

      setLocalGestureFrequencyOverride({ source: 'mouse-drag', frequency: nextFrequency });
      latestGestureFrequencyRef.current = nextFrequency;
      onDragFrequencyPreview?.(nextFrequency);
      scheduleFrequencyGestureCommit(nextFrequency);
    };

    const handleGestureMouseUp = () => {
      if (gestureDragDebounceRef.current) {
        clearTimeout(gestureDragDebounceRef.current);
        gestureDragDebounceRef.current = null;
      }

      const latestFrequency = latestGestureFrequencyRef.current;
      if (frequencyGestureDragState.hasExceededThreshold && typeof latestFrequency === 'number') {
        commitFrequencyGestureValue(latestFrequency);
      }

      setFrequencyGestureDragState(null);
      if (frequencyGestureDragState.hasExceededThreshold) {
        gestureCooldownTimerRef.current = setTimeout(() => {
          setLocalGestureFrequencyOverride(current => clearWaterfallGestureOverrideForSource(current, 'mouse-drag'));
          latestGestureFrequencyRef.current = null;
          lastCommittedGestureFrequencyRef.current = null;
          lastGestureCommitAtRef.current = null;
          gestureCooldownTimerRef.current = null;
        }, 500);
      } else {
        setLocalGestureFrequencyOverride(current => clearWaterfallGestureOverrideForSource(current, 'mouse-drag'));
        latestGestureFrequencyRef.current = null;
        lastCommittedGestureFrequencyRef.current = null;
        lastGestureCommitAtRef.current = null;
      }
      onDragFrequencyActiveChange?.(false);
    };

    document.addEventListener('mousemove', handleGestureMouseMove);
    document.addEventListener('mouseup', handleGestureMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleGestureMouseMove);
      document.removeEventListener('mouseup', handleGestureMouseUp);
    };
  }, [
    clampBasebandFrequency,
    clampInteractionFrequency,
    commitFrequencyGestureValue,
    effectiveDragFrequencyStepHz,
    frequencyGestureDragState,
    interactionFrequencyMode,
    onDragFrequencyActiveChange,
    onDragFrequencyPreview,
    onDragFrequencyChange,
    scheduleFrequencyGestureCommit,
  ]);

  const horizontalWheelFrequencyEnabled = enableHorizontalWheelFrequency && Boolean(onDragFrequencyChange) && hasAxis;

  horizontalWheelRuntimeRef.current = {
    enabled: horizontalWheelFrequencyEnabled,
    hasAxis,
    minFrequency,
    maxFrequency,
    interactionFrequencyMode,
    effectiveDragFrequencyStepHz,
    dragFrequencyCommitIntervalMs,
    isMouseFrequencyDragActive: Boolean(frequencyGestureDragState),
    getCurrentReferenceInteractionFrequency,
    clampInteractionFrequency,
    clampBasebandFrequency,
    onDragFrequencyPreview,
    onDragFrequencyChange,
    onDragFrequencyActiveChange,
  };

  useEffect(() => {
    if (horizontalWheelFrequencyEnabled || !horizontalWheelStateRef.current) {
      return;
    }

    if (horizontalWheelCommitTimerRef.current) {
      clearTimeout(horizontalWheelCommitTimerRef.current);
      horizontalWheelCommitTimerRef.current = null;
    }
    if (horizontalWheelIdleTimerRef.current) {
      clearTimeout(horizontalWheelIdleTimerRef.current);
      horizontalWheelIdleTimerRef.current = null;
    }
    if (horizontalWheelStateRef.current.active) {
      horizontalWheelRuntimeRef.current?.onDragFrequencyActiveChange?.(false);
    }
    horizontalWheelStateRef.current = null;
    latestHorizontalWheelFrequencyRef.current = null;
    lastCommittedHorizontalWheelFrequencyRef.current = null;
    lastHorizontalWheelCommitAtRef.current = null;
    setLocalGestureFrequencyOverride(current => clearWaterfallGestureOverrideForSource(current, 'horizontal-wheel'));
  }, [horizontalWheelFrequencyEnabled]);

  useEffect(() => {
    const clearWheelTimers = () => {
      if (horizontalWheelCommitTimerRef.current) {
        clearTimeout(horizontalWheelCommitTimerRef.current);
        horizontalWheelCommitTimerRef.current = null;
      }
      if (horizontalWheelIdleTimerRef.current) {
        clearTimeout(horizontalWheelIdleTimerRef.current);
        horizontalWheelIdleTimerRef.current = null;
      }
    };

    const commitWheelFrequency = (frequency: number) => {
      const runtime = horizontalWheelRuntimeRef.current;
      if (!runtime?.onDragFrequencyChange || lastCommittedHorizontalWheelFrequencyRef.current === frequency) {
        return;
      }
      runtime.onDragFrequencyChange(frequency);
      lastCommittedHorizontalWheelFrequencyRef.current = frequency;
      lastHorizontalWheelCommitAtRef.current = Date.now();
    };

    const finishWheelSession = () => {
      if (horizontalWheelCommitTimerRef.current) {
        clearTimeout(horizontalWheelCommitTimerRef.current);
        horizontalWheelCommitTimerRef.current = null;
      }

      const latestFrequency = latestHorizontalWheelFrequencyRef.current;
      if (typeof latestFrequency === 'number') {
        commitWheelFrequency(latestFrequency);
      }

      const runtime = horizontalWheelRuntimeRef.current;
      if (horizontalWheelStateRef.current?.active) {
        runtime?.onDragFrequencyActiveChange?.(false);
      }
      horizontalWheelStateRef.current = null;
      latestHorizontalWheelFrequencyRef.current = null;
      lastCommittedHorizontalWheelFrequencyRef.current = null;
      lastHorizontalWheelCommitAtRef.current = null;
      setLocalGestureFrequencyOverride(current => clearWaterfallGestureOverrideForSource(current, 'horizontal-wheel'));
    };

    const scheduleWheelCommit = (frequency: number) => {
      const runtime = horizontalWheelRuntimeRef.current;
      const nowMs = Date.now();
      const delayMs = getWaterfallDragCommitDelayMs(
        nowMs,
        lastHorizontalWheelCommitAtRef.current,
        runtime?.dragFrequencyCommitIntervalMs ?? WATERFALL_DRAG_FREQUENCY_COMMIT_INTERVAL_MS,
      );

      if (delayMs <= 0) {
        if (horizontalWheelCommitTimerRef.current) {
          clearTimeout(horizontalWheelCommitTimerRef.current);
          horizontalWheelCommitTimerRef.current = null;
        }
        commitWheelFrequency(frequency);
        return;
      }

      if (horizontalWheelCommitTimerRef.current) {
        clearTimeout(horizontalWheelCommitTimerRef.current);
      }
      horizontalWheelCommitTimerRef.current = setTimeout(() => {
        horizontalWheelCommitTimerRef.current = null;
        const latestFrequency = latestHorizontalWheelFrequencyRef.current;
        if (typeof latestFrequency === 'number') {
          commitWheelFrequency(latestFrequency);
        }
      }, delayMs);
    };

    const handleWheel = (event: WheelEvent) => {
      const runtime = horizontalWheelRuntimeRef.current;
      if (
        !runtime?.enabled
        || !runtime.hasAxis
        || runtime.isMouseFrequencyDragActive
        || !shouldHandleWaterfallHorizontalWheel(event)
      ) {
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }

      const startFrequency = runtime.getCurrentReferenceInteractionFrequency();
      if (startFrequency === null) {
        return;
      }

      const hzPerPixel = (runtime.maxFrequency - runtime.minFrequency) / rect.width;
      if (!Number.isFinite(hzPerPixel) || hzPerPixel <= 0) {
        return;
      }

      event.preventDefault();
      if (!horizontalWheelStateRef.current) {
        horizontalWheelStateRef.current = {
          startFrequency,
          accumulatedDeltaXPx: 0,
          hzPerPixel,
          active: true,
        };
        latestHorizontalWheelFrequencyRef.current = startFrequency;
        lastCommittedHorizontalWheelFrequencyRef.current = null;
        lastHorizontalWheelCommitAtRef.current = null;
        runtime.onDragFrequencyActiveChange?.(true);
      }

      const wheelState = horizontalWheelStateRef.current;
      wheelState.accumulatedDeltaXPx += normalizeWaterfallWheelDeltaX(event, rect.width);
      wheelState.hzPerPixel = hzPerPixel;
      const nextRawFrequency = getWaterfallHorizontalWheelTunedFrequency(
        wheelState.startFrequency,
        wheelState.accumulatedDeltaXPx,
        wheelState.hzPerPixel,
      );
      const nextFrequency = runtime.interactionFrequencyMode === 'absolute'
        ? runtime.clampInteractionFrequency(nextRawFrequency, runtime.effectiveDragFrequencyStepHz)
        : runtime.clampBasebandFrequency(nextRawFrequency, runtime.effectiveDragFrequencyStepHz);

      setLocalGestureFrequencyOverride({ source: 'horizontal-wheel', frequency: nextFrequency });
      latestHorizontalWheelFrequencyRef.current = nextFrequency;
      runtime.onDragFrequencyPreview?.(nextFrequency);
      scheduleWheelCommit(nextFrequency);

      if (horizontalWheelIdleTimerRef.current) {
        clearTimeout(horizontalWheelIdleTimerRef.current);
      }
      horizontalWheelIdleTimerRef.current = setTimeout(() => {
        horizontalWheelIdleTimerRef.current = null;
        finishWheelSession();
      }, WATERFALL_HORIZONTAL_WHEEL_SESSION_IDLE_MS);
    };

    const container = containerRef.current;
    if (!container) {
      return;
    }
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      clearWheelTimers();
      const runtime = horizontalWheelRuntimeRef.current;
      if (horizontalWheelStateRef.current?.active) {
        runtime?.onDragFrequencyActiveChange?.(false);
      }
      horizontalWheelStateRef.current = null;
      latestHorizontalWheelFrequencyRef.current = null;
      lastCommittedHorizontalWheelFrequencyRef.current = null;
      lastHorizontalWheelCommitAtRef.current = null;
      setLocalGestureFrequencyOverride(current => clearWaterfallGestureOverrideForSource(current, 'horizontal-wheel'));
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      style={{ height: `${height}px` }}
      onMouseDown={onDragFrequencyChange ? handleGenericFrequencyDragMouseDown : undefined}
      onDoubleClick={(e) => {
        if (!onDoubleClickSetFrequency) {
          return;
        }
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-waterfall-marker-interactive="true"]')) {
          return;
        }
        onDoubleClickSetFrequency(getInteractionFrequencyFromMousePosition(e.clientX));
      }}
      onContextMenu={(e) => {
        if (onRightClickSetFrequency) {
          e.preventDefault();
          const frequency = getInteractionFrequencyFromMousePosition(e.clientX);
          onRightClickSetFrequency(frequency);
        }
      }}
    >
      {!markerOnly && (
        <canvas
          ref={canvasRef}
          className="relative z-0 w-full"
          style={{ height: `${height}px` }}
        />
      )}

      {!markerOnly && cycleMarkers.length > 0 && (
        <div ref={cycleMarkerLayerRef} className="pointer-events-none absolute inset-0 z-20 will-change-transform">
          {cycleMarkers.map(marker => (
            <div
              key={marker.id}
              className="absolute inset-x-0 h-px bg-white/45 shadow-[0_0_4px_rgba(255,255,255,0.28)]"
              style={{ top: `${marker.topPercent}%` }}
            />
          ))}
        </div>
      )}

      {/* 频率标记层 */}
      <div className="pointer-events-none absolute inset-0 z-30">
        {frequencyBandOverlays.map((overlay) => {
          const override = localFrequencyBandOverride?.id === overlay.id ? localFrequencyBandOverride : null;
          const centerFrequency = override?.centerFrequency ?? overlay.centerFrequency;
          const rangeStartFrequency = override?.rangeStartFrequency ?? overlay.rangeStartFrequency;
          const rangeEndFrequency = override?.rangeEndFrequency ?? overlay.rangeEndFrequency;
          const startPosition = getInteractionFrequencyPosition(Math.min(rangeStartFrequency, rangeEndFrequency), 0);
          const endPosition = getInteractionFrequencyPosition(Math.max(rangeStartFrequency, rangeEndFrequency), 0);
          const centerPosition = getInteractionFrequencyPosition(centerFrequency, 0);
          if (startPosition === null || endPosition === null || centerPosition === null) {
            return null;
          }
          if (endPosition < 0 || startPosition > 100) {
            return null;
          }

          const clippedLeft = Math.max(0, startPosition);
          const clippedRight = Math.min(100, endPosition);
          const width = Math.max(0, clippedRight - clippedLeft);
          const isDragging = draggingFrequencyBandOverlay?.id === overlay.id;
          const canDragCenter = Boolean(overlay.draggable && onFrequencyBandOverlayCommit);
          const canResize = Boolean(overlay.resizable && onFrequencyBandOverlayCommit);
          const widthHz = Math.round(Math.abs(rangeEndFrequency - rangeStartFrequency));
          const label = overlay.description ?? `${Math.round(centerFrequency)} Hz · ${widthHz} Hz`;
          const edgeHighlighted = hoveredFrequencyBandEdgeId === overlay.id
            || (draggingFrequencyBandOverlay?.id === overlay.id && draggingFrequencyBandOverlay.dragTarget !== 'center');

          return (
            <div key={`frequency-band-${overlay.id}`} className="absolute inset-0 h-full pointer-events-none">
              {width > 0 && (
                <div
                  className={`absolute top-0 h-full bg-cyan-400/20 shadow-[inset_0_0_22px_rgba(34,211,238,0.22)] ${isDragging ? 'bg-cyan-300/25 ring-1 ring-cyan-100/25' : ''}`}
                  style={{ left: `${clippedLeft}%`, width: `${width}%` }}
                />
              )}
              {canResize && (
                <>
                  <div
                    className="absolute top-0 z-20 h-full w-4 -translate-x-full cursor-ew-resize bg-transparent pointer-events-auto"
                    style={{ left: `${startPosition}%` }}
                    data-waterfall-marker-interactive="true"
                    title={label}
                    onMouseEnter={() => setHoveredFrequencyBandEdgeId(overlay.id)}
                    onMouseLeave={() => setHoveredFrequencyBandEdgeId(current => (current === overlay.id ? null : current))}
                    onMouseDown={(event) => handleFrequencyBandOverlayMouseDown(event, overlay, 'start')}
                  >
                    <div className={`ml-auto h-full w-px bg-cyan-100/80 transition-opacity ${edgeHighlighted ? 'opacity-100' : 'opacity-0'}`} />
                  </div>
                  <div
                    className="absolute top-0 z-20 h-full w-4 cursor-ew-resize bg-transparent pointer-events-auto"
                    style={{ left: `${endPosition}%` }}
                    data-waterfall-marker-interactive="true"
                    title={label}
                    onMouseEnter={() => setHoveredFrequencyBandEdgeId(overlay.id)}
                    onMouseLeave={() => setHoveredFrequencyBandEdgeId(current => (current === overlay.id ? null : current))}
                    onMouseDown={(event) => handleFrequencyBandOverlayMouseDown(event, overlay, 'end')}
                  >
                    <div className={`h-full w-px bg-cyan-100/80 transition-opacity ${edgeHighlighted ? 'opacity-100' : 'opacity-0'}`} />
                  </div>
                </>
              )}
              <div
                className={`group absolute top-0 z-10 h-full w-16 -translate-x-1/2 pointer-events-auto ${canDragCenter ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
                style={{ left: `${centerPosition}%` }}
                data-waterfall-marker-interactive="true"
                title={label}
                onMouseDown={canDragCenter ? (event) => handleFrequencyBandOverlayMouseDown(event, overlay, 'center') : undefined}
              >
                <div className={`mx-auto h-full w-px bg-cyan-100 transition-opacity ${isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />
                <div className="absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-100 shadow-sm select-none">
                  {label}
                </div>
              </div>
            </div>
          );
        })}

        {/* TX标记 - 红色 */}
        {txBandOverlays.map((overlay) => {
          const isOverridden = localBandOverlayOverride?.id === overlay.id
            && (draggingBandOverlayId === overlay.id || cooldownBandOverlayId === overlay.id);
          const lineFrequency = isOverridden ? localBandOverlayOverride!.frequency : overlay.lineFrequency;
          const deltaStart = overlay.rangeStartFrequency - overlay.lineFrequency;
          const deltaEnd = overlay.rangeEndFrequency - overlay.lineFrequency;
          const effectiveStart = lineFrequency + deltaStart;
          const effectiveEnd = lineFrequency + deltaEnd;
          const linePosition = getFrequencyPosition(lineFrequency);
          const startPosition = getFrequencyPosition(Math.min(effectiveStart, effectiveEnd));
          const endPosition = getFrequencyPosition(Math.max(effectiveStart, effectiveEnd));

          if (!Number.isFinite(linePosition) || !Number.isFinite(startPosition) || !Number.isFinite(endPosition)) {
            return null;
          }
          if (endPosition < 0 || startPosition > 100) {
            return null;
          }

          const clippedLeft = Math.max(0, startPosition);
          const clippedRight = Math.min(100, endPosition);
          const width = Math.max(0, clippedRight - clippedLeft);
          const draggable = overlay.draggable && !!onTxBandOverlayFrequencyChange;
          const isDragging = draggingBandOverlayId === overlay.id;

          return (
            <div
              key={`tx-band-${overlay.id}`}
              className="absolute inset-0 h-full pointer-events-none"
            >
              {width > 0 && (
                <div
                  className="absolute top-0 h-full bg-red-500/15"
                  style={{
                    left: `${clippedLeft}%`,
                    width: `${width}%`,
                  }}
                />
              )}
              <div
                className={`absolute top-0 h-full pointer-events-auto transition-opacity ${draggable ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
                style={{ left: `${linePosition}%`, transform: 'translateX(-50%)' }}
                data-waterfall-marker-interactive="true"
                onMouseDown={draggable ? () => {
                  if (cooldownTimerRef.current) {
                    clearTimeout(cooldownTimerRef.current);
                    cooldownTimerRef.current = null;
                  }
                  setCooldownBandOverlayId(null);
                  setDraggingBandOverlayId(overlay.id);
                } : undefined}
              >
                <div className={`w-0.5 h-full ${isDragging ? 'bg-red-500' : 'bg-red-500/50'}`} />
                <div className="absolute bottom-1 left-1/2 -translate-x-1/2 px-1 text-xs font-semibold bg-black/60 rounded text-red-500 select-none">
                  {overlay.label}
                </div>
              </div>
            </div>
          );
        })}

        {presetMarkers.map((marker) => {
          const position = getFrequencyPosition(marker.frequency);
          if (!Number.isFinite(position) || position < 0 || position > 100) {
            return null;
          }

          const isInteractive = Boolean(marker.clickable && onPresetMarkerClick);
          const isHovered = hoveredPresetMarkerId === marker.id;
          const markerElement = (
            <div
              key={`preset-${marker.id}`}
              className={`absolute top-0 h-full pointer-events-auto transition-opacity ${
                isInteractive ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
              }`}
              style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
              data-waterfall-marker-interactive="true"
              onClick={isInteractive ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onPresetMarkerClick?.(marker.frequency);
              } : undefined}
              onMouseEnter={() => setHoveredPresetMarkerId(marker.id)}
              onMouseLeave={() => setHoveredPresetMarkerId(null)}
            >
              <div className="w-0.5 h-full bg-amber-400/55" />
              <div
                className={`absolute bottom-1 left-1/2 -translate-x-1/2 max-w-[5rem] truncate px-1 text-xs font-semibold bg-black/60 rounded text-amber-300 select-none transition-opacity ${
                  isHovered ? 'opacity-100' : 'opacity-0'
                }`}
              >
                {marker.label}
              </div>
            </div>
          );

          if (!marker.description) {
            return markerElement;
          }

          return (
            <Popover
              key={`preset-${marker.id}`}
              placement="bottom"
              isOpen={isHovered}
              onOpenChange={(open) => {
                if (!open) setHoveredPresetMarkerId(null);
              }}
            >
              <PopoverTrigger>
                {markerElement}
              </PopoverTrigger>
              <PopoverContent
                onMouseEnter={() => setHoveredPresetMarkerId(marker.id)}
                onMouseLeave={() => setHoveredPresetMarkerId(null)}
              >
                <div className="px-2 py-1">
                  <div className="text-sm font-semibold">{marker.description}</div>
                  <div className="text-xs text-default-400">
                    {`${(marker.frequency / 1_000_000).toFixed(3)} MHz`}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          );
        })}

        {txFrequencies.map(({ operatorId, frequency, callsign }) => {
          // 拖动中或冷却期：使用本地覆盖频率
          const isOverridden = localFrequencyOverride?.operatorId === operatorId &&
            (draggingOperatorId === operatorId || cooldownOperatorId === operatorId);
          const displayFrequency = isOverridden ? localFrequencyOverride!.frequency : frequency;
          const position = getMarkerPosition(displayFrequency);
          if (position === null) {
            return null;
          }
          const isInteractive = Boolean(onTxFrequencyChange);
          const isDragging = draggingOperatorId === operatorId;
          const showPopover = txFrequencies.length > 1;
          const isHovered = hoveredTxOperatorId === operatorId;

          const markerElement = (
            <div
              key={`tx-${operatorId}`}
              className={`absolute top-0 h-full pointer-events-auto transition-opacity ${
                isInteractive ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
              } ${showPopover ? 'hover:opacity-80' : ''}`}
              style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
              data-waterfall-marker-interactive="true"
              onMouseDown={isInteractive ? () => {
                setHoveredTxOperatorId(null);
                handleMouseDown(operatorId);
              } : undefined}
              onMouseEnter={showPopover ? () => setHoveredTxOperatorId(operatorId) : undefined}
              onMouseLeave={showPopover ? () => setHoveredTxOperatorId(null) : undefined}
            >
              <div className={`w-0.5 h-full ${isDragging ? 'bg-red-500' : 'bg-red-500/50'}`} />
              <div
                className="absolute bottom-1 left-1/2 -translate-x-1/2 px-1 text-xs font-semibold bg-black/60 rounded text-red-500 select-none"
              >
                TX
              </div>
            </div>
          );

          if (!showPopover) return markerElement;

          return (
            <Popover
              key={`tx-${operatorId}`}
              placement="bottom"
              isOpen={isHovered && !isDragging}
              onOpenChange={(open) => {
                if (!open) setHoveredTxOperatorId(null);
              }}
            >
              <PopoverTrigger>
                {markerElement}
              </PopoverTrigger>
              <PopoverContent
                onMouseEnter={() => setHoveredTxOperatorId(operatorId)}
                onMouseLeave={() => setHoveredTxOperatorId(null)}
              >
                <div className="px-2 py-1">
                  <div className="text-sm font-semibold">{callsign}</div>
                  <div className="text-xs text-default-400">
                    {frequency} Hz
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          );
        })}

        {/* RX标记 - 绿色，带Popover (hover触发) */}
        {rxFrequencies.map(({ operatorId, callsign, frequency }) => {
          const position = getMarkerPosition(frequency);
          if (position === null) {
            return null;
          }
          const isOpen = hoveredRxMarkerId === operatorId;
          return (
            <Popover
              key={`rx-${operatorId}`}
              placement="bottom"
              isOpen={isOpen}
              onOpenChange={(open) => {
                if (!open) setHoveredRxMarkerId(null);
              }}
            >
              <PopoverTrigger>
                <div
                  className="absolute top-0 h-full pointer-events-auto cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
                  data-waterfall-marker-interactive="true"
                  onMouseEnter={() => setHoveredRxMarkerId(operatorId)}
                  onMouseLeave={() => setHoveredRxMarkerId(null)}
                >
                  <div className="w-0.5 h-full bg-green-500/50" />
                  <div
                    className="absolute bottom-1 left-1/2 -translate-x-1/2 px-1 text-xs font-semibold bg-black/60 rounded text-green-500 select-none"
                  >
                    RX
                  </div>
                </div>
              </PopoverTrigger>
              <PopoverContent
                onMouseEnter={() => setHoveredRxMarkerId(operatorId)}
                onMouseLeave={() => setHoveredRxMarkerId(null)}
              >
                <div className="px-2 py-1">
                  <div className="text-sm font-semibold">{callsign}</div>
                  <div className="text-xs text-default-400">
                    {frequency.toFixed(0)} Hz
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          );
        })}

        {/* Hover消息频率线 - 淡白色 */}
        {hoverFrequency !== null && hoverFrequency !== undefined && getMarkerPosition(hoverFrequency) !== null && (
          <div
            className="absolute top-0 h-full pointer-events-none"
            style={{ left: `${getMarkerPosition(hoverFrequency)}%`, transform: 'translateX(-50%)' }}
          >
            <div className="w-0.5 h-full bg-white/30" />
          </div>
        )}
        {localGestureFrequencyOverride !== null
          && getFrequencyPosition(localGestureFrequencyOverride.frequency) >= 0
          && getFrequencyPosition(localGestureFrequencyOverride.frequency) <= 100 && (
          <div
            className="absolute top-0 h-full pointer-events-none"
            style={{ left: `${getFrequencyPosition(localGestureFrequencyOverride.frequency)}%`, transform: 'translateX(-50%)' }}
          >
            <div className="w-0.5 h-full bg-primary-400/80" />
          </div>
        )}
      </div>

      {autoRange && actualRange && (
        <div style={{ display: 'none' }} className="absolute top-2 right-2 text-xs text-white bg-black bg-opacity-50 px-2 py-1 rounded">
          {t('spectrum.currentRange', { min: actualRange.min.toFixed(1), max: actualRange.max.toFixed(1) })}
        </div>
      )}
    </div>
  );
}; 
