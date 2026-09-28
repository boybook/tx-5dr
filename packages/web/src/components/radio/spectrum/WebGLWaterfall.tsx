import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Popover, PopoverTrigger, PopoverContent, Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { formatFrequencyMHz } from '../../../utils/frequencyMHz';
import { createLogger } from '../../../utils/logger';
import {
  cropSpectrumToRange,
  type SpectrumAxis,
  type SpectrumRenderBatch,
  type SpectrumStreamController,
} from '../../../spectrum/SpectrumStreamController';
import {
  IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  type FrequencyAxisTransform,
} from '../../../spectrum/frequencyAxisCalibration';
import {
  buildSpectrumThemeColorLut,
  DEFAULT_SPECTRUM_THEME_ID,
  getSafeSpectrumThemeCurve,
  type SpectrumThemeId,
} from './spectrumThemes';
import type { SpectrumViewportRuntime } from '../../../spectrum/SpectrumViewportRuntime';

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

/**
 * Gesture phase of a viewport change. During a continuous pan/zoom gesture
 * the waterfall reports 'preview' changes (rendered GPU-side via the view
 * axis uniform, without a React commit); a single 'commit' change follows
 * when the gesture ends and the texture is rebuilt at the final range.
 * Callbacks may return the effective (e.g. clamped) range so the preview
 * matches what will be committed. Legacy callbacks that are supplied through
 * `onLocalViewportChange` bypass the preview path and retain their immediate
 * commit behavior.
 */
export type WaterfallViewportChangePhase = 'preview' | 'commit';

export interface WaterfallViewportInteraction {
  mode: 'none' | 'local-pan-zoom' | 'radio-center';
  range?: InteractionFrequencyRange | null;
  bounds?: InteractionFrequencyRange | null;
  canZoom?: boolean;
  canPan?: boolean;
  onChange?: (
    range: InteractionFrequencyRange,
    source: 'pan' | 'zoom',
    phase?: WaterfallViewportChangePhase,
  ) => InteractionFrequencyRange | void;
  /** Set true when the callback understands the preview/commit phase. */
  supportsPreview?: boolean;
}

export interface TxBandOverlay {
  id: string;
  label: string;
  lineFrequency: number;
  rangeStartFrequency: number;
  rangeEndFrequency: number;
  draggable?: boolean;
  variant?: 'tx' | 'rx' | 'window';
  frequencyTarget?: 'radio-frequency' | 'operator-tx' | 'split-frequency' | null;
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

export type WaterfallRulerTickKind = 'minor' | 'medium' | 'major';

export interface WaterfallRulerTick {
  id: string;
  frequency: number;
  positionPercent: number;
  kind: WaterfallRulerTickKind;
  label?: string;
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
  frequencyAxisTransform?: FrequencyAxisTransform;
  visualFrequencyOffsetHz?: number;
  basebandInteractionRange?: BasebandInteractionRange;
  interactionFrequencyMode?: 'baseband' | 'absolute';
  interactionFrequencyRange?: InteractionFrequencyRange | null;
  viewportInteraction?: WaterfallViewportInteraction;
  /** Imperative preview bridge used when trace and waterfall share a host. */
  viewportRuntime?: SpectrumViewportRuntime;
  /** Absolute viewport panning/zooming for wide-band IQ sources (TCI). */
  enableLocalViewportPanZoom?: boolean;
  localViewportRange?: InteractionFrequencyRange | null;
  localViewportBounds?: InteractionFrequencyRange | null;
  onLocalViewportChange?: (
    range: InteractionFrequencyRange,
    source: 'pan' | 'zoom',
    phase?: WaterfallViewportChangePhase,
  ) => InteractionFrequencyRange | void;
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
  /**
   * When true, sample the spectrum texture with NEAREST (pixel-hard edges).
   * Used for IF audio waterfalls so strong tones look like SDR "thin lines"
   * instead of bilinear-smoothed bloom. AF and radio SDR keep LINEAR.
   */
  sharpPixels?: boolean;
  /** 是否显示数字模式周期开始分割线 */
  showCycleMarkers?: boolean;
  /** 数字模式周期长度（毫秒），例如 FT8=15000、FT4=7500 */
  cycleSlotMs?: number | null;
  /** Backend-negotiated interval between spectrum rows. */
  frameIntervalMs?: number;
  /** 需要显示"低功率—可开启虚拟频差"弱警告的操作员 ID（由上层根据实测功率判断） */
  lowPowerWarningOperatorIds?: string[];
  /** 弱警告 popover 中点击"一键开启虚拟频差" */
  onEnableFakeFrequency?: () => void;
  /** 弱警告 popover 中点击"不再提示" */
  onDismissLowPowerWarning?: () => void;
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
const WATERFALL_HOVER_LABEL_WIDTH_PX = 82;
const WATERFALL_HOVER_LABEL_EDGE_PADDING_PX = 6;
const WATERFALL_BASEBAND_RULER_MIN_HZ = 0;
const WATERFALL_BASEBAND_RULER_MAX_HZ = 3000;
const WATERFALL_BASEBAND_RULER_MINOR_STEP_HZ = 100;
const WATERFALL_BASEBAND_RULER_MAJOR_STEP_HZ = 500;
const WATERFALL_RULER_MIN_LABEL_SPACING_PX = 56;
// Keep nearby overlays mounted just outside the committed axis so a GPU-side
// pan can bring them into view without waiting for a React commit.
const WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT = 200;
export const WATERFALL_MAX_HISTORY_ROWS = 1024;
const WATERFALL_WHEEL_AXIS_EPSILON = 0.1;
const WATERFALL_ZOOM_REFERENCE_FACTOR = 1.05;
const WATERFALL_ZOOM_MAC_PIXELS_PER_STEP = 10;
const WATERFALL_ZOOM_WINDOWS_PIXELS_PER_STEP = 120;
const WATERFALL_SUPPLEMENT_REBASE_OVERLAP_RATIO = 0.2;

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

export function normalizeWaterfallWheelDeltaY(
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  pageHeightPx: number,
): number {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;
  switch (event.deltaMode) {
    case WATERFALL_WHEEL_DELTA_LINE:
      return event.deltaY * 16;
    case WATERFALL_WHEEL_DELTA_PAGE:
      return event.deltaY * Math.max(1, pageHeightPx);
    case WATERFALL_WHEEL_DELTA_PIXEL:
    default:
      return event.deltaY;
  }
}

export function getWaterfallLocalZoomFactor(
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  options: { isMac?: boolean; pageHeightPx?: number } = {},
): number {
  const deltaPixels = normalizeWaterfallWheelDeltaY(event, options.pageHeightPx ?? 800);
  if (!Number.isFinite(deltaPixels) || deltaPixels === 0) return 1;
  const pixelsPerStep = options.isMac ? WATERFALL_ZOOM_MAC_PIXELS_PER_STEP : WATERFALL_ZOOM_WINDOWS_PIXELS_PER_STEP;
  return Math.exp((deltaPixels / pixelsPerStep) * Math.log(WATERFALL_ZOOM_REFERENCE_FACTOR));
}

export function shouldHandleWaterfallHorizontalWheel(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'ctrlKey'> & { shiftKey?: boolean },
): boolean {
  if (event.ctrlKey) {
    return false;
  }
  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  // macOS maps Shift+wheel to horizontal scrolling while keeping deltaX at 0.
  if (event.shiftKey && (absX >= WATERFALL_WHEEL_AXIS_EPSILON || absY >= WATERFALL_WHEEL_AXIS_EPSILON)) {
    return true;
  }
  return absX >= WATERFALL_WHEEL_AXIS_EPSILON && absX > absY;
}

/** Classifies the vertical component separately so diagonal trackpad gestures
 * cannot trigger both zoom and horizontal tuning in the same wheel event. */
export function shouldHandleWaterfallVerticalWheel(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'ctrlKey'> & { shiftKey?: boolean },
): boolean {
  if (event.ctrlKey || event.shiftKey) {
    return false;
  }
  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  return absY >= WATERFALL_WHEEL_AXIS_EPSILON && (absX < WATERFALL_WHEEL_AXIS_EPSILON || absY >= absX);
}

export type WaterfallViewportWheelAxis = 'horizontal' | 'vertical';

export interface WaterfallViewportWheelAxisLock {
  axis: WaterfallViewportWheelAxis;
  expiresAt: number;
}

/**
 * Classify a viewport wheel event while preserving the dominant axis for a
 * short gesture window. Trackpads commonly emit small cross-axis deltas over
 * several wheel events; without this lock one horizontal gesture alternates
 * between pan and zoom.
 */
export function classifyWaterfallViewportWheelAxis(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'ctrlKey'> & { shiftKey?: boolean },
  lock: WaterfallViewportWheelAxisLock | null = null,
  nowMs = Date.now(),
): WaterfallViewportWheelAxis | null {
  if (event.ctrlKey) return 'vertical';
  if (event.shiftKey) return 'horizontal';

  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  if (lock && lock.expiresAt > nowMs) {
    if (lock.axis === 'horizontal' && absX >= WATERFALL_WHEEL_AXIS_EPSILON) return 'horizontal';
    if (lock.axis === 'vertical' && absY >= WATERFALL_WHEEL_AXIS_EPSILON) return 'vertical';
  }
  if (absX < WATERFALL_WHEEL_AXIS_EPSILON && absY < WATERFALL_WHEEL_AXIS_EPSILON) return null;
  if (absX > absY) return 'horizontal';
  if (absY > absX) return 'vertical';
  return lock && lock.expiresAt > nowMs ? lock.axis : null;
}

export function getWaterfallHorizontalWheelTunedFrequency(
  startFrequency: number,
  accumulatedDeltaXPx: number,
  hzPerPixel: number,
  scale = WATERFALL_HORIZONTAL_WHEEL_FREQUENCY_SCALE,
): number {
  return startFrequency + accumulatedDeltaXPx * hzPerPixel * scale;
}

export function resolveWaterfallLocalViewportRange(
  localRange: InteractionFrequencyRange | null,
  renderedAxis: SpectrumAxis | null,
): InteractionFrequencyRange | null {
  if (localRange && Number.isFinite(localRange.min) && Number.isFinite(localRange.max) && localRange.max > localRange.min) {
    return { ...localRange };
  }
  if (renderedAxis && Number.isFinite(renderedAxis.minHz) && Number.isFinite(renderedAxis.maxHz) && renderedAxis.maxHz > renderedAxis.minHz) {
    return { min: renderedAxis.minHz, max: renderedAxis.maxHz };
  }
  return null;
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

/**
 * Reuse the persistent full-texture upload buffer across rebuilds; the
 * buffer only grows. Rebuilds at a smaller size keep the larger
 * allocation because WebGL reads exactly width*height bytes from the view.
 */
export function ensureWaterfallUploadBuffer(current: Uint8Array | null, width: number, height: number): Uint8Array {
  const size = Math.max(0, width) * Math.max(0, height);
  if (current && current.length >= size) {
    return current;
  }
  return createWaterfallUploadBuffer(width, height);
}

export function getWaterfallScrollAnimationDurationMs(
  frameIntervalMs: number,
  rowCount: number,
): number {
  const safeInterval = Number.isFinite(frameIntervalMs) && frameIntervalMs > 0 ? frameIntervalMs : 100;
  const safeRowCount = Math.max(1, Math.floor(rowCount));
  return Math.max(50, safeInterval * safeRowCount);
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
  frequencyAxisTransform: FrequencyAxisTransform;
  visualFrequencyOffsetHz: number;
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
  visualOffsetHz = 0,
): number {
  return ((displayFrequency + visualOffsetHz - minFrequency) / (maxFrequency - minFrequency)) * 100;
}

export function getWaterfallFrequencyAtRatio(
  ratio: number,
  minFrequency: number,
  maxFrequency: number,
  visualOffsetHz = 0,
): number {
  const safeRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return minFrequency + safeRatio * (maxFrequency - minFrequency) - visualOffsetHz;
}

export function getWaterfallSemanticFrequencyPositionPercent(
  actualFrequency: number,
  minFrequency: number,
  maxFrequency: number,
  frequencyAxisTransform: FrequencyAxisTransform = IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  visualOffsetHz = 0,
): number {
  return getWaterfallFrequencyPositionPercent(
    frequencyAxisTransform.toVisualHz(actualFrequency),
    minFrequency,
    maxFrequency,
    visualOffsetHz,
  );
}

export function getWaterfallSemanticFrequencyAtRatio(
  ratio: number,
  minFrequency: number,
  maxFrequency: number,
  frequencyAxisTransform: FrequencyAxisTransform = IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  visualOffsetHz = 0,
): number {
  return frequencyAxisTransform.toActualHz(
    getWaterfallFrequencyAtRatio(ratio, minFrequency, maxFrequency, visualOffsetHz),
  );
}

export function getWaterfallFrequencyAfterVisualDelta(
  startFrequency: number,
  visualDeltaHz: number,
  frequencyAxisTransform: FrequencyAxisTransform = IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  visualOffsetHz = 0,
): number {
  return frequencyAxisTransform.toActualHz(
    frequencyAxisTransform.toVisualHz(startFrequency) + visualOffsetHz + visualDeltaHz - visualOffsetHz,
  );
}

/**
 * Map a screen x ratio (0..1) through the gesture view axis onto the frozen
 * texture axis. The result is the texture x coordinate used by the shader;
 * values outside [0, 1] fall outside the uploaded frequency coverage and
 * render as the colormap minimum. Identity when viewAxis equals textureAxis.
 */
export function getWaterfallViewAxisTextureX(
  ratio: number,
  viewAxis: { minHz: number; maxHz: number },
  textureAxis: { minHz: number; maxHz: number },
): number {
  const viewSpan = viewAxis.maxHz - viewAxis.minHz;
  const textureSpan = textureAxis.maxHz - textureAxis.minHz;
  if (!Number.isFinite(viewSpan) || viewSpan <= 0 || !Number.isFinite(textureSpan) || textureSpan <= 0) {
    return ratio;
  }
  const visualFrequency = viewAxis.minHz + ratio * viewSpan;
  return (visualFrequency - textureAxis.minHz) / textureSpan;
}

export interface WaterfallGestureOverlayTransform {
  translateXPx: number;
  scaleX: number;
}

/**
 * CSS transform that repositions percent-based frequency overlays (ruler
 * ticks, markers) from the frozen texture axis into the gesture view axis,
 * so they follow a GPU-side pan/zoom without a React re-render. Returns
 * null for an identity mapping (no transform needed).
 */
export function getWaterfallGestureOverlayTransform(
  textureAxis: { minHz: number; maxHz: number },
  viewAxis: { minHz: number; maxHz: number },
  widthPx: number,
): WaterfallGestureOverlayTransform | null {
  const textureSpan = textureAxis.maxHz - textureAxis.minHz;
  const viewSpan = viewAxis.maxHz - viewAxis.minHz;
  if (
    !Number.isFinite(textureSpan) || textureSpan <= 0
    || !Number.isFinite(viewSpan) || viewSpan <= 0
    || !Number.isFinite(widthPx) || widthPx <= 0
  ) {
    return null;
  }
  const scaleX = textureSpan / viewSpan;
  const translateXPx = ((textureAxis.minHz - viewAxis.minHz) / viewSpan) * widthPx;
  if (Math.abs(scaleX - 1) < 1e-6 && Math.abs(translateXPx) < 0.01) {
    return null;
  }
  return { translateXPx, scaleX };
}

function getNiceWaterfallRulerStep(spanHz: number, targetTickCount: number): number {
  if (!Number.isFinite(spanHz) || spanHz <= 0 || targetTickCount <= 0) {
    return 1;
  }

  const rawStep = spanHz / targetTickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

function isBasebandRulerRange(minFrequency: number, maxFrequency: number): boolean {
  return Math.abs(minFrequency - WATERFALL_BASEBAND_RULER_MIN_HZ) <= 1
    && Math.abs(maxFrequency - WATERFALL_BASEBAND_RULER_MAX_HZ) <= 50;
}

function getRulerLabelEvery(labelStepHz: number, spanHz: number, widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0 || !Number.isFinite(spanHz) || spanHz <= 0) {
    return 1;
  }

  const labelSpacingPx = widthPx * (labelStepHz / spanHz);
  if (labelSpacingPx <= 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(WATERFALL_RULER_MIN_LABEL_SPACING_PX / labelSpacingPx));
}

function formatWaterfallRulerTickLabel(frequency: number, spanHz: number): string {
  if (Math.abs(frequency) >= 1_000_000) {
    const decimals = spanHz <= 10_000 ? 6 : spanHz <= 100_000 ? 4 : 3;
    return (frequency / 1_000_000).toFixed(decimals);
  }

  if (Math.abs(frequency) >= 10_000) {
    return `${Math.round(frequency / 1000)}k`;
  }

  return `${Math.round(frequency)}`;
}

export function formatWaterfallHoverFrequency(frequency: number): string {
  if (Math.abs(frequency) >= 1_000_000) {
    return `${(frequency / 1_000_000).toFixed(6)} MHz`;
  }

  if (Math.abs(frequency) >= 10_000) {
    return `${(frequency / 1000).toFixed(1)} kHz`;
  }

  return `${Math.round(frequency)} Hz`;
}

export function getWaterfallHoverLabelLeftPx(
  positionPercent: number,
  widthPx: number,
  labelWidthPx = WATERFALL_HOVER_LABEL_WIDTH_PX,
  paddingPx = WATERFALL_HOVER_LABEL_EDGE_PADDING_PX,
): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) {
    return 0;
  }

  const rawLeft = (Math.max(0, Math.min(100, positionPercent)) / 100) * widthPx;
  const minLeft = paddingPx + labelWidthPx / 2;
  const maxLeft = Math.max(minLeft, widthPx - paddingPx - labelWidthPx / 2);
  return Math.max(minLeft, Math.min(maxLeft, rawLeft));
}

export function buildWaterfallRulerTicks(
  minFrequency: number,
  maxFrequency: number,
  widthPx: number,
  visualOffsetHz = 0,
  frequencyAxisTransform: FrequencyAxisTransform = IDENTITY_FREQUENCY_AXIS_TRANSFORM,
): WaterfallRulerTick[] {
  const visualSpanHz = maxFrequency - minFrequency;
  if (!Number.isFinite(visualSpanHz) || visualSpanHz <= 0 || !Number.isFinite(widthPx) || widthPx <= 0) {
    return [];
  }

  const ticks: WaterfallRulerTick[] = [];
  const rawSemanticMin = frequencyAxisTransform.toActualHz(minFrequency - visualOffsetHz);
  const rawSemanticMax = frequencyAxisTransform.toActualHz(maxFrequency - visualOffsetHz);
  const minSemanticFrequency = Math.min(rawSemanticMin, rawSemanticMax);
  const maxSemanticFrequency = Math.max(rawSemanticMin, rawSemanticMax);
  const spanHz = maxSemanticFrequency - minSemanticFrequency;
  if (!Number.isFinite(spanHz) || spanHz <= 0) {
    return [];
  }

  const baseband = isBasebandRulerRange(minFrequency, maxFrequency);
  const minorStepHz = baseband
    ? WATERFALL_BASEBAND_RULER_MINOR_STEP_HZ
    : getNiceWaterfallRulerStep(spanHz, Math.max(8, Math.floor(widthPx / 42)));
  const majorStepHz = baseband
    ? WATERFALL_BASEBAND_RULER_MAJOR_STEP_HZ
    : minorStepHz * 5;
  const mediumStepHz = majorStepHz / 2;
  const labelEvery = getRulerLabelEvery(majorStepHz, spanHz, widthPx);
  const startFrequency = Math.ceil(minSemanticFrequency / minorStepHz) * minorStepHz;
  const endFrequency = maxSemanticFrequency + minorStepHz * 0.001;
  let majorIndex = 0;

  for (let frequency = startFrequency; frequency <= endFrequency; frequency += minorStepHz) {
    const positionPercent = getWaterfallSemanticFrequencyPositionPercent(
      frequency,
      minFrequency,
      maxFrequency,
      frequencyAxisTransform,
      visualOffsetHz,
    );
    if (positionPercent < -0.001 || positionPercent > 100.001) {
      continue;
    }

    const majorRatio = frequency / majorStepHz;
    const mediumRatio = frequency / mediumStepHz;
    const isMajor = Math.abs(majorRatio - Math.round(majorRatio)) < 0.001;
    const isMedium = !isMajor && Math.abs(mediumRatio - Math.round(mediumRatio)) < 0.001;
    const kind: WaterfallRulerTickKind = isMajor ? 'major' : isMedium ? 'medium' : 'minor';
    const shouldLabel = isMajor
      && Math.abs(frequency) > 0.001
      && majorIndex % labelEvery === 0;

    ticks.push({
      id: `${Math.round(frequency * 1000)}-${kind}`,
      frequency,
      positionPercent,
      kind,
      label: shouldLabel ? formatWaterfallRulerTickLabel(frequency, spanHz) : undefined,
    });

    if (isMajor) {
      majorIndex += 1;
    }
  }

  return ticks;
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

export function calculateSpectrumAxisTransitionDuration(fromAxis: SpectrumAxis, toAxis: SpectrumAxis): number {
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
  uploadBufferRef?: MutableRef<Uint8Array | null>;
  supplementScratchRowRef?: MutableRef<Uint8Array | null>;
  supplementUploadBufferRef?: MutableRef<Uint8Array | null>;
  textureAllocatedWidthRef?: MutableRef<number>;
  textureAllocatedHeightRef?: MutableRef<number>;
  supplementAllocatedWidthRef?: MutableRef<number>;
  supplementAllocatedHeightRef?: MutableRef<number>;
  textureAxisRef?: MutableRef<SpectrumAxis | null>;
}

export function releaseWaterfallTextureMemoryRefs(refs: WaterfallTextureMemoryRefs): void {
  refs.scratchRowRef.current = null;
  if (refs.uploadBufferRef) {
    refs.uploadBufferRef.current = null;
  }
  if (refs.supplementScratchRowRef) {
    refs.supplementScratchRowRef.current = null;
  }
  if (refs.supplementUploadBufferRef) {
    refs.supplementUploadBufferRef.current = null;
  }
  refs.lastDataLengthRef.current = 0;
  refs.textureHeightRef.current = 1;
  refs.rowCountRef.current = 0;
  refs.headRowRef.current = 0;
  if (refs.textureAllocatedWidthRef) refs.textureAllocatedWidthRef.current = 0;
  if (refs.textureAllocatedHeightRef) refs.textureAllocatedHeightRef.current = 0;
  if (refs.supplementAllocatedWidthRef) refs.supplementAllocatedWidthRef.current = 0;
  if (refs.supplementAllocatedHeightRef) refs.supplementAllocatedHeightRef.current = 0;
  if (refs.textureAxisRef) refs.textureAxisRef.current = null;
}

export interface CycleMarkerPosition {
  id: string;
  topPercent: number;
  timestamp: number;
}

export function areCycleMarkerPositionsEqual(
  left: CycleMarkerPosition[],
  right: CycleMarkerPosition[],
): boolean {
  return left.length === right.length
    && left.every((marker, index) => {
      const nextMarker = right[index];
      return nextMarker
        && marker.id === nextMarker.id
        && marker.timestamp === nextMarker.timestamp
        && Math.abs(marker.topPercent - nextMarker.topPercent) < 0.001;
    });
}

export function resolveNextCycleMarkerPositions(
  currentMarkers: CycleMarkerPosition[],
  rowTimestamps: number[],
  showCycleMarkers: boolean,
  cycleSlotMs: number | null | undefined,
  visibleRows: number,
): CycleMarkerPosition[] {
  const safeVisibleRows = Math.max(1, Math.floor(visibleRows));
  const nextMarkers = showCycleMarkers
    ? buildCycleMarkerPositions(rowTimestamps, cycleSlotMs, safeVisibleRows)
    : [];

  return areCycleMarkerPositionsEqual(currentMarkers, nextMarkers)
    ? currentMarkers
    : nextMarkers;
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
  const rowCount = Math.min(rowTimestamps.length, safeVisibleRows);

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
  frequencyAxisTransform = IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  visualFrequencyOffsetHz = 0,
  basebandInteractionRange = { min: 0, max: 3000 },
  interactionFrequencyMode = 'baseband',
  interactionFrequencyRange = null,
  viewportInteraction,
  viewportRuntime,
  enableLocalViewportPanZoom = false,
  localViewportRange = null,
  localViewportBounds = null,
  onLocalViewportChange,
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
  sharpPixels = false,
  showCycleMarkers = false,
  cycleSlotMs = null,
  frameIntervalMs = 100,
  lowPowerWarningOperatorIds = [],
  onEnableFakeFrequency,
  onDismissLowPowerWarning,
}) => {
  const effectiveViewportMode = viewportInteraction?.mode
    ?? (enableLocalViewportPanZoom ? 'local-pan-zoom' : 'none');
  const localViewportInteractionEnabled = effectiveViewportMode === 'local-pan-zoom'
    && (viewportInteraction?.canPan ?? true);
  const effectiveLocalViewportRange = viewportInteraction?.range ?? localViewportRange;
  const effectiveLocalViewportBounds = viewportInteraction?.bounds ?? localViewportBounds;
  const effectiveLocalViewportChange = viewportInteraction?.onChange ?? onLocalViewportChange;
  const effectiveLocalViewportSupportsPreview = viewportInteraction?.onChange
    ? viewportInteraction.supportsPreview === true
    : false;
  const localViewportZoomEnabled = localViewportInteractionEnabled
    && (viewportInteraction?.canZoom ?? true);
  const { t } = useTranslation('common');
  const { t: tRadio } = useTranslation('radio');
  const [hoveredWarningOperatorId, setHoveredWarningOperatorId] = React.useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const containerMetricsRef = useRef<{ left: number; width: number }>({ left: 0, width: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cycleMarkerLayerRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const boundProgramRef = useRef<WebGLProgram | null>(null);
  const textureRef = useRef<WebGLTexture | null>(null);
  const transitionTextureRef = useRef<WebGLTexture | null>(null);
  const supplementTextureRef = useRef<WebGLTexture | null>(null);
  const animationRef = useRef<number>();
  const renderRequestRef = useRef<number | undefined>(undefined);
  const renderDirtyRef = useRef(false);
  const [webglSupported, setWebglSupported] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const initialViewState = {
    axis: null,
    hasData: false,
  };
  const [viewState, setViewState] = React.useState<{ axis: SpectrumAxis | null; hasData: boolean }>(initialViewState);
  const viewStateRef = useRef<{ axis: SpectrumAxis | null; hasData: boolean }>(initialViewState);
  const cycleMarkersRef = useRef<CycleMarkerPosition[]>([]);
  const cycleMarkerPoolRef = useRef<HTMLDivElement[]>([]);
  const overlayAxisTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rulerWidthPx, setRulerWidthPx] = React.useState(0);
  const [hoverCursor, setHoverCursor] = React.useState<{ ratio: number; frequency: number; clientX: number; containerTop: number } | null>(null);
  const localViewportGestureRef = useRef<{ pointerId: number; startX: number; lastX: number; startRange: InteractionFrequencyRange; hzPerPixel: number } | null>(null);
  const localViewportRangeRef = useRef<InteractionFrequencyRange | null>(null);
  const viewportWheelAxisLockRef = useRef<WaterfallViewportWheelAxisLock | null>(null);
  // Gesture view-axis session: during a continuous pan/zoom gesture the
  // visible range is applied GPU-side (u_viewAxis uniform + overlay CSS
  // transform) and committed to React/controller only once at gesture end.
  const gestureViewAxisRef = useRef<InteractionFrequencyRange | null>(null);
  // Keeps the final GPU view axis stable between gesture commit and the
  // controller's replace batch. New stream rows can arrive in that interval;
  // they must not reset the preview back to the old texture axis.
  const committedViewAxisOverrideRef = useRef<InteractionFrequencyRange | null>(null);
  const committedViewAxisOverrideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingGestureRangeRef = useRef<InteractionFrequencyRange | null>(null);
  const gestureLastSourceRef = useRef<'pan' | 'zoom'>('pan');
  const gestureCommitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const gestureRafRef = useRef<number | undefined>(undefined);
  const gestureChangeRef = useRef<WaterfallViewportInteraction['onChange'] | null>(null);
  const hoverPointerRef = useRef<{ clientX: number; pointerType: string } | null>(null);
  const hoverRafRef = useRef<number | undefined>(undefined);
  const gestureLayerWidthRef = useRef<number>(0);
  const gestureRulerRangeRef = useRef<InteractionFrequencyRange | null>(null);
  const gestureRulerVisibleRef = useRef(false);
  const gestureGpuRangeRef = useRef<InteractionFrequencyRange | null>(null);
  const rulerLayerRef = useRef<HTMLDivElement>(null);
  const markerLayerRef = useRef<HTMLDivElement>(null);
  // Imperative ruler used during viewport gestures: ticks are recomputed
  // from the gesture view range (no CSS scale distortion) into a pooled
  // DOM subtree that React never reconciles.
  const gestureRulerLayerRef = useRef<HTMLDivElement>(null);
  const gestureRulerPoolRef = useRef<Array<{
    root: HTMLDivElement;
    line: HTMLDivElement;
    label: HTMLDivElement;
    lineClass: string;
    labelText: string;
  }>>([]);
  // Per-element committed marker positions captured once at gesture start.
  // Keeping a stable list avoids querySelector/style reads on every frame.
  const gestureMarkerSnapshotRef = useRef<Array<{
    element: HTMLElement;
    leftPercent: number;
    widthPercent: number | null;
    lastWrittenLeft: string;
    lastWrittenWidth: string;
  }>>([]);
  const gestureMarkerSnapshotCapturedRef = useRef(false);
  const gestureMarkerTransformRef = useRef<WaterfallGestureOverlayTransform | null>(null);

  // TX拖动状态
  const [draggingOperatorId, setDraggingOperatorId] = React.useState<string | null>(null);
  // 拖动时的本地频率覆盖（乐观更新 + 冷却期保护）
  const [localFrequencyOverride, setLocalFrequencyOverride] =
    React.useState<{ operatorId: string; frequency: number } | null>(null);
  const [cooldownOperatorId, setCooldownOperatorId] = React.useState<string | null>(null);
  const dragDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const latestDragFrequencyRef = useRef<{ operatorId: string; frequency: number } | null>(null);
  const activeOperatorDragPointerIdRef = useRef<number | null>(null);
  const [draggingBandOverlayId, setDraggingBandOverlayId] = React.useState<string | null>(null);
  const [localBandOverlayOverride, setLocalBandOverlayOverride] =
    React.useState<{ id: string; frequency: number } | null>(null);
  const [cooldownBandOverlayId, setCooldownBandOverlayId] = React.useState<string | null>(null);
  const latestBandOverlayFrequencyRef = useRef<{ id: string; frequency: number } | null>(null);
  const activeBandOverlayDragPointerIdRef = useRef<number | null>(null);
  const [draggingFrequencyBandOverlay, setDraggingFrequencyBandOverlay] = React.useState<{
    id: string;
    dragTarget: 'center' | 'start' | 'end';
    pointerId: number;
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
    pointerId: number;
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
  const uploadBufferRef = useRef<Uint8Array | null>(null);
  const supplementScratchRowRef = useRef<Uint8Array | null>(null);
  const supplementUploadBufferRef = useRef<Uint8Array | null>(null);
  const heightRef = useRef(height);
  useEffect(() => { heightRef.current = height; }, [height]);
  const minDbRef = useRef(minDb);
  const maxDbRef = useRef(maxDb);
  const sharpPixelsRef = useRef(sharpPixels);
  useEffect(() => { minDbRef.current = minDb; }, [minDb]);
  useEffect(() => { maxDbRef.current = maxDb; }, [maxDb]);
  useEffect(() => { sharpPixelsRef.current = sharpPixels; }, [sharpPixels]);
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
  // Wide-envelope supplement rows parallel to displayRowsRef, kept at their
  // native axis for GPU-side fallback where the detail texture has no
  // coverage (gesture pan/zoom beyond the frozen texture axis).
  const displaySupplementRowsRef = useRef<(Float32Array | null)[]>([]);
  const supplementAxisRef = useRef<SpectrumAxis | null>(null);
  const supplementHeadRowRef = useRef<number>(0);
  const supplementRowCountRef = useRef<number>(0);
  const headRowRef = useRef<number>(0);
  const rowCountRef = useRef<number>(0);
  const textureWidthRef = useRef<number>(0);
  const textureAllocatedWidthRef = useRef<number>(0);
  const textureAllocatedHeightRef = useRef<number>(0);
  const supplementAllocatedWidthRef = useRef<number>(0);
  const supplementAllocatedHeightRef = useRef<number>(0);
  const maxTextureSizeRef = useRef<number>(4096);
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
  const viewAxisLocationRef = useRef<WebGLUniformLocation | null>(null);
  const supplementEnabledLocationRef = useRef<WebGLUniformLocation | null>(null);
  const supplementAxisLocationRef = useRef<WebGLUniformLocation | null>(null);
  const supplementHeadRowLocationRef = useRef<WebGLUniformLocation | null>(null);
  const supplementTextureHeightLocationRef = useRef<WebGLUniformLocation | null>(null);
  const transitionAxisLocationRef = useRef<WebGLUniformLocation | null>(null);
  const transitionHeadRowLocationRef = useRef<WebGLUniformLocation | null>(null);
  const transitionTextureHeightLocationRef = useRef<WebGLUniformLocation | null>(null);
  const verticalScrollAnimRef = useRef<number>();
  const axisTransitionAnimRef = useRef<number>();
  const lastAnimatedFrameTokenRef = useRef<string | number | null>(null);
  const currentAxisRef = useRef<SpectrumAxis | null>(null);
  // Axis represented by the bytes currently resident in the primary texture.
  // `currentAxisRef` can advance before a replace batch is uploaded; keeping
  // this separate prevents an append from mixing rows sampled on different
  // frequency grids during the gesture-end handoff.
  const textureAxisRef = useRef<SpectrumAxis | null>(null);
  const textureHeightRef = useRef<number>(Math.max(totalRows ?? 0, 1));
  const renderRef = useRef<() => void>(() => {});
  const handleResizeRef = useRef<() => void>(() => {});
  const rebuildTextureRef = useRef<(rows: ArrayLike<number>[], axis: SpectrumAxis | null) => void>(() => {});
  const processRenderBatchRef = useRef<(batch: SpectrumRenderBatch | null) => void>(() => {});
  const axis = viewState.axis ?? markerAxis;
  const clearCommittedViewAxisOverride = useCallback(() => {
    if (committedViewAxisOverrideTimerRef.current) {
      clearTimeout(committedViewAxisOverrideTimerRef.current);
      committedViewAxisOverrideTimerRef.current = null;
    }
    committedViewAxisOverrideRef.current = null;
  }, []);

  const clearOverlayAxisTransition = useCallback(() => {
    if (overlayAxisTransitionTimerRef.current) {
      clearTimeout(overlayAxisTransitionTimerRef.current);
      overlayAxisTransitionTimerRef.current = null;
    }
    const layer = markerLayerRef.current;
    if (!layer) return;
    for (const element of layer.querySelectorAll<HTMLElement>('[style*="left"]')) {
      element.style.transition = '';
    }
  }, []);

  const animateOverlayAxisTransition = useCallback((durationMs: number) => {
    const layer = markerLayerRef.current;
    if (!layer || !Number.isFinite(durationMs) || durationMs <= 0) return;
    clearOverlayAxisTransition();
    const transition = `left ${Math.round(durationMs)}ms ease, width ${Math.round(durationMs)}ms ease`;
    for (const element of layer.querySelectorAll<HTMLElement>('[style*="left"]')) {
      element.style.transition = transition;
    }
    overlayAxisTransitionTimerRef.current = setTimeout(() => {
      overlayAxisTransitionTimerRef.current = null;
      for (const element of layer.querySelectorAll<HTMLElement>('[style*="left"]')) {
        element.style.transition = '';
      }
    }, Math.ceil(durationMs) + 24);
  }, [clearOverlayAxisTransition]);

  const applyGestureMarkerPositions = useCallback((transform: WaterfallGestureOverlayTransform | null) => {
    // Reposition marker elements instead of scaling their layer: every
    // percent-positioned marker keeps its own shape (1px lines, unstretched
    // labels) while left/width follow the gesture view axis. Capture the
    // committed positions once, then only perform style writes during the
    // hot path. Reading style/layout in every wheel event would force a
    // synchronous style calculation and defeat the GPU-side preview.
    const layer = markerLayerRef.current;
    if (!layer) {
      return;
    }
    const snapshots = gestureMarkerSnapshotRef.current;
    if (!transform) {
      for (const snapshot of snapshots) {
        snapshot.element.style.left = `${snapshot.leftPercent}%`;
        snapshot.element.style.width = snapshot.widthPercent === null ? '' : `${snapshot.widthPercent}%`;
      }
      snapshots.length = 0;
      gestureMarkerSnapshotCapturedRef.current = false;
      gestureLayerWidthRef.current = 0;
      gestureMarkerTransformRef.current = null;
      return;
    }
    if (!gestureMarkerSnapshotCapturedRef.current) {
      gestureLayerWidthRef.current = Math.max(1, layer.clientWidth || containerRef.current?.clientWidth || 1);
      const elements = layer.querySelectorAll<HTMLElement>('[style*="left"]');
      for (const element of elements) {
        const left = element.style.left;
        if (!left.endsWith('%')) continue;
        const width = element.style.width;
        const leftPercent = Number.parseFloat(left);
        const widthPercent = width.endsWith('%') ? Number.parseFloat(width) : null;
        if (!Number.isFinite(leftPercent)) continue;
        snapshots.push({
          element,
          leftPercent,
          widthPercent: widthPercent !== null && Number.isFinite(widthPercent) ? widthPercent : null,
          lastWrittenLeft: left,
          lastWrittenWidth: width,
        });
      }
      gestureMarkerSnapshotCapturedRef.current = true;
    }
    const { scaleX, translateXPx } = transform;
    const previousTransform = gestureMarkerTransformRef.current;
    if (
      previousTransform
      && Math.abs(previousTransform.scaleX - scaleX) < 1e-5
      && Math.abs(previousTransform.translateXPx - translateXPx) < 0.25
    ) {
      return;
    }
    gestureMarkerTransformRef.current = { scaleX, translateXPx };
    const widthPx = Math.max(1, gestureLayerWidthRef.current);
    for (const snapshot of snapshots) {
      // A mode/frequency update may cause React to rewrite an inline style
      // while the pointer is still down. Rebase just that element from the
      // new committed style; unlike getBoundingClientRect this string read
      // does not trigger layout and keeps the hot path compositor-friendly.
      const committedLeft = snapshot.element.style.left;
      const committedWidth = snapshot.element.style.width;
      if (committedLeft !== snapshot.lastWrittenLeft && committedLeft.endsWith('%')) {
        const nextLeft = Number.parseFloat(committedLeft);
        if (Number.isFinite(nextLeft)) snapshot.leftPercent = nextLeft;
      }
      if (committedWidth !== snapshot.lastWrittenWidth) {
        const nextWidth = committedWidth.endsWith('%') ? Number.parseFloat(committedWidth) : null;
        snapshot.widthPercent = nextWidth !== null && Number.isFinite(nextWidth) ? nextWidth : null;
      }
      const nextLeftPercent = snapshot.leftPercent * scaleX + (translateXPx / widthPx) * 100;
      snapshot.element.style.left = `${nextLeftPercent}%`;
      snapshot.lastWrittenLeft = snapshot.element.style.left;
      if (snapshot.widthPercent !== null) {
        snapshot.element.style.width = `${snapshot.widthPercent * scaleX}%`;
      }
      snapshot.lastWrittenWidth = snapshot.element.style.width;
    }
  }, []);

  const setGestureRulerVisible = useCallback((visible: boolean) => {
    if (gestureRulerVisibleRef.current === visible) {
      return;
    }
    gestureRulerVisibleRef.current = visible;
    const gestureLayer = gestureRulerLayerRef.current;
    const reactLayer = rulerLayerRef.current;
    if (reactLayer) {
      // The React ruler carries a show/hide CSS transition; suppress it so
      // the visibility swap applies immediately.
      reactLayer.style.transition = visible ? 'none' : '';
      reactLayer.style.visibility = visible ? 'hidden' : '';
    }
    if (gestureLayer) {
      gestureLayer.style.visibility = visible ? 'visible' : 'hidden';
    }
  }, []);

  const clearGestureOverlays = useCallback(() => {
    applyGestureMarkerPositions(null);
    gestureMarkerSnapshotRef.current.length = 0;
    gestureMarkerSnapshotCapturedRef.current = false;
    gestureMarkerTransformRef.current = null;
    setGestureRulerVisible(false);
    gestureRulerRangeRef.current = null;
    gestureLayerWidthRef.current = 0;
    gestureRulerVisibleRef.current = false;
    gestureGpuRangeRef.current = null;
  }, [applyGestureMarkerPositions, setGestureRulerVisible]);

  const applyCycleMarkerScrollOffset = useCallback((offsetRows: number) => {
    const markerLayer = cycleMarkerLayerRef.current;
    if (!markerLayer) {
      return;
    }

    const visibleRows = Math.max(textureHeightRef.current, 1);
    const offsetPercent = (offsetRows / visibleRows) * 100;
    markerLayer.style.transform = offsetPercent === 0 ? '' : `translateY(-${offsetPercent}%)`;
  }, []);

  /**
   * Cycle boundaries are a render-only decoration. Keep a small DOM pool and
   * update its styles imperatively so a new waterfall row never schedules a
   * React reconciliation. This is particularly important for 100/120 Hz
   * streams where the marker positions change every frame.
   */
  const renderCycleMarkers = useCallback((markers: CycleMarkerPosition[]) => {
    const layer = cycleMarkerLayerRef.current;
    if (!layer) {
      return;
    }

    const pool = cycleMarkerPoolRef.current;
    for (let index = 0; index < markers.length; index += 1) {
      let element = pool[index];
      if (!element) {
        element = document.createElement('div');
        element.className = 'absolute inset-x-0 h-px bg-white/45 shadow-[0_0_4px_rgba(255,255,255,0.28)]';
        pool[index] = element;
        layer.appendChild(element);
      }
      element.style.display = '';
      element.style.top = `${markers[index]!.topPercent}%`;
    }

    for (let index = markers.length; index < pool.length; index += 1) {
      pool[index]!.style.display = 'none';
    }
  }, []);

  const clearCycleMarkers = useCallback(() => {
    cycleMarkersRef.current = [];
    const layer = cycleMarkerLayerRef.current;
    if (layer) {
      for (const element of cycleMarkerPoolRef.current) {
        element.style.display = 'none';
      }
      layer.style.transform = '';
    }
  }, []);

  const refreshCycleMarkers = useCallback((rowTimestamps: number[] = displayRowTimestampsRef.current) => {
    const visibleRows = Math.max(textureHeightRef.current, 1);
    const nextMarkers = resolveNextCycleMarkerPositions(
      cycleMarkersRef.current,
      rowTimestamps,
      showCycleMarkers,
      cycleSlotMs,
      visibleRows,
    );
    if (nextMarkers === cycleMarkersRef.current) {
      return;
    }
    cycleMarkersRef.current = nextMarkers;
    renderCycleMarkers(nextMarkers);
  }, [cycleSlotMs, renderCycleMarkers, showCycleMarkers]);

  const resetAutoRangeState = useCallback(() => {
    rangeUpdateCounterRef.current = 0;
    cachedRangeRef.current = null;
    actualRangeRef.current = null;
    frozenSegmentsRef.current = [];
    activeRowCountRef.current = 0;
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
    uniform sampler2D u_supplementTexture;
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
    uniform vec2 u_viewAxis;
    uniform bool u_supplementEnabled;
    uniform vec2 u_supplementAxis;
    uniform float u_supplementHeadRow;
    uniform float u_supplementTextureHeight;
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
      // The view axis describes the frequency range visible on screen. It
      // equals u_currentAxis (the axis the texture was uploaded at) outside
      // of gestures; during a pan/zoom gesture only u_viewAxis moves, so the
      // viewport transform runs entirely on the GPU with no CPU resampling.
      float currentSpan = max(u_currentAxis.y - u_currentAxis.x, 1.0);
      float visualFrequency = mix(u_viewAxis.x, u_viewAxis.y, v_texCoord.x);
      float currentX = (visualFrequency - u_currentAxis.x) / currentSpan;
      float transitionX = currentX;

      if (u_axisTransitionActive) {
        float progress = clamp(u_axisTransitionProgress, 0.0, 1.0);
        vec2 visualAxis = mix(u_transitionAxis, u_currentAxis, progress);
        float transitionVisualFrequency = mix(visualAxis.x, visualAxis.y, v_texCoord.x);
        float transitionSpan = max(u_transitionAxis.y - u_transitionAxis.x, 1.0);
        currentX = (transitionVisualFrequency - u_currentAxis.x) / currentSpan;
        transitionX = (transitionVisualFrequency - u_transitionAxis.x) / transitionSpan;
      }

      float value = sampleWaterfallTexture(
        u_texture,
        currentX,
        u_headRow,
        u_textureHeight,
        u_scrollRows
      );

      // Where the detail texture has no coverage (GPU-side gesture
      // pan/zoom), fall back to the wide-envelope supplement texture at its
      // own native axis. Disabled during axis transitions so the transition
      // blend stays authoritative.
      if (
        u_supplementEnabled
        && !u_axisTransitionActive
        && (currentX < 0.0 || currentX > 1.0)
      ) {
        float supplementSpan = max(u_supplementAxis.y - u_supplementAxis.x, 1.0);
        float supplementX = (visualFrequency - u_supplementAxis.x) / supplementSpan;
        value = sampleWaterfallTexture(
          u_supplementTexture,
          supplementX,
          u_supplementHeadRow,
          u_supplementTextureHeight,
          u_scrollRows
        );
      }

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
    // Radio SDR axes use absolute RF values (often 14 MHz+). mediump's
    // minimum precision can quantize away kHz-sized deltas at that magnitude,
    // which makes a GPU-side pan/zoom appear to jump or leave blank bands.
    // Prefer highp when the implementation exposes it and retain a mediump
    // fallback for low-end WebGL1 devices.
    let fragmentPrecision = 'mediump';
    try {
      const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      if (precision && precision.precision > 0) {
        fragmentPrecision = 'highp';
      }
    } catch {
      // Some WebGL1 implementations throw for precision queries; mediump is
      // still a valid fallback for those devices.
    }
    const fragmentShader = createShader(
      gl,
      gl.FRAGMENT_SHADER,
      fragmentShaderSource.replace('precision mediump float;', `precision ${fragmentPrecision} float;`),
    );

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

  const applySpectrumTextureFilter = useCallback((
    gl: WebGLRenderingContext,
    texture: WebGLTexture | null,
    useSharpPixels: boolean,
  ) => {
    if (!texture) {
      return;
    }
    const filter = useSharpPixels ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }, []);

  const ensureProgramBound = useCallback((gl: WebGLRenderingContext, program: WebGLProgram) => {
    if (boundProgramRef.current === program) {
      return;
    }
    gl.useProgram(program);
    boundProgramRef.current = program;
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
      maxTextureSizeRef.current = Math.max(1, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096);
      textureAllocatedWidthRef.current = 0;
      textureAllocatedHeightRef.current = 0;
      supplementAllocatedWidthRef.current = 0;
      supplementAllocatedHeightRef.current = 0;
      textureAxisRef.current = null;

      // 创建程序
      const program = createProgram(gl);
      if (!program) return false;

      programRef.current = program;
      gl.useProgram(program);
      boundProgramRef.current = program;

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
        applySpectrumTextureFilter(gl, transitionTexture, sharpPixelsRef.current);
      }
      const supplementTexture = gl.createTexture();
      supplementTextureRef.current = supplementTexture;
      if (supplementTexture) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, supplementTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1));
        applySpectrumTextureFilter(gl, supplementTexture, sharpPixelsRef.current);
      }
      if (dataTexture) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, dataTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1));
        applySpectrumTextureFilter(gl, dataTexture, sharpPixelsRef.current);
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
      viewAxisLocationRef.current = gl.getUniformLocation(program, 'u_viewAxis');
      supplementEnabledLocationRef.current = gl.getUniformLocation(program, 'u_supplementEnabled');
      supplementAxisLocationRef.current = gl.getUniformLocation(program, 'u_supplementAxis');
      supplementHeadRowLocationRef.current = gl.getUniformLocation(program, 'u_supplementHeadRow');
      supplementTextureHeightLocationRef.current = gl.getUniformLocation(program, 'u_supplementTextureHeight');
      transitionAxisLocationRef.current = gl.getUniformLocation(program, 'u_transitionAxis');
      transitionHeadRowLocationRef.current = gl.getUniformLocation(program, 'u_transitionHeadRow');
      transitionTextureHeightLocationRef.current = gl.getUniformLocation(program, 'u_transitionTextureHeight');
      gl.uniform1f(headRowLocationRef.current, 0.0);
      gl.uniform1f(textureHeightLocationRef.current, textureHeightRef.current);
      gl.uniform1f(scrollRowsLocationRef.current, 0.0);
      gl.uniform1i(axisTransitionActiveLocationRef.current, 0);
      gl.uniform1f(axisTransitionProgressLocationRef.current, 1.0);
      gl.uniform2f(currentAxisLocationRef.current, 0.0, 1.0);
      gl.uniform2f(viewAxisLocationRef.current, 0.0, 1.0);
      if (supplementEnabledLocationRef.current) {
        gl.uniform1i(supplementEnabledLocationRef.current, 0);
      }
      if (supplementAxisLocationRef.current) {
        gl.uniform2f(supplementAxisLocationRef.current, 0.0, 1.0);
      }
      if (supplementHeadRowLocationRef.current) {
        gl.uniform1f(supplementHeadRowLocationRef.current, 0.0);
      }
      if (supplementTextureHeightLocationRef.current) {
        gl.uniform1f(supplementTextureHeightLocationRef.current, 1.0);
      }
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

      const supplementTextureLocation = gl.getUniformLocation(program, 'u_supplementTexture');
      gl.uniform1i(supplementTextureLocation, 3);

      // 激活纹理单元
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, colorMapTexture);

      return true;
    } catch (err) {
      setWebglSupported(false);
      setError(err instanceof Error ? err.message : 'INIT_FAILED');
      return false;
    }
  }, [applySpectrumTextureFilter, applyThemeCurveUniforms, createProgram, uploadColorMapTexture]);

  // 渲染
  const render = useCallback(() => {
    const gl = glRef.current;
    const canvas = canvasRef.current;
    
    if (!gl || !canvas) return;
    // The quad covers the complete opaque canvas, so clearing and resetting
    // the viewport for every animation frame only adds driver work. Both are
    // updated by handleResize when the backing store actually changes.
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, []);

  // All non-animation invalidations share one RAF. This prevents a texture
  // upload, a ruler update, and a React effect in the same turn from each
  // issuing a separate draw. Animation callbacks use renderNow so their
  // uniform update and draw stay in the same display frame.
  const scheduleRender = useCallback(() => {
    renderDirtyRef.current = true;
    if (renderRequestRef.current !== undefined) {
      return;
    }
    renderRequestRef.current = requestAnimationFrame(() => {
      renderRequestRef.current = undefined;
      if (!renderDirtyRef.current) {
        return;
      }
      renderDirtyRef.current = false;
      render();
    });
  }, [render]);

  const renderNow = useCallback(() => {
    if (renderRequestRef.current !== undefined) {
      cancelAnimationFrame(renderRequestRef.current);
      renderRequestRef.current = undefined;
    }
    renderDirtyRef.current = false;
    render();
  }, [render]);

  useEffect(() => {
    renderRef.current = renderNow;
  }, [renderNow]);

  useEffect(() => {
    const gl = glRef.current;
    const program = programRef.current;
    const colorMapTexture = colorMapTextureRef.current;
    if (!gl || !program || !colorMapTexture || gl.isContextLost()) {
      return;
    }

    uploadColorMapTexture(gl, colorMapTexture, colorMap);
    applyThemeCurveUniforms(gl, program, themeCurve);
    scheduleRender();
  }, [applyThemeCurveUniforms, colorMap, scheduleRender, themeCurve, uploadColorMapTexture]);

  useEffect(() => {
    const gl = glRef.current;
    if (!gl || gl.isContextLost()) {
      return;
    }
    gl.activeTexture(gl.TEXTURE0);
    applySpectrumTextureFilter(gl, textureRef.current, sharpPixels);
    gl.activeTexture(gl.TEXTURE2);
    applySpectrumTextureFilter(gl, transitionTextureRef.current, sharpPixels);
    gl.activeTexture(gl.TEXTURE3);
    applySpectrumTextureFilter(gl, supplementTextureRef.current, sharpPixels);
    gl.activeTexture(gl.TEXTURE0);
    scheduleRender();
  }, [applySpectrumTextureFilter, scheduleRender, sharpPixels]);

  const updateViewState = useCallback((nextAxis: SpectrumAxis | null, hasData: boolean) => {
    currentAxisRef.current = nextAxis;
    if (viewStateRef.current.hasData === hasData && areAxesEqual(viewStateRef.current.axis, nextAxis)) {
      return;
    }
    const nextViewState = {
      axis: nextAxis,
      hasData,
    };
    viewStateRef.current = nextViewState;
    setViewState(nextViewState);
  }, []);

  const updateActualRangeState = useCallback((range: { min: number; max: number } | null) => {
    if (range === null) {
      if (actualRangeRef.current !== null) {
        actualRangeRef.current = null;
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
    // Most TCI frames arrive already projected to the texture width. Avoid
    // the general min/max downsampling loop in that common case.
    if (row.length === width) {
      for (let x = 0; x < width; x += 1) {
        const normalizedValue = (Number(row[x]) - rangeMin) * rangeScale;
        target[start + x] = Math.max(0, Math.min(255, Math.floor(normalizedValue)));
      }
      return;
    }
    for (let x = 0; x < width; x += 1) {
      const sourceStart = Math.floor((x * row.length) / width);
      const sourceEnd = Math.max(sourceStart + 1, Math.ceil(((x + 1) * row.length) / width));
      let maxValue = -Infinity;
      for (let sourceIndex = sourceStart; sourceIndex < Math.min(sourceEnd, row.length); sourceIndex += 1) {
        maxValue = Math.max(maxValue, Number(row[sourceIndex]));
      }
      const normalizedValue = (maxValue - rangeMin) * rangeScale;
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
    ensureProgramBound(gl, program);
    if (headRowLocationRef.current) {
      gl.uniform1f(headRowLocationRef.current, headRow);
    }
    if (textureHeightLocationRef.current) {
      gl.uniform1f(textureHeightLocationRef.current, textureHeight);
    }
  }, [ensureProgramBound]);

  const updateCurrentAxisUniform = useCallback((nextAxis: SpectrumAxis | null) => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost() || !currentAxisLocationRef.current || !nextAxis) {
      return;
    }

    ensureProgramBound(gl, program);
    gl.uniform2f(currentAxisLocationRef.current, nextAxis.minHz, nextAxis.maxHz);
    // Outside of an active gesture the view axis tracks the texture axis
    // (identity mapping). A rebuild mid-gesture keeps the gesture view axis.
    const heldViewAxis = gestureViewAxisRef.current ?? committedViewAxisOverrideRef.current;
    if (viewAxisLocationRef.current) {
      gl.uniform2f(
        viewAxisLocationRef.current,
        heldViewAxis?.min ?? nextAxis.minHz,
        heldViewAxis?.max ?? nextAxis.maxHz,
      );
    }
  }, [ensureProgramBound]);

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

    ensureProgramBound(gl, program);
    if (axisTransitionActiveLocationRef.current) {
      gl.uniform1i(axisTransitionActiveLocationRef.current, 0);
    }
    if (axisTransitionProgressLocationRef.current) {
      gl.uniform1f(axisTransitionProgressLocationRef.current, 1);
    }
    if (shouldRender) {
      scheduleRender();
    }
  }, [ensureProgramBound, scheduleRender]);

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
    // Allocation metadata follows the texture object, not the role it plays
    // in the shader. The newly promoted texture may still be a 1x1 placeholder
    // (or have a different size), so force the next rebuild down the
    // texImage2D allocation path instead of issuing an invalid sub upload.
    textureAllocatedWidthRef.current = 0;
    textureAllocatedHeightRef.current = 0;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, transitionTexture);

    ensureProgramBound(gl, program);
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
  }, [ensureProgramBound]);

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
    ensureProgramBound(gl, program);
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
      ensureProgramBound(currentGl, currentProgram);
      if (axisTransitionProgressLocationRef.current) {
        currentGl.uniform1f(axisTransitionProgressLocationRef.current, easedProgress);
      }
      renderNow();

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
    };

    axisTransitionAnimRef.current = requestAnimationFrame(animate);
  }, [ensureProgramBound, prepareAxisTransitionTexture, renderNow, stopAxisTransition, updateCurrentAxisUniform]);

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

  const updateSupplementTextureMetadata = useCallback((textureHeight: number, headRow: number) => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost()) {
      return;
    }
    ensureProgramBound(gl, program);
    if (supplementHeadRowLocationRef.current) {
      gl.uniform1f(supplementHeadRowLocationRef.current, headRow);
    }
    if (supplementTextureHeightLocationRef.current) {
      gl.uniform1f(supplementTextureHeightLocationRef.current, textureHeight);
    }
  }, [ensureProgramBound]);

  const updateSupplementAxisUniform = useCallback((axis: SpectrumAxis | null) => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost()) {
      return;
    }
    ensureProgramBound(gl, program);
    const enabled = axis && axis.binCount > 0 && supplementRowCountRef.current > 0;
    if (supplementEnabledLocationRef.current) {
      gl.uniform1i(supplementEnabledLocationRef.current, enabled ? 1 : 0);
    }
    if (axis && supplementAxisLocationRef.current) {
      gl.uniform2f(supplementAxisLocationRef.current, axis.minHz, axis.maxHz);
    }
  }, [ensureProgramBound]);

  const rebuildTexture = useCallback((spectrumData: ArrayLike<number>[], nextAxis: SpectrumAxis | null) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    const sourceWidth = nextAxis?.binCount ?? spectrumData[0]?.length ?? 0;

    if (!gl || !texture || !program || gl.isContextLost() || sourceWidth <= 0) {
      return;
    }
    updateCurrentAxisUniform(nextAxis);

    const canvasHeight = canvasRef.current?.height ?? 0;
    const textureHeight = Math.max(1, totalRows ?? canvasHeight ?? 1);
    const visibleSpectrumData = spectrumData.slice(0, textureHeight);
    const actualHeight = visibleSpectrumData.length;
    const width = Math.min(sourceWidth, maxTextureSizeRef.current);
    const dataSize = width * textureHeight;
    const textureData = ensureWaterfallUploadBuffer(uploadBufferRef.current, width, textureHeight);
    uploadBufferRef.current = textureData;
    // The persistent buffer may contain rows from a previous, taller batch.
    // Clear only the upload rectangle; otherwise stale history can leak into
    // the newly allocated texture when the stream is re-primed.
    textureData.fill(0, 0, dataSize);

    let currentMin = minDb;
    let currentMax = maxDb;

    if (autoRange && actualHeight > 0) {
      const range = calculateDataRange(visibleSpectrumData);
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
        writeNormalizedRow(textureData, y, visibleSpectrumData[y], width, segment.rangeMin, segment.rangeScale);
      }
      rowOffset = segmentEnd;
      if (rowOffset >= actualHeight) {
        break;
      }
    }

    for (let y = rowOffset; y < actualHeight; y += 1) {
      writeNormalizedRow(textureData, y, visibleSpectrumData[y], width, currentMin, fallbackScale);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const uploadData = textureData.subarray(0, dataSize);
    if (
      textureAllocatedWidthRef.current === width
      && textureAllocatedHeightRef.current === textureHeight
    ) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        textureHeight,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        uploadData,
      );
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, textureHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, uploadData);
      textureAllocatedWidthRef.current = width;
      textureAllocatedHeightRef.current = textureHeight;
    }
    lastDataLengthRef.current = dataSize;
    textureWidthRef.current = width;
    // Keep the semantic axis metadata (including the source bin count) for
    // equality checks; the physical upload width is tracked independently by
    // textureWidthRef because MAX_TEXTURE_SIZE may clamp it.
    textureAxisRef.current = nextAxis ? { ...nextAxis } : null;

    rowCountRef.current = actualHeight;
    updateTextureMetadata(textureHeight, 0);

    // Rebuild the supplement ring texture from the retained wide-envelope
    // rows, reusing the same normalization segments so both textures share
    // one color scale. Rows have already been projected to the retained
    // supplement axis by processRenderBatch when the DDS center moves.
    const supplementTexture = supplementTextureRef.current;
    const supplementAxis = supplementAxisRef.current;
    const supplementRows = displaySupplementRowsRef.current.slice(0, textureHeight);
    const supplementWidth = supplementAxis ? Math.min(supplementAxis.binCount, maxTextureSizeRef.current) : 0;
    if (supplementTexture && supplementAxis && supplementWidth > 0 && supplementRows.length > 0) {
      const supplementData = ensureWaterfallUploadBuffer(supplementUploadBufferRef.current, supplementWidth, textureHeight);
      supplementUploadBufferRef.current = supplementData;
      // Missing rows and frames without a supplement render as the
      // colormap minimum.
      supplementData.fill(0, 0, supplementWidth * textureHeight);

      let supplementRowOffset = 0;
      for (const segment of segments) {
        const segmentEnd = Math.min(supplementRowOffset + segment.rowCount, supplementRows.length);
        for (let y = supplementRowOffset; y < segmentEnd; y += 1) {
          const row = supplementRows[y];
          if (row) {
            writeNormalizedRow(supplementData, y, row, supplementWidth, segment.rangeMin, segment.rangeScale);
          }
        }
        supplementRowOffset = segmentEnd;
        if (supplementRowOffset >= supplementRows.length) {
          break;
        }
      }
      for (let y = supplementRowOffset; y < supplementRows.length; y += 1) {
        const row = supplementRows[y];
        if (row) {
          writeNormalizedRow(supplementData, y, row, supplementWidth, currentMin, fallbackScale);
        }
      }

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, supplementTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const supplementUploadData = supplementData.subarray(0, supplementWidth * textureHeight);
      if (
        supplementAllocatedWidthRef.current === supplementWidth
        && supplementAllocatedHeightRef.current === textureHeight
      ) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          supplementWidth,
          textureHeight,
          gl.LUMINANCE,
          gl.UNSIGNED_BYTE,
          supplementUploadData,
        );
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, supplementWidth, textureHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, supplementUploadData);
        supplementAllocatedWidthRef.current = supplementWidth;
        supplementAllocatedHeightRef.current = textureHeight;
      }
      gl.activeTexture(gl.TEXTURE0);
      supplementRowCountRef.current = supplementRows.length;
      supplementHeadRowRef.current = 0;
      updateSupplementTextureMetadata(textureHeight, 0);
      updateSupplementAxisUniform(supplementAxis);
    } else {
      supplementRowCountRef.current = 0;
      supplementHeadRowRef.current = 0;
      updateSupplementAxisUniform(null);
    }
  }, [
    autoRange,
    buildSegments,
    calculateDataRange,
    minDb,
    maxDb,
    totalRows,
    updateCurrentAxisUniform,
    updateActualRangeState,
    updateSupplementAxisUniform,
    updateSupplementTextureMetadata,
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
    const supplementTexture = supplementTextureRef.current;
    const program = programRef.current;
    releaseWaterfallTextureMemoryRefs({
      scratchRowRef,
      uploadBufferRef,
      supplementScratchRowRef,
      supplementUploadBufferRef,
      textureAllocatedWidthRef,
      textureAllocatedHeightRef,
      supplementAllocatedWidthRef,
      supplementAllocatedHeightRef,
      textureAxisRef,
      lastDataLengthRef,
      textureHeightRef,
      rowCountRef,
      headRowRef,
    });
    supplementHeadRowRef.current = 0;
    supplementRowCountRef.current = 0;

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
    if (supplementTexture) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, supplementTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1));
      gl.activeTexture(gl.TEXTURE0);
    }

    if (program) {
      ensureProgramBound(gl, program);
    }
    if (program && scrollRowsLocationRef.current) {
      gl.uniform1f(scrollRowsLocationRef.current, 0);
    }
    if (program && axisTransitionActiveLocationRef.current) {
      gl.uniform1i(axisTransitionActiveLocationRef.current, 0);
    }
    if (program && axisTransitionProgressLocationRef.current) {
      gl.uniform1f(axisTransitionProgressLocationRef.current, 1);
    }
    if (program && headRowLocationRef.current) {
      gl.uniform1f(headRowLocationRef.current, 0);
    }
    if (program && textureHeightLocationRef.current) {
      gl.uniform1f(textureHeightLocationRef.current, 1);
    }
    if (program && supplementEnabledLocationRef.current) {
      gl.uniform1i(supplementEnabledLocationRef.current, 0);
    }
    if (program && supplementHeadRowLocationRef.current) {
      gl.uniform1f(supplementHeadRowLocationRef.current, 0);
    }
    if (program && supplementTextureHeightLocationRef.current) {
      gl.uniform1f(supplementTextureHeightLocationRef.current, 1);
    }
    if (shouldRender) {
      scheduleRender();
    }
  }, [ensureProgramBound, scheduleRender]);

  const appendRowsToTexture = useCallback((
    rowsToAppend: ArrayLike<number>[],
    nextAxis: SpectrumAxis | null,
    supplementRowsToAppend: (Float32Array | null)[] = [],
    supplementAxisChanged = false,
  ) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    const sourceWidth = nextAxis?.binCount ?? rowsToAppend[rowsToAppend.length - 1]?.length ?? 0;

    if (!gl || !texture || !program || gl.isContextLost() || sourceWidth <= 0 || rowsToAppend.length === 0) {
      return;
    }
    updateCurrentAxisUniform(nextAxis);

    const spectrumData = displayRowsRef.current;
    const actualHeight = spectrumData.length;
    const previousTextureHeight = textureHeightRef.current;
    const textureHeight = Math.max(1, totalRows ?? canvasRef.current?.height ?? 1);
    const width = Math.min(sourceWidth, maxTextureSizeRef.current);
    const previousTextureWidth = textureWidthRef.current;
    const textureAxisChanged = !areAxesEqual(textureAxisRef.current, nextAxis);

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

    if (
      txModeChanged
      || rangeChanged
      || previousTextureHeight !== textureHeight
      || previousTextureWidth !== width
      || rowCountRef.current === 0
      || textureAxisChanged
      || supplementAxisChanged
    ) {
      rebuildTexture(spectrumData, nextAxis);
      return;
    }

    const rangeScale = currentMax > currentMin ? 255 / (currentMax - currentMin) : 1;
    // Pack a batch in newest-to-oldest order and upload at most two
    // contiguous ring segments. The previous implementation issued one
    // texSubImage2D call per row, which is disproportionately expensive when
    // the controller catches up after a dropped frame.
    const rowCount = Math.min(rowsToAppend.length, textureHeight);
    const sourceOffset = rowsToAppend.length - rowCount;
    const packed = ensureWaterfallUploadBuffer(uploadBufferRef.current, width, rowCount);
    uploadBufferRef.current = packed;
    for (let packedRow = 0; packedRow < rowCount; packedRow += 1) {
      const sourceRow = rowsToAppend[sourceOffset + rowCount - 1 - packedRow];
      writeNormalizedRow(packed, packedRow, sourceRow, width, currentMin, rangeScale);
    }

    const previousHeadRow = headRowRef.current;
    const headRow = (previousHeadRow - rowCount + textureHeight) % textureHeight;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const firstSegmentRows = Math.min(rowCount, textureHeight - headRow);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      headRow,
      width,
      firstSegmentRows,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      packed.subarray(0, firstSegmentRows * width),
    );
    const wrappedRows = rowCount - firstSegmentRows;
    if (wrappedRows > 0) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        wrappedRows,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        packed.subarray(firstSegmentRows * width, rowCount * width),
      );
    }

    rowCountRef.current = Math.min(textureHeight, rowCountRef.current + rowsToAppend.length);
    updateTextureMetadata(textureHeight, headRow);

    // Mirror the append into the supplement ring texture so both stay
    // row-aligned in time; frames without a supplement upload as the
    // colormap minimum.
    const supplementTexture = supplementTextureRef.current;
    const supplementAxis = supplementAxisRef.current;
    const supplementWidth = supplementAxis ? Math.min(supplementAxis.binCount, maxTextureSizeRef.current) : 0;
    if (supplementTexture && supplementAxis && supplementWidth > 0 && supplementRowsToAppend.length > 0) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, supplementTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const supplementRowCount = Math.min(supplementRowsToAppend.length, textureHeight);
      const supplementSourceOffset = supplementRowsToAppend.length - supplementRowCount;
      const supplementPacked = ensureWaterfallUploadBuffer(
        supplementUploadBufferRef.current,
        supplementWidth,
        supplementRowCount,
      );
      supplementUploadBufferRef.current = supplementPacked;
      for (let packedRow = 0; packedRow < supplementRowCount; packedRow += 1) {
        const sourceRow = supplementRowsToAppend[supplementSourceOffset + supplementRowCount - 1 - packedRow];
        if (sourceRow) {
          writeNormalizedRow(supplementPacked, packedRow, sourceRow, supplementWidth, currentMin, rangeScale);
        } else {
          supplementPacked.fill(0, packedRow * supplementWidth, (packedRow + 1) * supplementWidth);
        }
      }
      const previousSupplementHead = supplementHeadRowRef.current;
      const supplementHeadRow = (previousSupplementHead - supplementRowCount + textureHeight) % textureHeight;
      const firstSupplementRows = Math.min(supplementRowCount, textureHeight - supplementHeadRow);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        supplementHeadRow,
        supplementWidth,
        firstSupplementRows,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        supplementPacked.subarray(0, firstSupplementRows * supplementWidth),
      );
      const wrappedSupplementRows = supplementRowCount - firstSupplementRows;
      if (wrappedSupplementRows > 0) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          supplementWidth,
          wrappedSupplementRows,
          gl.LUMINANCE,
          gl.UNSIGNED_BYTE,
          supplementPacked.subarray(firstSupplementRows * supplementWidth, supplementRowCount * supplementWidth),
        );
      }
      gl.activeTexture(gl.TEXTURE0);
      supplementHeadRowRef.current = supplementHeadRow;
      supplementRowCountRef.current = Math.min(textureHeight, supplementRowCountRef.current + supplementRowCount);
      updateSupplementTextureMetadata(textureHeight, supplementHeadRow);
      updateSupplementAxisUniform(supplementAxis);
    }
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
    updateSupplementAxisUniform,
    updateSupplementTextureMetadata,
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
    containerMetricsRef.current = {
      left: containerRect.left,
      width: containerRect.width,
    };
    const pixelRatio = getWaterfallCanvasPixelRatio(window.devicePixelRatio);
    setRulerWidthPx(current => (
      Math.abs(current - containerRect.width) < 0.5 ? current : containerRect.width
    ));

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
      ensureProgramBound(gl, program);

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

      if (displayRowsRef.current.length > 0 && currentAxisRef.current) {
        rebuildTextureRef.current(displayRowsRef.current, currentAxisRef.current);
      }
      
      // 立即重新渲染
      scheduleRender();
    }
  }, [ensureProgramBound, scheduleRender]);

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
      boundProgramRef.current = null;
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
      if (renderRequestRef.current !== undefined) {
        cancelAnimationFrame(renderRequestRef.current);
        renderRequestRef.current = undefined;
      }
      renderDirtyRef.current = false;
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
      if (gestureRafRef.current !== undefined) {
        cancelAnimationFrame(gestureRafRef.current);
        gestureRafRef.current = undefined;
      }
      if (hoverRafRef.current !== undefined) {
        cancelAnimationFrame(hoverRafRef.current);
        hoverRafRef.current = undefined;
      }
      hoverPointerRef.current = null;
      if (gestureCommitTimerRef.current) {
        clearTimeout(gestureCommitTimerRef.current);
        gestureCommitTimerRef.current = null;
      }
      gestureViewAxisRef.current = null;
      clearCommittedViewAxisOverride();
      clearOverlayAxisTransition();
      pendingGestureRangeRef.current = null;
      controller.setGestureViewFreeze(false);
      // 释放 WebGL 资源，防止泄漏
      const gl = glRef.current;
      if (gl) {
        releaseTextureStorage(false);
        if (programRef.current) { gl.deleteProgram(programRef.current); programRef.current = null; }
        if (textureRef.current) { gl.deleteTexture(textureRef.current); textureRef.current = null; }
        if (transitionTextureRef.current) { gl.deleteTexture(transitionTextureRef.current); transitionTextureRef.current = null; }
        if (supplementTextureRef.current) { gl.deleteTexture(supplementTextureRef.current); supplementTextureRef.current = null; }
        if (colorMapTextureRef.current) { gl.deleteTexture(colorMapTextureRef.current); colorMapTextureRef.current = null; }
        if (positionBufferRef.current) { gl.deleteBuffer(positionBufferRef.current); positionBufferRef.current = null; }
        if (texCoordBufferRef.current) { gl.deleteBuffer(texCoordBufferRef.current); texCoordBufferRef.current = null; }
        try {
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch (error) {
          logger.debug('WEBGL_lose_context cleanup failed', error);
        }
        glRef.current = null;
        boundProgramRef.current = null;
      }
    };
  }, [clearCommittedViewAxisOverride, clearOverlayAxisTransition, controller, initWebGL, releaseTextureStorage]);

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
      displaySupplementRowsRef.current = [];
      supplementAxisRef.current = null;
      rowCountRef.current = 0;
      headRowRef.current = 0;
      lastAnimatedFrameTokenRef.current = null;
      gestureViewAxisRef.current = null;
      clearCommittedViewAxisOverride();
      pendingGestureRangeRef.current = null;
      controller.setGestureViewFreeze(false);
      clearGestureOverlays();
      applyCycleMarkerScrollOffset(0);
      clearCycleMarkers();
      updateViewState(null, false);
      resetAutoRangeState();
      releaseTextureStorage();
      return;
    }

    const nextAxis = batch.axis;
    const maxRows = totalRows ?? WATERFALL_MAX_HISTORY_ROWS;
    if (batch.mode === 'replace') {
      const previousAxis = currentAxisRef.current;
      if (
        batch.axisTransition === 'animate'
        && previousAxis
        && displayRowsRef.current.length > 0
      ) {
        animateOverlayAxisTransition(calculateSpectrumAxisTransitionDuration(previousAxis, nextAxis));
      } else {
        clearOverlayAxisTransition();
      }
      if (
        batch.axisTransition !== 'immediate'
        && displayRowsRef.current.length > 0
        && previousAxis
        && !areAxesEqual(previousAxis, nextAxis)
      ) {
        startAxisTransition(previousAxis, nextAxis);
      } else {
        stopAxisTransition(false);
        updateCurrentAxisUniform(nextAxis);
      }

      displayRowsRef.current = batch.rows.slice(0, maxRows);
      displayRowTimestampsRef.current = batch.rowTimestamps.slice(0, maxRows);
      displaySupplementRowsRef.current = (batch.supplementRows ?? batch.rows.map(() => null)).slice(0, maxRows);
      supplementAxisRef.current = batch.supplementAxis ?? null;
      rowCountRef.current = displayRowsRef.current.length;
      headRowRef.current = 0;
      lastAnimatedFrameTokenRef.current = batch.frameToken;
      refreshCycleMarkers(displayRowTimestampsRef.current);
      rebuildTexture(displayRowsRef.current, nextAxis);
      updateViewState(nextAxis, true);
      // The texture now matches the committed axis and React re-renders the
      // overlays in the same batch, so the gesture overlays are released
      // here. During an active gesture the next preview frame reapplies
      // them against the new texture axis.
      if (!gestureViewAxisRef.current) {
        clearCommittedViewAxisOverride();
        updateCurrentAxisUniform(nextAxis);
        clearGestureOverlays();
      }

      const gl = glRef.current;
      const program = programRef.current;
      if (gl && program && !gl.isContextLost() && scrollRowsLocationRef.current) {
        ensureProgramBound(gl, program);
        gl.uniform1f(scrollRowsLocationRef.current, 0);
      }
      applyCycleMarkerScrollOffset(0);
      scheduleRender();
      return;
    }

    const batchSupplementRows = batch.supplementRows ?? batch.rows.map(() => null);
    const alignedSupplementRows = batchSupplementRows.length === batch.rows.length
      ? batchSupplementRows
      : batch.rows.map((_, index) => batchSupplementRows[index] ?? null);
    const nextSupplementAxis = batch.supplementAxis ?? null;
    const retainedSupplementAxis = supplementAxisRef.current;
    let supplementRowsForAppend: (Float32Array | null)[] = alignedSupplementRows;
    let supplementAxisChanged = false;

    if (nextSupplementAxis && !retainedSupplementAxis) {
      // The first wide preview allocates the secondary ring texture. Later
      // rows are projected into this stable axis so a moving DDS center does
      // not force a full history rebuild on every frame.
      supplementAxisRef.current = nextSupplementAxis;
      supplementAxisChanged = true;
    } else if (nextSupplementAxis && retainedSupplementAxis && !areAxesEqual(retainedSupplementAxis, nextSupplementAxis)) {
      const retainedRange = { min: retainedSupplementAxis.minHz, max: retainedSupplementAxis.maxHz };
      const incomingRange = { min: nextSupplementAxis.minHz, max: nextSupplementAxis.maxHz };
      const overlap = Math.max(
        0,
        Math.min(retainedRange.max, incomingRange.max) - Math.max(retainedRange.min, incomingRange.min),
      );
      const incomingSpan = Math.max(incomingRange.max - incomingRange.min, 1);
      if (overlap < incomingSpan * WATERFALL_SUPPLEMENT_REBASE_OVERLAP_RATIO) {
        // Once the incoming envelope has moved mostly outside the retained
        // one, rebase the supplement axis once. This bounds interpolation
        // error during a long edge-tune without returning to per-frame full
        // texture rebuilds.
        displaySupplementRowsRef.current = displaySupplementRowsRef.current.map((row) => row
          ? cropSpectrumToRange(row, retainedRange, incomingRange, minDbRef.current)
          : null);
        supplementAxisRef.current = nextSupplementAxis;
        supplementAxisChanged = true;
      } else {
        supplementRowsForAppend = alignedSupplementRows.map((row) => row
          ? cropSpectrumToRange(
              row,
              incomingRange,
              retainedRange,
              minDbRef.current,
            )
          : null);
      }
    }

    // The controller caps a catch-up batch at eight rows. Prepending the
    // batch in one operation avoids repeatedly shifting the retained history
    // array for each row.
    displayRowsRef.current.unshift(...batch.rows);
    displayRowTimestampsRef.current.unshift(...batch.rowTimestamps);
    displaySupplementRowsRef.current.unshift(...supplementRowsForAppend);
    if (displayRowsRef.current.length > maxRows) {
      displayRowsRef.current.length = maxRows;
    }
    if (displayRowTimestampsRef.current.length > maxRows) {
      displayRowTimestampsRef.current.length = maxRows;
    }
    if (displaySupplementRowsRef.current.length > maxRows) {
      displaySupplementRowsRef.current.length = maxRows;
    }
    refreshCycleMarkers(displayRowTimestampsRef.current);

    appendRowsToTexture(batch.rows, nextAxis, supplementRowsForAppend, supplementAxisChanged);
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
      ensureProgramBound(gl, program);
      gl.uniform1f(scrollRowsLocationRef.current, 0);
      applyCycleMarkerScrollOffset(0);
      scheduleRender();
      return;
    }

    const now = performance.now();

    const startRows = Math.min(batch.rows.length, Math.max(rowCountRef.current, 1));
    const animDuration = getWaterfallScrollAnimationDurationMs(frameIntervalMs, startRows);
    const animStartTime = now;

    ensureProgramBound(gl, program);
    gl.uniform1f(scrollRowsLocationRef.current, startRows);
    applyCycleMarkerScrollOffset(startRows);

    const animate = () => {
      const elapsed = performance.now() - animStartTime;
      const progress = Math.min(1, elapsed / animDuration);
      const eased = easeSpectrumAxisTransition(progress);
      const offset = startRows * (1 - eased);

      const currentGl = glRef.current;
      const currentProgram = programRef.current;
      if (currentGl && currentProgram && !currentGl.isContextLost() && scrollRowsLocationRef.current) {
        ensureProgramBound(currentGl, currentProgram);
        currentGl.uniform1f(scrollRowsLocationRef.current, offset);
        applyCycleMarkerScrollOffset(offset);
        renderNow();
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
    clearGestureOverlays,
    clearCycleMarkers,
    clearCommittedViewAxisOverride,
    clearOverlayAxisTransition,
    controller,
    ensureProgramBound,
    refreshCycleMarkers,
    releaseTextureStorage,
    rebuildTexture,
    renderNow,
    scheduleRender,
    frameIntervalMs,
    resetAutoRangeState,
    startAxisTransition,
    animateOverlayAxisTransition,
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
    controller.setRenderRowLimit(totalRows ?? null);
    // A larger window needs more historical rows to preserve one texture row
    // per rendered pixel. The controller retains the bounded history
    // independently; priming on resize makes already-received rows immediately
    // available instead of waiting for new frames.
    processRenderBatchRef.current(controller.primeRenderBatch());

    const handleFrameTick = () => {
      processRenderBatchRef.current(controller.consumeRenderBatch());
    };

    const unsubscribe = controller.subscribeFrameTick(handleFrameTick);
    return () => {
      unsubscribe();
      controller.setRenderRowLimit(null, { schedule: false });
    };
  }, [controller, totalRows]);

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

    ensureProgramBound(gl, program);
    if (minDbLocationRef.current) {
      gl.uniform1f(minDbLocationRef.current, minDb);
    }
    if (maxDbLocationRef.current) {
      gl.uniform1f(maxDbLocationRef.current, maxDb);
    }

    if (displayRowsRef.current.length > 0 && currentAxisRef.current) {
      rebuildTexture(displayRowsRef.current, currentAxisRef.current);
    }
    scheduleRender();
  }, [ensureProgramBound, minDb, maxDb, rebuildTexture, scheduleRender]);

  useEffect(() => {
    if (!displayRowsRef.current.length || !currentAxisRef.current) {
      return;
    }
    rebuildTexture(displayRowsRef.current, currentAxisRef.current);
    scheduleRender();
  }, [
    autoRange,
    autoRangeConfig.updateInterval,
    autoRangeConfig.minPercentile,
    autoRangeConfig.maxPercentile,
    autoRangeConfig.rangeExpansionFactor,
    rebuildTexture,
    scheduleRender,
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

  const FREQ_POSITION_OFFSET = visualFrequencyOffsetHz;
  const isAbsoluteDisplayMode = frequencyRangeMode === 'absolute-center' || frequencyRangeMode === 'absolute-fixed';
  const isAbsoluteWindowedMode = frequencyRangeMode === 'absolute-windowed';
  const minFrequency = axis?.minHz ?? 0;
  const maxFrequency = axis?.maxHz ?? 0;
  const hasAxis = Boolean(axis && axis.binCount > 0 && maxFrequency > minFrequency);
  const rulerTicks = React.useMemo(
    () => (!markerOnly && hasAxis
      ? buildWaterfallRulerTicks(minFrequency, maxFrequency, rulerWidthPx, FREQ_POSITION_OFFSET, frequencyAxisTransform)
      : []),
    [FREQ_POSITION_OFFSET, frequencyAxisTransform, hasAxis, markerOnly, maxFrequency, minFrequency, rulerWidthPx],
  );
  const showHoverProbe = Boolean(
    !markerOnly
    && hasAxis
    && hoverCursor
    && !frequencyGestureDragState
    && !draggingFrequencyBandOverlay
    && !draggingOperatorId
    && !draggingBandOverlayId
  );
  const hoverProbePositionPercent = hoverCursor ? hoverCursor.ratio * 100 : 0;
  const hoverProbeLabel = hoverCursor ? formatWaterfallHoverFrequency(hoverCursor.frequency) : '';
  const hoverProbePortalPosition = React.useMemo(() => {
    if (!showHoverProbe || !hoverCursor || typeof window === 'undefined') {
      return null;
    }

    const viewportWidth = window.innerWidth;
    return {
      left: getWaterfallHoverLabelLeftPx((hoverCursor.clientX / Math.max(viewportWidth, 1)) * 100, viewportWidth),
      top: Math.max(4, hoverCursor.containerTop - 24),
    };
  }, [hoverCursor, showHoverProbe]);

  const updateHoverCursorFromPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Coalesce pointermove bursts into one React update per animation frame.
    hoverPointerRef.current = { clientX: event.clientX, pointerType: event.pointerType };
    if (hoverRafRef.current !== undefined) {
      return;
    }
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = undefined;
      const pointer = hoverPointerRef.current;
      if (markerOnly || !hasAxis || !pointer || (pointer.pointerType !== 'mouse' && pointer.pointerType !== 'pen')) {
        setHoverCursor(null);
        return;
      }

      const container = containerRef.current;
      if (!container) {
        setHoverCursor(null);
        return;
      }

      const rect = container.getBoundingClientRect();
      containerMetricsRef.current = { left: rect.left, width: rect.width };
      if (rect.width <= 0) {
        setHoverCursor(null);
        return;
      }

      const ratio = Math.max(0, Math.min(1, (pointer.clientX - rect.left) / rect.width));
      // During a viewport gesture the displayed range is the GPU-side view
      // axis, not the committed texture axis — read the hover frequency
      // from the gesture range so the probe label matches what is shown.
      const gestureRange = gestureViewAxisRef.current;
      const hoverMin = gestureRange ? gestureRange.min : minFrequency;
      const hoverMax = gestureRange ? gestureRange.max : maxFrequency;
      setHoverCursor({
        ratio,
        frequency: getWaterfallSemanticFrequencyAtRatio(ratio, hoverMin, hoverMax, frequencyAxisTransform, FREQ_POSITION_OFFSET),
        clientX: pointer.clientX,
        containerTop: rect.top,
      });
    });
  }, [FREQ_POSITION_OFFSET, frequencyAxisTransform, hasAxis, markerOnly, maxFrequency, minFrequency]);

  const clearHoverCursor = useCallback(() => {
    hoverPointerRef.current = null;
    if (hoverRafRef.current !== undefined) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = undefined;
    }
    setHoverCursor(null);
  }, []);

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

  const readContainerHorizontalMetrics = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    const cached = containerMetricsRef.current;
    if (cached.width > 0) return cached;
    const rect = container.getBoundingClientRect();
    const metrics = { left: rect.left, width: rect.width };
    containerMetricsRef.current = metrics;
    return metrics;
  }, []);

  // 计算语义频率到未变形频谱图位置的百分比
  const getFrequencyPosition = useCallback((displayFrequency: number, visualOffsetHz = FREQ_POSITION_OFFSET) => {
    if (!hasAxis) return 0;
    return getWaterfallSemanticFrequencyPositionPercent(
      displayFrequency,
      minFrequency,
      maxFrequency,
      frequencyAxisTransform,
      visualOffsetHz,
    );
  }, [FREQ_POSITION_OFFSET, frequencyAxisTransform, hasAxis, maxFrequency, minFrequency]);

  const getMarkerPosition = useCallback((basebandFrequency: number) => {
    const displayFrequency = getDisplayFrequency(basebandFrequency);
    if (displayFrequency === null) return null;

    const position = getFrequencyPosition(displayFrequency);
    if (
      !Number.isFinite(position)
      || position < -WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT
      || position > 100 + WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT
    ) {
      return null;
    }

    return position;
  }, [getDisplayFrequency, getFrequencyPosition]);

  // 从鼠标位置计算频率
  const getFrequencyFromMousePosition = useCallback((clientX: number, visualOffsetHz = FREQ_POSITION_OFFSET) => {
    const metrics = readContainerHorizontalMetrics();
    if (!metrics || !hasAxis || metrics.width <= 0) return 0;

    const relativeX = clientX - metrics.left;
    const percentage = Math.max(0, Math.min(1, relativeX / metrics.width));
    const gestureRange = gestureViewAxisRef.current;
    const interactionMin = gestureRange?.min ?? minFrequency;
    const interactionMax = gestureRange?.max ?? maxFrequency;

    const displayFrequency = getWaterfallSemanticFrequencyAtRatio(
      percentage,
      interactionMin,
      interactionMax,
      frequencyAxisTransform,
      visualOffsetHz,
    );
    const basebandFrequency = isAbsoluteDisplayMode
      ? displayFrequency - (referenceFrequencyHz ?? minFrequency)
      : displayFrequency;

    return clampBasebandFrequency(basebandFrequency);
  }, [FREQ_POSITION_OFFSET, clampBasebandFrequency, frequencyAxisTransform, hasAxis, isAbsoluteDisplayMode, maxFrequency, minFrequency, readContainerHorizontalMetrics, referenceFrequencyHz]);

  const getInteractionFrequencyFromMousePosition = useCallback((clientX: number, visualOffsetHz = FREQ_POSITION_OFFSET, stepHz?: number | null) => {
    const metrics = readContainerHorizontalMetrics();
    if (!metrics || !hasAxis || metrics.width <= 0) return 0;

    const relativeX = clientX - metrics.left;
    const percentage = Math.max(0, Math.min(1, relativeX / metrics.width));
    const gestureRange = gestureViewAxisRef.current;
    const interactionMin = gestureRange?.min ?? minFrequency;
    const interactionMax = gestureRange?.max ?? maxFrequency;
    const displayFrequency = getWaterfallSemanticFrequencyAtRatio(
      percentage,
      interactionMin,
      interactionMax,
      frequencyAxisTransform,
      visualOffsetHz,
    );

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
    FREQ_POSITION_OFFSET,
    frequencyAxisTransform,
    hasAxis,
    interactionFrequencyMode,
    isAbsoluteDisplayMode,
    maxFrequency,
    minFrequency,
    readContainerHorizontalMetrics,
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
        getWaterfallFrequencyAfterVisualDelta(
          dragState.startCenterFrequency,
          deltaHz,
          frequencyAxisTransform,
          FREQ_POSITION_OFFSET,
        ),
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
  }, [FREQ_POSITION_OFFSET, frequencyAxisTransform, getInteractionFrequencyFromMousePosition, snapBandValue]);

  // Keep the latest viewport-change callback reachable from timer/rAF
  // callbacks without re-registering listeners.
  useEffect(() => {
    gestureChangeRef.current = effectiveLocalViewportChange ?? null;
  }, [effectiveLocalViewportChange]);

  const updateGestureRuler = useCallback((range: InteractionFrequencyRange) => {
    const layer = gestureRulerLayerRef.current;
    const widthPx = gestureLayerWidthRef.current > 0
      ? gestureLayerWidthRef.current
      : (containerRef.current?.clientWidth ?? 0);
    if (!layer || widthPx <= 0) {
      return;
    }
    const previousRange = gestureRulerRangeRef.current;
    if (previousRange) {
      const span = Math.max(range.max - range.min, 1);
      // A sub-pixel movement does not change the readable ruler. Skip the
      // allocation/tick walk until the gesture has moved far enough to be
      // visible; the WebGL axis and markers still update every frame.
      const minPixelDelta = Math.abs(range.min - previousRange.min) * widthPx / span;
      const maxPixelDelta = Math.abs(range.max - previousRange.max) * widthPx / span;
      if (minPixelDelta < 0.5 && maxPixelDelta < 0.5) {
        return;
      }
    }
    gestureRulerRangeRef.current = { ...range };
    // Recompute ticks for the gesture view range with the same pure builder
    // as the committed ruler, then reconcile them into a pooled DOM
    // subtree. No scaleX means labels keep their shape at any zoom level.
    const ticks = buildWaterfallRulerTicks(range.min, range.max, widthPx, FREQ_POSITION_OFFSET, frequencyAxisTransform);
    const pool = gestureRulerPoolRef.current;
    for (let index = 0; index < ticks.length; index += 1) {
      let entry = pool[index];
      if (!entry) {
        const root = document.createElement('div');
        root.className = 'absolute top-0 -translate-x-1/2';
        const line = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'absolute left-1/2 top-1.5 -translate-x-1/2 select-none whitespace-nowrap text-[10px] font-medium leading-none tabular-nums tracking-wide text-white/50';
        root.appendChild(line);
        root.appendChild(label);
        layer.appendChild(root);
        entry = { root, line, label, lineClass: '', labelText: '' };
        pool[index] = entry;
      }
      const tick = ticks[index];
      entry.root.style.display = '';
      entry.root.style.left = `${tick.positionPercent}%`;
      const kindClass = tick.kind === 'major'
        ? 'h-4 bg-white/35'
        : tick.kind === 'medium'
          ? 'h-3.5 bg-white/25'
          : 'h-2.5 bg-white/18';
      const lineClass = `mx-auto w-px rounded-full ${kindClass}`;
      if (entry.lineClass !== lineClass) {
        entry.line.className = lineClass;
        entry.lineClass = lineClass;
      }
      const labelText = tick.label ?? '';
      if (entry.labelText !== labelText) {
        entry.label.textContent = labelText;
        entry.labelText = labelText;
      }
    }
    for (let index = ticks.length; index < pool.length; index += 1) {
      pool[index].root.style.display = 'none';
    }
  }, [FREQ_POSITION_OFFSET, frequencyAxisTransform]);

  const applyGestureViewAxis = useCallback((range: InteractionFrequencyRange) => {
    const gl = glRef.current;
    const program = programRef.current;
    const textureAxis = textureAxisRef.current ?? viewStateRef.current.axis;
    if (!gl || !program || gl.isContextLost() || !textureAxis) {
      return;
    }
    const previousRange = gestureGpuRangeRef.current;
    if (previousRange && previousRange.min === range.min && previousRange.max === range.max) {
      return;
    }
    gestureGpuRangeRef.current = { min: range.min, max: range.max };
    ensureProgramBound(gl, program);
    if (viewAxisLocationRef.current) {
      gl.uniform2f(viewAxisLocationRef.current, range.min, range.max);
    }
    const container = containerRef.current;
    const widthPx = gestureLayerWidthRef.current > 0
      ? gestureLayerWidthRef.current
      : (container?.clientWidth ?? 0);
    if (widthPx > 0 && gestureLayerWidthRef.current === 0) {
      gestureLayerWidthRef.current = widthPx;
    }
    const overlayTransform = getWaterfallGestureOverlayTransform(
      textureAxis,
      { minHz: range.min, maxHz: range.max },
      widthPx,
    );
    applyGestureMarkerPositions(overlayTransform);
    setGestureRulerVisible(true);
    updateGestureRuler(range);
    renderRef.current();
  }, [applyGestureMarkerPositions, ensureProgramBound, setGestureRulerVisible, updateGestureRuler]);

  // A standalone trace can originate the same viewport gesture. Mirror its
  // preview into this waterfall without entering React state or the server
  // negotiation path; the committed range still arrives through the normal
  // parent callback when the gesture ends.
  useEffect(() => {
    if (!viewportRuntime) return;
    const syncExternalPreview = () => {
      if (localViewportGestureRef.current) return;
      const preview = viewportRuntime.getPreviewRange();
      if (preview && preview.max > preview.min) {
        if (viewportRuntime.getPhase() === 'commit-hold') {
          // Keep the final optimistic axis visible while the committed
          // replace batch is travelling through the controller. The next
          // batch clears this hold once texture and axis are aligned.
          clearCommittedViewAxisOverride();
          committedViewAxisOverrideRef.current = { ...preview };
          gestureViewAxisRef.current = null;
          gestureGpuRangeRef.current = null;
          applyGestureViewAxis(preview);
          return;
        }
        if (!gestureViewAxisRef.current) {
          clearCommittedViewAxisOverride();
          gestureGpuRangeRef.current = null;
          gestureViewAxisRef.current = { ...preview };
        }
        applyGestureViewAxis(preview);
        return;
      }
      if (!gestureViewAxisRef.current || pendingGestureRangeRef.current) return;
      gestureViewAxisRef.current = null;
      gestureGpuRangeRef.current = null;
      clearGestureOverlays();
      const currentAxis = currentAxisRef.current ?? viewStateRef.current.axis;
      if (currentAxis) updateCurrentAxisUniform(currentAxis);
      renderRef.current();
    };
    const unsubscribe = viewportRuntime.subscribe(syncExternalPreview);
    syncExternalPreview();
    return unsubscribe;
  }, [applyGestureViewAxis, clearCommittedViewAxisOverride, clearGestureOverlays, updateCurrentAxisUniform, viewportRuntime]);

  const clearGestureCommitTimer = useCallback(() => {
    if (gestureCommitTimerRef.current) {
      clearTimeout(gestureCommitTimerRef.current);
      gestureCommitTimerRef.current = null;
    }
  }, []);

  const commitGestureViewport = useCallback(() => {
    clearGestureCommitTimer();
    if (gestureRafRef.current !== undefined) {
      cancelAnimationFrame(gestureRafRef.current);
      gestureRafRef.current = undefined;
    }
    const range = pendingGestureRangeRef.current;
    // The final wheel/pointer event can arrive before the coalesced rAF. Apply
    // that range once synchronously before releasing the GPU gesture state so
    // the commit never exposes the previous frame for a tick.
    if (range && gestureViewAxisRef.current && viewStateRef.current.axis) {
      applyGestureViewAxis(range);
    }
    if (range) {
      clearCommittedViewAxisOverride();
      committedViewAxisOverrideRef.current = { ...range };
      // A disconnected controller may never produce the replace batch that
      // normally releases this hold. Bound the lifetime so a stale gesture
      // cannot pin the shader indefinitely.
      committedViewAxisOverrideTimerRef.current = setTimeout(() => {
        committedViewAxisOverrideTimerRef.current = null;
        committedViewAxisOverrideRef.current = null;
        const currentAxis = currentAxisRef.current;
        if (currentAxis && !gestureViewAxisRef.current) {
          updateCurrentAxisUniform(currentAxis);
          clearGestureOverlays();
          renderRef.current();
        }
      }, 2_000);
    }
    gestureViewAxisRef.current = null;
    pendingGestureRangeRef.current = null;
    // Keep u_viewAxis and the overlay transform at the final gesture range:
    // resetting them here would snap the view back to the pre-gesture axis
    // for the frames between commit and the texture rebuild. The rebuild's
    // updateCurrentAxisUniform resets u_viewAxis to the new texture axis
    // (identity), and processRenderBatch clears the overlay transform once
    // the committed axis reaches the DOM.
    if (range) {
      // Release the freeze before the commit so the final viewport flows
      // through the normal updateContext -> replace rebuild path.
      controller.setGestureViewFreeze(false);
      gestureChangeRef.current?.(range, gestureLastSourceRef.current, 'commit');
      viewportRuntime?.setCommittedRange(range);
      if (viewportRuntime) requestAnimationFrame(() => viewportRuntime.clear());
    }
  }, [applyGestureViewAxis, clearCommittedViewAxisOverride, clearGestureCommitTimer, clearGestureOverlays, controller, updateCurrentAxisUniform, viewportRuntime]);

  const previewGestureViewport = useCallback((
    nextRange: InteractionFrequencyRange,
    source: 'pan' | 'zoom',
  ) => {
    const change = gestureChangeRef.current;
    if (!change) {
      return;
    }
    // Without an uploaded texture axis there is nothing to transform
    // GPU-side; fall back to the direct commit path.
    if (!viewStateRef.current.axis) {
      change(nextRange, source, 'commit');
      return;
    }
    if (!effectiveLocalViewportSupportsPreview) {
      // The legacy callback has no phase contract. Preserve its historical
      // immediate-commit behavior instead of feeding it preview packets it
      // cannot distinguish from a durable viewport update.
      change(nextRange, source);
      return;
    }
    gestureLastSourceRef.current = source;
    // Pin the controller view range for the whole gesture: server-projected
    // frames echo the client's debounced viewport uploads with one
    // round-trip of lag, and without the freeze each echoed frame would
    // re-resolve the view range and yank the texture axis mid-gesture.
    if (!gestureViewAxisRef.current) {
      clearCommittedViewAxisOverride();
      gestureGpuRangeRef.current = null;
      controller.setGestureViewFreeze(true);
    }
    const callbackRange = change(nextRange, source, 'preview');
    const effective = callbackRange
      && Number.isFinite(callbackRange.min)
      && Number.isFinite(callbackRange.max)
      && callbackRange.max > callbackRange.min
      ? callbackRange
      : nextRange;
    localViewportRangeRef.current = effective;
    pendingGestureRangeRef.current = effective;
    gestureViewAxisRef.current = effective;
    viewportRuntime?.setPreviewRange(effective);
    if (gestureRafRef.current === undefined) {
      gestureRafRef.current = requestAnimationFrame(() => {
        gestureRafRef.current = undefined;
        const pending = pendingGestureRangeRef.current;
        if (pending && gestureViewAxisRef.current) {
          applyGestureViewAxis(pending);
        }
      });
    }
    clearGestureCommitTimer();
    gestureCommitTimerRef.current = setTimeout(
      commitGestureViewport,
      WATERFALL_HORIZONTAL_WHEEL_SESSION_IDLE_MS,
    );
  }, [applyGestureViewAxis, clearCommittedViewAxisOverride, clearGestureCommitTimer, commitGestureViewport, controller, effectiveLocalViewportSupportsPreview, viewportRuntime]);

  const handleLocalViewportPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!localViewportInteractionEnabled || !effectiveLocalViewportChange || event.button !== 0 || !event.isPrimary || !hasAxis) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-waterfall-marker-interactive="true"]')) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    containerMetricsRef.current = { left: rect.left, width: rect.width };
    const range = viewStateRef.current.axis
      ? { min: viewStateRef.current.axis.minHz, max: viewStateRef.current.axis.maxHz }
      : { min: minFrequency, max: maxFrequency };
    const span = range.max - range.min;
    if (rect.width <= 0 || !Number.isFinite(span) || span <= 0) return;
    event.preventDefault();
    localViewportGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      startRange: range,
      hzPerPixel: span / rect.width,
    };
  }, [effectiveLocalViewportChange, hasAxis, localViewportInteractionEnabled, maxFrequency, minFrequency]);

  useEffect(() => {
    // While a gesture drives the view axis GPU-side, the gesture range lives
    // in localViewportRangeRef and must not be rebased by axis/prop updates
    // (e.g. server-projected frame ranges or the gesture-end commit
    // propagating back through state).
    if (gestureViewAxisRef.current) {
      return;
    }
    if (!localViewportInteractionEnabled) {
      localViewportRangeRef.current = null;
      return;
    }
    if (effectiveLocalViewportRange && effectiveLocalViewportRange.max > effectiveLocalViewportRange.min) {
      localViewportRangeRef.current = { ...effectiveLocalViewportRange };
      const gesture = localViewportGestureRef.current;
      if (gesture) {
        // The parent may update the absolute range while the pointer is still
        // down. Move the gesture baseline to the latest rendered range so the
        // next pointermove cannot resurrect a stale pre-update range.
        gesture.startRange = { ...effectiveLocalViewportRange };
        gesture.startX = gesture.lastX;
      }
      return;
    }
    const axis = viewStateRef.current.axis;
    if (axis) {
      localViewportRangeRef.current = { min: axis.minHz, max: axis.maxHz };
    }
  }, [effectiveLocalViewportRange, localViewportInteractionEnabled, viewState.axis?.maxHz, viewState.axis?.minHz]);

  useEffect(() => {
    if (!localViewportInteractionEnabled || !effectiveLocalViewportChange) return;
    const handleMove = (event: PointerEvent) => {
      const gesture = localViewportGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.lastX = event.clientX;
      const deltaHz = (event.clientX - gesture.startX) * gesture.hzPerPixel;
      previewGestureViewport({
        min: gesture.startRange.min - deltaHz,
        max: gesture.startRange.max - deltaHz,
      }, 'pan');
    };
    const handleUp = (event: PointerEvent) => {
      if (localViewportGestureRef.current?.pointerId === event.pointerId) {
        const currentRange = resolveWaterfallLocalViewportRange(localViewportRangeRef.current, viewStateRef.current.axis);
        if (currentRange) localViewportRangeRef.current = currentRange;
        localViewportGestureRef.current = null;
        // A drag gesture ends with the pointer, not with the wheel idle timer.
        if (pendingGestureRangeRef.current) {
          commitGestureViewport();
        }
      }
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    document.addEventListener('pointercancel', handleUp);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleUp);
    };
  }, [commitGestureViewport, effectiveLocalViewportChange, localViewportInteractionEnabled, previewGestureViewport]);

  /**
   * One native wheel listener owns both viewport axes. Keeping zoom and pan
   * classification in the same handler guarantees that a diagonal
   * trackpad packet can take exactly one path and removes a duplicate event
   * dispatch from the hot input loop.
   */
  useEffect(() => {
    if ((!localViewportZoomEnabled && !localViewportInteractionEnabled) || !effectiveLocalViewportChange) return;
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      const nowMs = Date.now();
      const axis = classifyWaterfallViewportWheelAxis(event, viewportWheelAxisLockRef.current, nowMs);
      if (!axis) return;

      if (axis === 'vertical' && localViewportZoomEnabled) {
        // Safari/macOS trackpad pinch is delivered as ctrl+wheel. Treat a
        // vertical-dominant pinch as local zoom, while regular ctrl+wheel
        // remains isolated from horizontal frequency tuning.
        viewportWheelAxisLockRef.current = {
          axis,
          expiresAt: nowMs + WATERFALL_HORIZONTAL_WHEEL_SESSION_IDLE_MS,
        };
        if (!event.ctrlKey && !shouldHandleWaterfallVerticalWheel(event)) return;
        const currentRange = resolveWaterfallLocalViewportRange(
          localViewportRangeRef.current,
          viewStateRef.current.axis,
        );
        if (!currentRange) return;
        const cachedRect = containerMetricsRef.current;
        const rect = cachedRect.width > 0 ? cachedRect : container.getBoundingClientRect();
        if (rect.width <= 0) return;
        const span = currentRange.max - currentRange.min;
        if (!Number.isFinite(span) || span <= 0) {
          logger.warn(
            `Rejected invalid local viewport range min=${currentRange.min} max=${currentRange.max} span=${span}`,
          );
          localViewportRangeRef.current = null;
          return;
        }
        event.preventDefault();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const maxViewportSpan = effectiveLocalViewportBounds && effectiveLocalViewportBounds.max > effectiveLocalViewportBounds.min
          ? effectiveLocalViewportBounds.max - effectiveLocalViewportBounds.min
          : Number.POSITIVE_INFINITY;
        const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
        const zoomFactor = getWaterfallLocalZoomFactor(event, {
          isMac,
          pageHeightPx: typeof window !== 'undefined' ? window.innerHeight : 800,
        });
        const nextSpan = Math.max(200, Math.min(maxViewportSpan, span * zoomFactor));
        const anchor = currentRange.min + ratio * span;
        let nextMin = anchor - ratio * nextSpan;
        if (effectiveLocalViewportBounds && effectiveLocalViewportBounds.max > effectiveLocalViewportBounds.min) {
          const minAllowed = effectiveLocalViewportBounds.min;
          const maxAllowed = effectiveLocalViewportBounds.max - nextSpan;
          nextMin = Math.max(minAllowed, Math.min(maxAllowed, nextMin));
        }
        previewGestureViewport({ min: nextMin, max: nextMin + nextSpan }, 'zoom');
        return;
      }

      if (axis !== 'horizontal' || !localViewportInteractionEnabled || !shouldHandleWaterfallHorizontalWheel(event)) {
        return;
      }
      viewportWheelAxisLockRef.current = {
        axis,
        expiresAt: nowMs + WATERFALL_HORIZONTAL_WHEEL_SESSION_IDLE_MS,
      };
      const currentRange = resolveWaterfallLocalViewportRange(localViewportRangeRef.current, viewStateRef.current.axis);
      if (!currentRange) return;
      const cachedRect = containerMetricsRef.current;
      const rect = cachedRect.width > 0 ? cachedRect : container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rawDeltaX = Math.abs(event.deltaX) >= WATERFALL_WHEEL_AXIS_EPSILON
        ? event.deltaX
        : (event.shiftKey ? event.deltaY : 0);
      if (!Number.isFinite(rawDeltaX) || rawDeltaX === 0) return;
      event.preventDefault();
      const deltaHz = rawDeltaX * (currentRange.max - currentRange.min) / rect.width;
      previewGestureViewport({
        min: currentRange.min + deltaHz,
        max: currentRange.max + deltaHz,
      }, 'pan');
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [effectiveLocalViewportBounds, effectiveLocalViewportChange, localViewportInteractionEnabled, localViewportZoomEnabled, previewGestureViewport]);

  const handleGenericFrequencyDragPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!onDragFrequencyChange || event.button !== 0 || !event.isPrimary || !hasAxis) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-waterfall-marker-interactive="true"]')) {
      return;
    }

    event.preventDefault();
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
      pointerId: event.pointerId,
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
  const handleTxMarkerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, operatorId: string) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // 如果有正在进行的冷却，先清除
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
    activeOperatorDragPointerIdRef.current = event.pointerId;
    setCooldownOperatorId(null);
    setDraggingOperatorId(operatorId);
  }, []);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (activeOperatorDragPointerIdRef.current !== e.pointerId) return;
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

  const handleBandOverlayPointerMove = useCallback((e: PointerEvent) => {
    if (activeBandOverlayDragPointerIdRef.current !== e.pointerId) return;
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

  const handleFrequencyBandOverlayPointerDown = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    overlay: FrequencyBandOverlay,
    dragTarget: 'center' | 'start' | 'end',
  ) => {
    if (event.button !== 0 || !event.isPrimary || !hasAxis || (!overlay.draggable && dragTarget === 'center') || (!overlay.resizable && dragTarget !== 'center')) {
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
      pointerId: event.pointerId,
      startX: event.clientX,
      startCenterFrequency: overlay.centerFrequency,
      startWidthHz: widthHz,
      hzPerPixel,
    });
  }, [hasAxis, maxFrequency, minFrequency]);

  const handlePointerUp = useCallback((event: PointerEvent) => {
    if (activeOperatorDragPointerIdRef.current !== event.pointerId) return;
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
    activeOperatorDragPointerIdRef.current = null;
    setDraggingOperatorId(null);
    setCooldownOperatorId(opId);
    cooldownTimerRef.current = setTimeout(() => {
      setCooldownOperatorId(null);
      setLocalFrequencyOverride(null);
      latestDragFrequencyRef.current = null;
      cooldownTimerRef.current = null;
    }, 500);
  }, [draggingOperatorId, onTxFrequencyChange]);

  const handleBandOverlayPointerUp = useCallback((event: PointerEvent) => {
    if (activeBandOverlayDragPointerIdRef.current !== event.pointerId) return;
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
    activeBandOverlayDragPointerIdRef.current = null;
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
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerUp);

      return () => {
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerUp);
      };
    }
  }, [draggingOperatorId, handlePointerMove, handlePointerUp]);

  useEffect(() => {
    if (draggingBandOverlayId) {
      document.addEventListener('pointermove', handleBandOverlayPointerMove);
      document.addEventListener('pointerup', handleBandOverlayPointerUp);
      document.addEventListener('pointercancel', handleBandOverlayPointerUp);

      return () => {
        document.removeEventListener('pointermove', handleBandOverlayPointerMove);
        document.removeEventListener('pointerup', handleBandOverlayPointerUp);
        document.removeEventListener('pointercancel', handleBandOverlayPointerUp);
      };
    }
  }, [draggingBandOverlayId, handleBandOverlayPointerMove, handleBandOverlayPointerUp]);

  useEffect(() => {
    if (!draggingFrequencyBandOverlay) {
      return;
    }

    const handleFrequencyBandPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== draggingFrequencyBandOverlay.pointerId) {
        return;
      }
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

    const handleFrequencyBandPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== draggingFrequencyBandOverlay.pointerId) {
        return;
      }
      const latest = latestFrequencyBandChangeRef.current;
      if (latest) {
        const { id, ...change } = latest;
        onFrequencyBandOverlayCommit?.(id, change);
      }
      setDraggingFrequencyBandOverlay(null);
      setLocalFrequencyBandOverride(null);
      latestFrequencyBandChangeRef.current = null;
    };

    document.addEventListener('pointermove', handleFrequencyBandPointerMove);
    document.addEventListener('pointerup', handleFrequencyBandPointerUp);
    document.addEventListener('pointercancel', handleFrequencyBandPointerUp);
    return () => {
      document.removeEventListener('pointermove', handleFrequencyBandPointerMove);
      document.removeEventListener('pointerup', handleFrequencyBandPointerUp);
      document.removeEventListener('pointercancel', handleFrequencyBandPointerUp);
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

    const handleGesturePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== frequencyGestureDragState.pointerId) {
        return;
      }
      const dragDistance = event.clientX - frequencyGestureDragState.startX;
      const hasExceededThreshold = frequencyGestureDragState.hasExceededThreshold
        || Math.abs(dragDistance) >= FREQUENCY_GESTURE_DRAG_THRESHOLD_PX;

      if (!hasExceededThreshold) {
        return;
      }

      const nextRawFrequency = getWaterfallFrequencyAfterVisualDelta(
        frequencyGestureDragState.startFrequency,
        -dragDistance * frequencyGestureDragState.hzPerPixel,
        frequencyAxisTransform,
        FREQ_POSITION_OFFSET,
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

    const handleGesturePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== frequencyGestureDragState.pointerId) {
        return;
      }
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

    document.addEventListener('pointermove', handleGesturePointerMove);
    document.addEventListener('pointerup', handleGesturePointerUp);
    document.addEventListener('pointercancel', handleGesturePointerUp);
    return () => {
      document.removeEventListener('pointermove', handleGesturePointerMove);
      document.removeEventListener('pointerup', handleGesturePointerUp);
      document.removeEventListener('pointercancel', handleGesturePointerUp);
    };
  }, [
    clampBasebandFrequency,
    clampInteractionFrequency,
    commitFrequencyGestureValue,
    effectiveDragFrequencyStepHz,
    FREQ_POSITION_OFFSET,
    frequencyGestureDragState,
    frequencyAxisTransform,
    interactionFrequencyMode,
    onDragFrequencyActiveChange,
    onDragFrequencyPreview,
    onDragFrequencyChange,
    scheduleFrequencyGestureCommit,
  ]);

  const horizontalWheelFrequencyEnabled = enableHorizontalWheelFrequency && Boolean(onDragFrequencyChange) && hasAxis;

  horizontalWheelRuntimeRef.current = {
    enabled: horizontalWheelFrequencyEnabled && !localViewportInteractionEnabled,
    hasAxis,
    minFrequency,
    maxFrequency,
    frequencyAxisTransform,
    visualFrequencyOffsetHz: FREQ_POSITION_OFFSET,
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
      const cachedRect = containerMetricsRef.current;
      const rect = cachedRect.width > 0 ? cachedRect : container.getBoundingClientRect();
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
      const horizontalDeltaX = Math.abs(event.deltaX) >= WATERFALL_WHEEL_AXIS_EPSILON
        ? event.deltaX
        : (event.shiftKey ? event.deltaY : 0);
      wheelState.accumulatedDeltaXPx += normalizeWaterfallWheelDeltaX(
        { deltaX: horizontalDeltaX, deltaMode: event.deltaMode },
        rect.width,
      );
      wheelState.hzPerPixel = hzPerPixel;
      const nextRawSemanticFrequency = getWaterfallFrequencyAfterVisualDelta(
        wheelState.startFrequency,
        wheelState.accumulatedDeltaXPx * wheelState.hzPerPixel * WATERFALL_HORIZONTAL_WHEEL_FREQUENCY_SCALE,
        runtime.frequencyAxisTransform,
        runtime.visualFrequencyOffsetHz,
      );
      const nextFrequency = runtime.interactionFrequencyMode === 'absolute'
        ? runtime.clampInteractionFrequency(nextRawSemanticFrequency, runtime.effectiveDragFrequencyStepHz)
        : runtime.clampBasebandFrequency(nextRawSemanticFrequency, runtime.effectiveDragFrequencyStepHz);

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
      style={{ height: `${height}px`, touchAction: (onDragFrequencyChange || localViewportInteractionEnabled) ? 'none' : undefined }}
      onPointerDown={localViewportInteractionEnabled ? handleLocalViewportPointerDown : (onDragFrequencyChange ? handleGenericFrequencyDragPointerDown : undefined)}
      onPointerEnter={updateHoverCursorFromPointer}
      onPointerMove={updateHoverCursorFromPointer}
      onPointerLeave={clearHoverCursor}
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
          style={{
            height: `${height}px`,
            // Keep CSS scaling from re-blurring IF hard pixels after NEAREST sampling.
            imageRendering: sharpPixels ? 'pixelated' : 'auto',
          }}
        />
      )}

      {!markerOnly && (
        <div ref={cycleMarkerLayerRef} className="pointer-events-none absolute inset-0 z-20 will-change-transform" />
      )}

      {/* Hover ruler: below interactive markers/buttons, above the WebGL canvas. */}
      <div className="pointer-events-none absolute inset-0 z-10">
        <div
          ref={rulerLayerRef}
          className={`absolute inset-x-0 top-0 h-11 overflow-hidden transition-all duration-150 ease-out ${
            showHoverProbe ? 'translate-y-0 opacity-100' : '-translate-y-0.5 opacity-0'
          }`}
        >
          <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/30 to-transparent" />
          <div className="absolute inset-x-0 top-7 h-px bg-gradient-to-r from-transparent via-white/22 to-transparent" />
          {rulerTicks.map((tick) => {
            const tickClassName = tick.kind === 'major'
              ? 'h-4 bg-white/35'
              : tick.kind === 'medium'
                ? 'h-3.5 bg-white/25'
                : 'h-2.5 bg-white/18';

            return (
              <div
                key={tick.id}
                className="absolute top-0 -translate-x-1/2"
                style={{ left: `${tick.positionPercent}%` }}
              >
                <div className={`mx-auto w-px rounded-full ${tickClassName}`} />
                {tick.label && (
                  <div className="absolute left-1/2 top-1.5 -translate-x-1/2 select-none whitespace-nowrap text-[10px] font-medium leading-none tabular-nums tracking-wide text-white/50">
                    {tick.label}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Gesture ruler: React renders the two static background stripes
            only; tick elements are pooled imperatively (see
            updateGestureRuler) so React never reconciles them. */}
        <div
          ref={gestureRulerLayerRef}
          className="absolute inset-x-0 top-0 h-11 overflow-hidden"
          style={{ visibility: 'hidden' }}
        >
          <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/30 to-transparent" />
          <div className="absolute inset-x-0 top-7 h-px bg-gradient-to-r from-transparent via-white/22 to-transparent" />
        </div>

        {showHoverProbe && hoverCursor && (
          <div
            className="absolute top-0 h-full -translate-x-1/2"
            style={{ left: `${hoverProbePositionPercent}%` }}
          >
            <div className="h-full w-0.5 bg-white/45 shadow-[0_0_8px_rgba(255,255,255,0.22)]" />
          </div>
        )}
      </div>

      {hoverProbePortalPosition && typeof document !== 'undefined' && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] -translate-x-1/2 select-none whitespace-nowrap rounded-full border border-white/10 bg-black/70 px-2 py-1 text-[11px] font-semibold leading-none tabular-nums text-white/85 shadow-[0_8px_24px_rgba(0,0,0,0.32)]"
          style={{
            left: `${hoverProbePortalPosition.left}px`,
            top: `${hoverProbePortalPosition.top}px`,
          }}
        >
          {hoverProbeLabel}
        </div>,
        document.body
      )}

      {/* 频率标记层 */}
      <div ref={markerLayerRef} className="pointer-events-none absolute inset-0 z-30">
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
          if (endPosition < -WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT
            || startPosition > 100 + WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT) {
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
            <div
              key={`frequency-band-${overlay.id}`}
              className="absolute inset-0 h-full pointer-events-none"
            >
              {width > 0 && (
                <div
                  className={`absolute top-0 h-full bg-cyan-400/20 shadow-[inset_0_0_22px_rgba(34,211,238,0.22)] ${isDragging ? 'bg-cyan-300/25 ring-1 ring-cyan-100/25' : ''}`}
                  style={{ left: `${clippedLeft}%`, width: `${width}%` }}
                />
              )}
              {canResize && (
                <>
                  <div
                    className="absolute top-0 z-20 h-full w-4 -translate-x-full cursor-ew-resize bg-transparent pointer-events-auto touch-none"
                    style={{ left: `${startPosition}%` }}
                    data-waterfall-marker-interactive="true"
                    title={label}
                    onMouseEnter={() => setHoveredFrequencyBandEdgeId(overlay.id)}
                    onMouseLeave={() => setHoveredFrequencyBandEdgeId(current => (current === overlay.id ? null : current))}
                    onPointerDown={(event) => handleFrequencyBandOverlayPointerDown(event, overlay, 'start')}
                  >
                    <div className={`ml-auto h-full w-px bg-cyan-100/80 transition-opacity ${edgeHighlighted ? 'opacity-100' : 'opacity-0'}`} />
                  </div>
                  <div
                    className="absolute top-0 z-20 h-full w-4 cursor-ew-resize bg-transparent pointer-events-auto touch-none"
                    style={{ left: `${endPosition}%` }}
                    data-waterfall-marker-interactive="true"
                    title={label}
                    onMouseEnter={() => setHoveredFrequencyBandEdgeId(overlay.id)}
                    onMouseLeave={() => setHoveredFrequencyBandEdgeId(current => (current === overlay.id ? null : current))}
                    onPointerDown={(event) => handleFrequencyBandOverlayPointerDown(event, overlay, 'end')}
                  >
                    <div className={`h-full w-px bg-cyan-100/80 transition-opacity ${edgeHighlighted ? 'opacity-100' : 'opacity-0'}`} />
                  </div>
                </>
              )}
              <div
                className={`group absolute top-0 z-10 h-full w-16 -translate-x-1/2 pointer-events-auto touch-none ${canDragCenter ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
                style={{ left: `${centerPosition}%` }}
                data-waterfall-marker-interactive="true"
                title={label}
                onPointerDown={canDragCenter ? (event) => handleFrequencyBandOverlayPointerDown(event, overlay, 'center') : undefined}
              >
                <div className={`mx-auto h-full w-px bg-cyan-100 transition-opacity ${isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />
                <div className="absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-100 shadow-sm select-none">
                  {label}
                </div>
              </div>
            </div>
          );
        })}

        {/* RF TX/RX line overlays */}
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
          if (endPosition < -WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT
            || startPosition > 100 + WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT) {
            return null;
          }

          const clippedLeft = Math.max(0, startPosition);
          const clippedRight = Math.min(100, endPosition);
          const width = Math.max(0, clippedRight - clippedLeft);
          const draggable = overlay.draggable && !!onTxBandOverlayFrequencyChange;
          const isDragging = draggingBandOverlayId === overlay.id;
          const variant = overlay.variant ?? 'tx';
          const isRx = variant === 'rx';
          const isWindow = variant === 'window';
          const bandClassName = isWindow ? 'bg-sky-300/10' : isRx ? 'bg-green-500/15' : 'bg-red-500/15';
          const lineClassName = isWindow
            ? (isDragging ? 'bg-sky-200/80' : 'bg-sky-200/40')
            : isRx
              ? (isDragging ? 'bg-green-500' : 'bg-green-500/50')
              : (isDragging ? 'bg-red-500' : 'bg-red-500/50');
          const labelClassName = isWindow ? 'text-sky-200/80' : isRx ? 'text-green-500' : 'text-red-500';

          return (
            <div
              key={`tx-band-${overlay.id}`}
              className="absolute inset-0 h-full pointer-events-none"
            >
              {width > 0 && (
                <div
                  className={`absolute top-0 h-full ${bandClassName}`}
                  style={{
                    left: `${clippedLeft}%`,
                    width: `${width}%`,
                  }}
                />
              )}
              <div
                className={`absolute top-0 h-full pointer-events-auto touch-none transition-opacity ${draggable ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
                style={{ left: `${linePosition}%`, transform: 'translateX(-50%)' }}
                data-waterfall-marker-interactive="true"
                onPointerDown={draggable ? (event) => {
                  if (event.button !== 0 || !event.isPrimary) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  if (cooldownTimerRef.current) {
                    clearTimeout(cooldownTimerRef.current);
                    cooldownTimerRef.current = null;
                  }
                  activeBandOverlayDragPointerIdRef.current = event.pointerId;
                  setCooldownBandOverlayId(null);
                  setDraggingBandOverlayId(overlay.id);
                } : undefined}
              >
                <div className={`w-0.5 h-full ${lineClassName}`} />
                {overlay.label && (
                  <div className={`absolute bottom-1 left-1/2 -translate-x-1/2 px-1 text-xs font-semibold bg-black/60 rounded select-none ${labelClassName}`}>
                    {overlay.label}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {presetMarkers.map((marker) => {
          const position = getFrequencyPosition(marker.frequency);
          if (
            !Number.isFinite(position)
            || position < -WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT
            || position > 100 + WATERFALL_OVERLAY_RENDER_MARGIN_PERCENT
          ) {
            return null;
          }

          const isInteractive = Boolean(marker.clickable && onPresetMarkerClick);
          const isHovered = hoveredPresetMarkerId === marker.id;
          const markerElement = (
            <div
              key={`preset-${marker.id}`}
              className={`absolute top-0 h-full pointer-events-auto touch-none transition-opacity ${
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
                    {`${formatFrequencyMHz(marker.frequency)} MHz`}
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
              className={`absolute top-0 h-full pointer-events-auto touch-none transition-opacity ${
                isInteractive ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
              } ${showPopover ? 'hover:opacity-80' : ''}`}
              style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
              data-waterfall-marker-interactive="true"
              onPointerDown={isInteractive ? (event) => {
                setHoveredTxOperatorId(null);
                handleTxMarkerPointerDown(event, operatorId);
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

        {/* 虚拟频差弱警告：实测发射功率偏低的操作员，在其 TX 标记上方常驻一个小黄色感叹号；hover 展开详细说明与操作 */}
        {lowPowerWarningOperatorIds.length > 0 && txFrequencies.map(({ operatorId, frequency }) => {
          if (!lowPowerWarningOperatorIds.includes(operatorId)) return null;
          // 与 TX 标记一致：拖动/冷却期使用本地覆盖频率，使警告图标实时跟随
          const isOverridden = localFrequencyOverride?.operatorId === operatorId &&
            (draggingOperatorId === operatorId || cooldownOperatorId === operatorId);
          const displayFrequency = isOverridden ? localFrequencyOverride!.frequency : frequency;
          const position = getMarkerPosition(displayFrequency);
          if (position === null) return null;
          const isOpen = hoveredWarningOperatorId === operatorId;
          return (
            <Popover
              key={`tx-warn-${operatorId}`}
              placement="top"
              isOpen={isOpen}
              onOpenChange={(open) => { if (!open) setHoveredWarningOperatorId(null); }}
            >
              <PopoverTrigger>
                <div
                  className="absolute z-10 pointer-events-auto cursor-help"
                  style={{ left: `${position}%`, bottom: '1.5rem', transform: 'translateX(-50%)' }}
                  onMouseEnter={() => setHoveredWarningOperatorId(operatorId)}
                  onMouseLeave={() => setHoveredWarningOperatorId(null)}
                  onPointerDown={(event) => event.stopPropagation()}
                  aria-label={tRadio('fakeFrequency.lowPowerTitle')}
                >
                  <FontAwesomeIcon icon={faTriangleExclamation} className="text-warning text-[10px] drop-shadow" />
                </div>
              </PopoverTrigger>
              <PopoverContent
                onMouseEnter={() => setHoveredWarningOperatorId(operatorId)}
                onMouseLeave={() => setHoveredWarningOperatorId(null)}
              >
                <div className="px-3 py-3 max-w-[240px] space-y-2">
                  <div className="text-xs font-semibold text-default-900">{tRadio('fakeFrequency.lowPowerTitle')}</div>
                  <div className="text-xs text-default-500">{tRadio('fakeFrequency.lowPowerHint')}</div>
                  <div className="flex gap-2 justify-end">
                    <Button
                      size="sm"
                      variant="light"
                      onPress={() => { setHoveredWarningOperatorId(null); onDismissLowPowerWarning?.(); }}
                    >
                      {tRadio('fakeFrequency.dontRemind')}
                    </Button>
                    <Button
                      size="sm"
                      color="primary"
                      onPress={() => { setHoveredWarningOperatorId(null); onEnableFakeFrequency?.(); }}
                    >
                      {tRadio('fakeFrequency.enableNow')}
                    </Button>
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

    </div>
  );
}; 
