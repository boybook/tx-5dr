import type { SpectrumFrame, SpectrumFrameSupplement, SpectrumKind, SpectrumLevelDescriptor } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';

const logger = createLogger('SpectrumStreamController');

export interface SpectrumAxis {
  minHz: number;
  maxHz: number;
  binCount: number;
}

export interface OpenWebRXViewport {
  centerHz: number;
  spanHz: number;
}

export type RadioSdrCenterViewMode = 'full' | 'left' | 'right';

export interface RadioSdrOptimisticFrequencyIntent {
  targetFrequencyHz: number;
  baselineFrequencyHz: number;
  baselineFrameCenterHz: number;
  baselineFrameRange?: { min: number; max: number };
  sentAt?: number;
  timeoutMs?: number;
}

export interface SpectrumStreamStatus {
  hasData: boolean;
  selectedKind: SpectrumKind | null;
  fullRange: { min: number; max: number } | null;
  displayRange: { min: number; max: number } | null;
  level: SpectrumLevelDescriptor | null;
}

export interface SpectrumRenderBatch {
  mode: 'reset' | 'replace' | 'append';
  rows: Float32Array[];
  rowTimestamps: number[];
  axis: SpectrumAxis | null;
  frameToken: number | null;
  hasBacklog: boolean;
  totalRows: number;
  /** Viewport gestures should switch axes immediately instead of restarting an animation per event. */
  axisTransition?: 'animate' | 'immediate';
  /**
   * Wide-envelope supplement rows parallel to `rows` (null entries for
   * frames without a supplement). Rows keep their native bins — the
   * renderer uploads them to a separate ring texture at `supplementAxis`
   * and samples it where the detail texture has no coverage (e.g. during
   * GPU-side gesture pan/zoom).
   */
  supplementRows?: (Float32Array | null)[];
  /** Native axis shared by the supplement rows in this batch. */
  supplementAxis?: SpectrumAxis | null;
}

/**
 * The newest spectrum row in the controller's committed view. Renderers use
 * this snapshot for single-frame presentations (for example the FFT trace)
 * while the waterfall consumes the full history batches above. The arrays are
 * retained controller buffers and must be treated as read-only by consumers.
 */
export interface SpectrumRenderSnapshot {
  kind: SpectrumKind;
  frameToken: number | null;
  timestamp: number | null;
  axis: SpectrumAxis | null;
  values: Float32Array | null;
  nativeRange: { min: number; max: number } | null;
  supplementAxis: SpectrumAxis | null;
  supplementValues: Float32Array | null;
  level: SpectrumLevelDescriptor | null;
}

export type SpectrumHistoryLimits = number | Partial<Record<SpectrumKind, number>>;

interface RetainedSpectrumFrame {
  timestamp: number;
  kind: SpectrumKind;
  frequencyRange: { min: number; max: number };
  nativeFrequencyRange: { min: number; max: number };
  binCount: number;
  level: SpectrumLevelDescriptor | null;
}

interface RetainedSpectrumSupplement {
  frequencyRange: { min: number; max: number };
  values: Float32Array;
}

interface CanonicalSpectrumFrame {
  frame: RetainedSpectrumFrame;
  values: Float32Array;
  supplement: RetainedSpectrumSupplement | null;
  receivedAt: number;
  cachedViewKey: string | null;
  cachedViewValues: Float32Array | null;
  cachedAxis: SpectrumAxis | null;
}

interface QueuedSpectrumFrame extends CanonicalSpectrumFrame {
  queuedAt: number;
}

interface StreamContext {
  selectedKind: SpectrumKind | null;
  openWebRXViewport: OpenWebRXViewport | null;
  isOpenWebRXDetailMode: boolean;
  radioSdrCenterViewMode: RadioSdrCenterViewMode;
  radioSdrReferenceFrequencyHz: number | null;
  radioSdrViewRange: { min: number; max: number } | null;
  /** Optional client-side absolute viewport used by wide-band IQ sources. */
  radioSdrViewport: { min: number; max: number } | null;
}

type HistoryMap = Record<SpectrumKind, CanonicalSpectrumFrame[]>;
type PendingMap = Record<SpectrumKind, QueuedSpectrumFrame[]>;
type HistoryLimitMap = Record<SpectrumKind, number>;

const DEFAULT_HISTORY = 120;
const SPECTRUM_KINDS: SpectrumKind[] = ['audio', 'radio-sdr', 'openwebrx-sdr'];
const DEFAULT_FRAME_DURATION_MS = 100;
const MIN_FRAME_DURATION_MS = 40;
const IDLE_FREEZE_MIN_MS = 300;
const MAX_BATCH_SIZE = 8;
const RADIO_SDR_OPTIMISTIC_TIMEOUT_MS = 2000;
const RADIO_SDR_OPTIMISTIC_CONFIRM_MIN_HZ = 50;
const RADIO_SDR_OPTIMISTIC_CONFIRM_SPAN_RATIO = 0.001;

const RAW_RADIO_SDR_LEVEL: SpectrumLevelDescriptor = {
  domain: 'raw',
  unit: 'Level',
  reference: 'none',
  calibrated: false,
  min: 0,
  max: 255,
};

function createHistoryMap(): HistoryMap {
  return {
    audio: [],
    'radio-sdr': [],
    'openwebrx-sdr': [],
  };
}

function createPendingMap(): PendingMap {
  return {
    audio: [],
    'radio-sdr': [],
    'openwebrx-sdr': [],
  };
}

function normalizeHistoryLimits(limits: SpectrumHistoryLimits): HistoryLimitMap {
  if (typeof limits === 'number') {
    return {
      audio: limits,
      'radio-sdr': limits,
      'openwebrx-sdr': limits,
    };
  }

  return {
    audio: limits.audio ?? DEFAULT_HISTORY,
    'radio-sdr': limits['radio-sdr'] ?? DEFAULT_HISTORY,
    'openwebrx-sdr': limits['openwebrx-sdr'] ?? DEFAULT_HISTORY,
  };
}

function areRangesEqual(
  left: { min: number; max: number } | null,
  right: { min: number; max: number } | null
): boolean {
  return Boolean(
    left
    && right
    && left.min === right.min
    && left.max === right.max
  ) || (left === null && right === null);
}

function areViewportsEqual(left: OpenWebRXViewport | null, right: OpenWebRXViewport | null): boolean {
  return Boolean(
    left
    && right
    && left.centerHz === right.centerHz
    && left.spanHz === right.spanHz
  ) || (left === null && right === null);
}

function normalizeRadioSdrReferenceFrequency(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveFrameLevel(frame: SpectrumFrame): SpectrumLevelDescriptor | null {
  if (frame.meta.level) {
    return frame.meta.level;
  }
  return frame.kind === 'radio-sdr' ? RAW_RADIO_SDR_LEVEL : null;
}

function areLevelDescriptorsEqual(
  left: SpectrumLevelDescriptor | null,
  right: SpectrumLevelDescriptor | null,
): boolean {
  return Boolean(
    left
    && right
    && left.domain === right.domain
    && left.unit === right.unit
    && left.reference === right.reference
    && left.calibrated === right.calibrated
    && left.min === right.min
    && left.max === right.max,
  ) || (left === null && right === null);
}

function decodeFrameValues(frame: SpectrumFrame): Float32Array {
  const binaryString = atob(frame.binaryData.data);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  const int16Array = new Int16Array(bytes.buffer);
  const { scale = 1, offset = 0 } = frame.binaryData.format;
  const output = new Float32Array(int16Array.length);
  for (let index = 0; index < int16Array.length; index += 1) {
    output[index] = int16Array[index] * scale + offset;
  }
  return output;
}

function decodeSupplementValues(supplement: SpectrumFrameSupplement): Float32Array {
  const binaryString = atob(supplement.binaryData.data);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  const int16Array = new Int16Array(bytes.buffer);
  const { scale = 1, offset = 0 } = supplement.binaryData.format;
  const output = new Float32Array(int16Array.length);
  for (let index = 0; index < int16Array.length; index += 1) {
    output[index] = int16Array[index] * scale + offset;
  }
  return output;
}

function getBinCount(frame: SpectrumFrame): number {
  return frame.meta.displayBinCount ?? frame.meta.sourceBinCount ?? frame.binaryData.format.length;
}

function retainFrameMeta(frame: SpectrumFrame): RetainedSpectrumFrame {
  return {
    timestamp: frame.timestamp,
    kind: frame.kind,
    frequencyRange: {
      min: frame.frequencyRange.min,
      max: frame.frequencyRange.max,
    },
    nativeFrequencyRange: {
      min: frame.meta.nativeFrequencyRange?.min ?? frame.frequencyRange.min,
      max: frame.meta.nativeFrequencyRange?.max ?? frame.frequencyRange.max,
    },
    binCount: getBinCount(frame),
    level: resolveFrameLevel(frame),
  };
}

export function cropSpectrumToRange(
  values: Float32Array,
  fullRange: { min: number; max: number },
  targetRange: { min: number; max: number },
  fillValue = 0,
  out?: Float32Array,
): Float32Array {
  if (values.length === 0) {
    return values;
  }

  if (areRangesEqual(fullRange, targetRange)) {
    return values;
  }

  const fullSpan = fullRange.max - fullRange.min;
  if (fullSpan <= 0) {
    return values;
  }

  // Reusing a caller-provided buffer avoids per-rebuild allocation churn;
  // the loop below overwrites every element.
  const output = out && out.length === values.length && out !== values
    ? out
    : new Float32Array(values.length);
  const maxIndex = values.length - 1;
  if (maxIndex === 0) {
    const targetStep = targetRange.max - targetRange.min;
    let targetFrequency = targetRange.min;
    for (let index = 0; index < output.length; index += 1, targetFrequency += targetStep) {
      output[index] = targetFrequency >= fullRange.min && targetFrequency <= fullRange.max
        ? values[0]!
        : fillValue;
    }
    return output;
  }
  const denominator = Math.max(maxIndex, 1);
  const targetStep = (targetRange.max - targetRange.min) / denominator;
  const sourceScale = maxIndex / fullSpan;
  const whollyInside = targetRange.min >= fullRange.min && targetRange.max <= fullRange.max;
  const sourceStep = targetStep * sourceScale;
  let sourcePosition = (targetRange.min - fullRange.min) * sourceScale;

  if (whollyInside) {
    for (let index = 0; index < values.length; index += 1, sourcePosition += sourceStep) {
      const leftIndex = Math.floor(sourcePosition);
      const rightIndex = leftIndex < maxIndex ? leftIndex + 1 : maxIndex;
      const factor = sourcePosition - leftIndex;
      const left = values[leftIndex]!;
      output[index] = left + (values[rightIndex]! - left) * factor;
    }
    return output;
  }

  for (let index = 0; index < values.length; index += 1, sourcePosition += sourceStep) {
    if (sourcePosition < 0 || sourcePosition > maxIndex) {
      output[index] = fillValue;
      continue;
    }
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = leftIndex < maxIndex ? leftIndex + 1 : maxIndex;
    const factor = sourcePosition - leftIndex;
    const left = values[leftIndex]!;
    output[index] = left + (values[rightIndex]! - left) * factor;
  }

  return output;
}

function cropSpectrumWithSupplement(
  values: Float32Array,
  fullRange: { min: number; max: number },
  supplement: RetainedSpectrumSupplement,
  targetRange: { min: number; max: number },
  fillValue = 0,
  out?: Float32Array,
): Float32Array {
  if (values.length === 0 || fullRange.max <= fullRange.min) return values;
  if (areRangesEqual(fullRange, targetRange)) {
    return values;
  }
  // When the requested viewport is wholly covered by the detail payload,
  // skip the supplement branch and use the tighter two-pass interpolator.
  if (targetRange.min >= fullRange.min && targetRange.max <= fullRange.max) {
    return cropSpectrumToRange(values, fullRange, targetRange, fillValue, out);
  }
  const output = out && out.length === values.length && out !== values
    ? out
    : new Float32Array(values.length);
  const detailMaxIndex = values.length - 1;
  const supplementMaxIndex = supplement.values.length - 1;
  const detailScale = detailMaxIndex / (fullRange.max - fullRange.min);
  const supplementSpan = supplement.frequencyRange.max - supplement.frequencyRange.min;
  const supplementScale = supplementSpan > 0 ? supplementMaxIndex / supplementSpan : 0;
  const targetStep = (targetRange.max - targetRange.min) / Math.max(output.length - 1, 1);
  let frequency = targetRange.min;

  for (let index = 0; index < output.length; index += 1, frequency += targetStep) {
    if (frequency >= fullRange.min && frequency <= fullRange.max) {
      const position = Math.min(detailMaxIndex, Math.max(0, (frequency - fullRange.min) * detailScale));
      const leftIndex = Math.floor(position);
      const rightIndex = leftIndex < detailMaxIndex ? leftIndex + 1 : detailMaxIndex;
      const factor = position - leftIndex;
      const left = values[leftIndex]!;
      output[index] = left + (values[rightIndex]! - left) * factor;
      continue;
    }

    if (
      supplementMaxIndex >= 0
      && supplementSpan > 0
      && frequency >= supplement.frequencyRange.min
      && frequency <= supplement.frequencyRange.max
    ) {
      const position = Math.min(
        supplementMaxIndex,
        Math.max(0, (frequency - supplement.frequencyRange.min) * supplementScale),
      );
      const leftIndex = Math.floor(position);
      const rightIndex = leftIndex < supplementMaxIndex ? leftIndex + 1 : supplementMaxIndex;
      const factor = position - leftIndex;
      const left = supplement.values[leftIndex]!;
      output[index] = left + (supplement.values[rightIndex]! - left) * factor;
      continue;
    }

    output[index] = fillValue;
  }
  return output;
}

function cropSpectrumToViewport(
  values: Float32Array,
  fullRange: { min: number; max: number },
  viewport: OpenWebRXViewport,
  out?: Float32Array
): Float32Array {
  return cropSpectrumToRange(values, fullRange, {
    min: viewport.centerHz - viewport.spanHz / 2,
    max: viewport.centerHz + viewport.spanHz / 2,
  }, 0, out);
}

function buildViewKey(
  kind: SpectrumKind,
  frame: RetainedSpectrumFrame,
  context: StreamContext
): string {
  if (kind === 'radio-sdr') {
    const range = context.radioSdrViewRange;
    return range
      ? `${kind}:${range.min}:${range.max}:${frame.frequencyRange.min}:${frame.frequencyRange.max}:${frame.binCount}`
      : `${kind}:missing`;
  }

  if (kind === 'openwebrx-sdr' && !context.isOpenWebRXDetailMode) {
    const viewport = context.openWebRXViewport;
    return viewport
      ? `${kind}:${viewport.centerHz}:${viewport.spanHz}:${frame.frequencyRange.min}:${frame.frequencyRange.max}`
      : `${kind}:missing`;
  }

  return `${kind}:full:${frame.frequencyRange.min}:${frame.frequencyRange.max}:${frame.binCount}`;
}

export class SpectrumStreamController {
  private readonly historyLimits: HistoryLimitMap;
  private readonly frameListeners = new Set<() => void>();
  private readonly statusListeners = new Set<() => void>();
  private readonly histories: HistoryMap = createHistoryMap();
  private readonly pendingByKind: PendingMap = createPendingMap();
  private context: StreamContext = {
    selectedKind: null,
    openWebRXViewport: null,
    isOpenWebRXDetailMode: false,
    radioSdrCenterViewMode: 'full',
    radioSdrReferenceFrequencyHz: null,
    radioSdrViewRange: null,
    radioSdrViewport: null,
  };
  private statusSnapshot: SpectrumStreamStatus = {
    hasData: false,
    selectedKind: null,
    fullRange: null,
    displayRange: null,
    level: null,
  };
  private pendingBatch: SpectrumRenderBatch | null = null;
  private rafId: number | null = null;
  private replaceRafId: number | null = null;
  private pendingReplaceAxisTransition: 'animate' | 'immediate' = 'animate';
  private renderRowLimit: number | null = null;
  private latestRenderSnapshotKey: string | null = null;
  private latestRenderSnapshot: SpectrumRenderSnapshot | null = null;
  /**
   * While a viewport pan/zoom gesture is active, the radio SDR view range is
   * pinned. Server-projected frames follow the client's debounced viewport
   * uploads with one round-trip of lag; without this pin every echoed frame
   * would yank the view range (and trigger a full rebuild) mid-gesture.
   */
  private gestureViewFreeze = false;
  private radioSdrOptimisticTimer: ReturnType<typeof setTimeout> | null = null;
  private radioSdrOptimisticIntent: {
    targetFrequencyHz: number;
    baselineFrequencyHz: number;
    baselineFrameCenterHz: number;
    baselineFrameRange: { min: number; max: number } | null;
    sentAt: number;
    timeoutMs: number;
  } | null = null;
  private radioSdrServerSyncHoldUntil = 0;
  private lastRenderTime = 0;
  private lastArrivalTime = 0;
  private arrivalIntervalEma = DEFAULT_FRAME_DURATION_MS;
  private configuredFrameIntervalMs: number | null = null;

  constructor(historyLimits: SpectrumHistoryLimits = DEFAULT_HISTORY) {
    this.historyLimits = normalizeHistoryLimits(historyLimits);
  }

  subscribeFrameTick = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  };

  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  getStatusSnapshot = (): SpectrumStreamStatus => this.statusSnapshot;

  setFrameIntervalMs(intervalMs: number | null): void {
    this.configuredFrameIntervalMs = typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : null;
  }

  setRenderRowLimit(limit: number | null, options: { schedule?: boolean } = {}): void {
    const normalized = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : null;
    if (normalized === this.renderRowLimit) return;
    this.renderRowLimit = normalized;
    if (options.schedule !== false && this.context.selectedKind) {
      this.scheduleReplaceBatch('immediate');
    }
  }

  getFullRange = (kind: SpectrumKind | null): { min: number; max: number } | null => {
    if (!kind) {
      return null;
    }

    const latest = this.histories[kind][0]?.frame ?? null;
    return latest ? latest.nativeFrequencyRange : null;
  };

  /**
   * Return the newest row projected to the current committed view. This keeps
   * trace renderers on the same axis/cache as the waterfall and avoids a
   * second decode or crop pipeline in the UI.
   */
  getLatestRenderSnapshot = (kind: SpectrumKind | null = this.context.selectedKind): SpectrumRenderSnapshot => {
    if (!kind) {
      return {
        kind: 'audio',
        frameToken: null,
        timestamp: null,
        axis: null,
        values: null,
        nativeRange: null,
        supplementAxis: null,
        supplementValues: null,
        level: null,
      };
    }

    const latest = this.histories[kind][0] ?? null;
    if (!latest) {
      return {
        kind,
        frameToken: null,
        timestamp: null,
        axis: null,
        values: null,
        nativeRange: null,
        supplementAxis: null,
        supplementValues: null,
        level: null,
      };
    }

    const viewRange = this.context.radioSdrViewRange;
    const snapshotKey = `${kind}:${latest.frame.timestamp}:${viewRange?.min ?? ''}:${viewRange?.max ?? ''}:${this.context.openWebRXViewport?.centerHz ?? ''}:${this.context.openWebRXViewport?.spanHz ?? ''}:${this.context.isOpenWebRXDetailMode}`;
    if (this.latestRenderSnapshotKey === snapshotKey && this.latestRenderSnapshot) {
      return this.latestRenderSnapshot;
    }

    const transformed = this.transformFrameForCurrentView(latest);
    const supplementProjection = this.buildSupplementProjection([latest]);
    const snapshot = {
      kind,
      frameToken: latest.frame.timestamp,
      timestamp: latest.frame.timestamp,
      axis: transformed?.axis ?? null,
      values: transformed?.values ?? null,
      nativeRange: { ...latest.frame.nativeFrequencyRange },
      supplementAxis: supplementProjection.axis,
      supplementValues: supplementProjection.rows[0] ?? null,
      level: latest.frame.level,
    };
    this.latestRenderSnapshotKey = snapshotKey;
    this.latestRenderSnapshot = snapshot;
    return snapshot;
  };

  setRadioSdrServerSyncHoldUntil(untilMs: number | null): void {
    this.radioSdrServerSyncHoldUntil = typeof untilMs === 'number' && Number.isFinite(untilMs)
      ? Math.max(0, untilMs)
      : untilMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : 0;
  }

  setRadioSdrOptimisticFrequencyIntent(intent: RadioSdrOptimisticFrequencyIntent | null): void {
    this.clearRadioSdrOptimisticTimer();

    if (
      !intent
      || !Number.isFinite(intent.targetFrequencyHz)
      || !Number.isFinite(intent.baselineFrequencyHz)
      || !Number.isFinite(intent.baselineFrameCenterHz)
    ) {
      this.clearRadioSdrOptimisticIntent();
      return;
    }

    const nextIntent = {
      targetFrequencyHz: intent.targetFrequencyHz,
      baselineFrequencyHz: intent.baselineFrequencyHz,
      baselineFrameCenterHz: intent.baselineFrameCenterHz,
      baselineFrameRange: intent.baselineFrameRange
        && Number.isFinite(intent.baselineFrameRange.min)
        && Number.isFinite(intent.baselineFrameRange.max)
        && intent.baselineFrameRange.max > intent.baselineFrameRange.min
        ? { ...intent.baselineFrameRange }
        : this.deriveRadioSdrNativeRange(),
      sentAt: intent.sentAt ?? Date.now(),
      timeoutMs: intent.timeoutMs ?? RADIO_SDR_OPTIMISTIC_TIMEOUT_MS,
    };
    this.radioSdrOptimisticIntent = nextIntent;
    this.applyRadioSdrViewRange(this.resolveRadioSdrViewRange());

    this.radioSdrOptimisticTimer = setTimeout(() => {
      this.radioSdrOptimisticTimer = null;
      this.clearRadioSdrOptimisticIntent();
    }, nextIntent.timeoutMs);
  }

  primeRenderBatch(): SpectrumRenderBatch {
    this.cancelScheduledReplaceBatch();
    const selectedKind = this.context.selectedKind;
    if (selectedKind) {
      this.pendingByKind[selectedKind].length = 0;
    }
    this.pendingBatch = null;
    return this.buildReplaceBatch();
  }

  consumeRenderBatch(): SpectrumRenderBatch | null {
    const nextBatch = this.pendingBatch;
    this.pendingBatch = null;
    return nextBatch;
  }

  destroy(): void {
    this.clearBufferedFrames();
    this.clearRadioSdrOptimisticIntent({ notify: false });
    this.frameListeners.clear();
    this.statusListeners.clear();
  }

  reset(): void {
    this.clearBufferedFrames();
    this.clearRadioSdrOptimisticIntent({ notify: false });
    this.gestureViewFreeze = false;
    this.latestRenderSnapshotKey = null;
    this.latestRenderSnapshot = null;
    this.context = {
      ...this.context,
      radioSdrViewRange: null,
      radioSdrViewport: null,
    };
    this.pendingBatch = {
      mode: 'reset',
      rows: [],
      rowTimestamps: [],
      axis: null,
      frameToken: null,
      hasBacklog: false,
      totalRows: 0,
    };
    this.syncStatusSnapshot();
    this.notifyFrameListeners();
  }

  resetKind(kind: SpectrumKind): void {
    this.pendingByKind[kind].length = 0;
    this.histories[kind].length = 0;
    if (this.context.selectedKind === kind) {
      this.latestRenderSnapshotKey = null;
      this.latestRenderSnapshot = null;
    }
    if (this.context.selectedKind !== kind) {
      return;
    }

    this.cancelScheduledReplaceBatch();
    this.pendingBatch = {
      mode: 'reset',
      rows: [],
      rowTimestamps: [],
      axis: null,
      frameToken: null,
      hasBacklog: false,
      totalRows: 0,
    };
    this.syncStatusSnapshot();
    this.notifyFrameListeners();
  }

  private clearBufferedFrames(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.cancelScheduledReplaceBatch();

    for (const kind of SPECTRUM_KINDS) {
      this.histories[kind].length = 0;
      this.pendingByKind[kind].length = 0;
    }

    this.pendingBatch = null;
    this.latestRenderSnapshotKey = null;
    this.latestRenderSnapshot = null;
    this.lastRenderTime = 0;
    this.lastArrivalTime = 0;
    this.arrivalIntervalEma = DEFAULT_FRAME_DURATION_MS;
  }

  private clearRadioSdrOptimisticTimer(): void {
    if (this.radioSdrOptimisticTimer) {
      clearTimeout(this.radioSdrOptimisticTimer);
      this.radioSdrOptimisticTimer = null;
    }
  }

  private clearRadioSdrOptimisticIntent(options: { notify?: boolean } = {}): void {
    if (!this.radioSdrOptimisticIntent) {
      return;
    }

    this.clearRadioSdrOptimisticTimer();
    this.radioSdrOptimisticIntent = null;
    this.applyRadioSdrViewRange(this.resolveRadioSdrViewRange(), options);
  }

  private invalidateCachedViews(kind: SpectrumKind): void {
    for (const frame of this.histories[kind]) {
      frame.cachedViewKey = null;
      frame.cachedViewValues = null;
      frame.cachedAxis = null;
    }
    for (const frame of this.pendingByKind[kind]) {
      frame.cachedViewKey = null;
      frame.cachedViewValues = null;
      frame.cachedAxis = null;
    }
  }

  private rebuildSelectedViewIfNeeded(kind: SpectrumKind): void {
    if (this.context.selectedKind !== kind) {
      return;
    }

    this.pendingByKind[kind].length = 0;
    this.scheduleReplaceBatch();
  }

  private deriveRadioSdrNativeRange(): { min: number; max: number } | null {
    const latestFrame = this.histories['radio-sdr'][0]?.frame ?? null;
    return latestFrame ? { ...latestFrame.nativeFrequencyRange } : null;
  }

  private deriveRadioSdrOptimisticRange(): { min: number; max: number } | null {
    const intent = this.radioSdrOptimisticIntent;
    if (!intent) {
      return this.deriveRadioSdrNativeRange();
    }

    const nativeRange = this.isRadioSdrServerSyncHeld()
      ? (intent.baselineFrameRange ?? this.deriveRadioSdrNativeRange())
      : this.deriveRadioSdrNativeRange();
    if (!nativeRange) {
      return null;
    }

    const offsetHz = intent.targetFrequencyHz - intent.baselineFrequencyHz;
    return {
      min: nativeRange.min + offsetHz,
      max: nativeRange.max + offsetHz,
    };
  }

  private applyRadioSdrCenterViewRange(fullRange: { min: number; max: number } | null): { min: number; max: number } | null {
    if (!fullRange || this.context.radioSdrCenterViewMode === 'full') {
      return fullRange;
    }

    const referenceFrequencyHz = normalizeRadioSdrReferenceFrequency(this.context.radioSdrReferenceFrequencyHz);
    if (referenceFrequencyHz === null || referenceFrequencyHz < fullRange.min || referenceFrequencyHz > fullRange.max) {
      return fullRange;
    }

    if (this.context.radioSdrCenterViewMode === 'right' && referenceFrequencyHz < fullRange.max) {
      return {
        min: referenceFrequencyHz,
        max: fullRange.max,
      };
    }

    if (this.context.radioSdrCenterViewMode === 'left' && referenceFrequencyHz > fullRange.min) {
      return {
        min: fullRange.min,
        max: referenceFrequencyHz,
      };
    }

    return fullRange;
  }

  private resolveRadioSdrViewRange(): { min: number; max: number } | null {
    const fullRange = this.radioSdrOptimisticIntent
      ? this.deriveRadioSdrOptimisticRange()
      : this.deriveRadioSdrNativeRange();
    if (this.context.radioSdrViewport) {
      return this.context.radioSdrViewport;
    }
    const latestFrame = this.histories['radio-sdr'][0];
    // TCI frames may advertise a broad native envelope plus a cropped detail
    // payload. Keep the initial render on the detail payload; the supplement
    // remains available when the user explicitly expands the viewport.
    const defaultRange = !this.radioSdrOptimisticIntent && latestFrame?.supplement
      ? latestFrame.frame.frequencyRange
      : fullRange;
    return this.applyRadioSdrCenterViewRange(defaultRange);
  }

  private applyRadioSdrViewRange(
    nextRange: { min: number; max: number } | null,
    options: { notify?: boolean } = {},
  ): boolean {
    const normalizedRange = nextRange && Number.isFinite(nextRange.min) && Number.isFinite(nextRange.max) && nextRange.max > nextRange.min
      ? { min: nextRange.min, max: nextRange.max }
      : null;
    if (areRangesEqual(this.context.radioSdrViewRange, normalizedRange)) {
      return false;
    }

    this.context = {
      ...this.context,
      radioSdrViewRange: normalizedRange,
    };
    // The view key contains the complete target range, so changing the range
    // naturally invalidates each frame's single cached projection. Avoid
    // walking the entire history on every trackpad event.
    if (options.notify !== false) {
      this.rebuildSelectedViewIfNeeded('radio-sdr');
    }
    return true;
  }

  private scheduleReplaceBatch(axisTransition: 'animate' | 'immediate' = 'animate'): void {
    this.pendingBatch = null;
    if (axisTransition === 'immediate') {
      this.pendingReplaceAxisTransition = 'immediate';
    }
    if (this.replaceRafId !== null) {
      return;
    }

    this.replaceRafId = requestAnimationFrame(() => {
      this.replaceRafId = null;
      const nextTransition = this.pendingReplaceAxisTransition;
      this.pendingReplaceAxisTransition = 'animate';
      this.pendingBatch = this.buildReplaceBatch(nextTransition);
      this.notifyFrameListeners();
    });
  }

  private cancelScheduledReplaceBatch(): void {
    if (this.replaceRafId !== null) {
      cancelAnimationFrame(this.replaceRafId);
      this.replaceRafId = null;
    }
    this.pendingReplaceAxisTransition = 'animate';
  }

  /**
   * Pin (or release) the radio SDR view range while a viewport pan/zoom
   * gesture runs. While frozen, neither updateContext nor incoming
   * server-projected frames re-resolve the view range, so no replace
   * rebuild is triggered mid-gesture. The gesture-end commit releases the
   * freeze right before applying the final viewport.
   */
  setGestureViewFreeze(frozen: boolean): void {
    const wasFrozen = this.gestureViewFreeze;
    if (frozen && !this.gestureViewFreeze) {
      // A server echo may have queued a replace immediately before the first
      // pointer packet. Cancel that deferred rebuild so the gesture starts
      // from one stable texture axis; incoming frames continue through the
      // normal append path while the freeze is held.
      this.cancelScheduledReplaceBatch();
    }
    this.gestureViewFreeze = frozen;
    if (!frozen && wasFrozen && this.context.selectedKind === 'radio-sdr') {
      // A mode/radio update may have changed the pending viewport while the
      // freeze was held. Reconcile it on release so that an unchanged
      // `radioSdrViewport` field cannot leave the rendered range stale.
      const changed = this.applyRadioSdrViewRange(this.resolveRadioSdrViewRange(), { notify: false });
      if (changed) {
        this.scheduleReplaceBatch('immediate');
      }
    }
  }

  updateContext(
    nextContext: Partial<StreamContext>,
    options: { axisTransition?: 'animate' | 'immediate' } = {},
  ): void {
    const previous = this.context;
    this.latestRenderSnapshotKey = null;
    this.latestRenderSnapshot = null;
    this.context = {
      ...previous,
      ...nextContext,
      radioSdrCenterViewMode: nextContext.radioSdrCenterViewMode ?? previous.radioSdrCenterViewMode,
      radioSdrViewport: 'radioSdrViewport' in nextContext
        ? (nextContext.radioSdrViewport ?? null)
        : previous.radioSdrViewport,
      radioSdrReferenceFrequencyHz: 'radioSdrReferenceFrequencyHz' in nextContext
        ? normalizeRadioSdrReferenceFrequency(nextContext.radioSdrReferenceFrequencyHz)
        : previous.radioSdrReferenceFrequencyHz,
    };

    const selectedKindChanged = previous.selectedKind !== this.context.selectedKind;
    const openWebRXViewportChanged = !areViewportsEqual(previous.openWebRXViewport, this.context.openWebRXViewport);
    const detailModeChanged = previous.isOpenWebRXDetailMode !== this.context.isOpenWebRXDetailMode;
    const radioSdrCenterViewChanged = previous.radioSdrCenterViewMode !== this.context.radioSdrCenterViewMode
      || previous.radioSdrReferenceFrequencyHz !== this.context.radioSdrReferenceFrequencyHz;
    const radioSdrViewportChanged = !areRangesEqual(previous.radioSdrViewport, this.context.radioSdrViewport);
    if (!this.gestureViewFreeze && (radioSdrCenterViewChanged || radioSdrViewportChanged)) {
      this.applyRadioSdrViewRange(this.resolveRadioSdrViewRange(), { notify: false });
    }
    const radioSdrViewRangeChanged = !areRangesEqual(previous.radioSdrViewRange, this.context.radioSdrViewRange);

    this.syncStatusSnapshot();

    if (selectedKindChanged && this.context.selectedKind !== 'radio-sdr') {
      this.clearRadioSdrOptimisticIntent({ notify: false });
    }

    if (!selectedKindChanged && !openWebRXViewportChanged && !detailModeChanged && !radioSdrViewRangeChanged) {
      return;
    }

    const selectedKind = this.context.selectedKind;
    if (selectedKind) {
      this.pendingByKind[selectedKind].length = 0;
    }

    // Trackpad/wheel viewport updates can arrive many times per frame. Defer
    // the history resampling to one animation frame so a gesture cannot run
    // the O(history × binCount) rebuild repeatedly in the same frame.
    if (
      radioSdrViewportChanged
      && !selectedKindChanged
      && !openWebRXViewportChanged
      && !detailModeChanged
      && !radioSdrCenterViewChanged
    ) {
      this.scheduleReplaceBatch(options.axisTransition ?? 'immediate');
      return;
    }

    this.cancelScheduledReplaceBatch();
    this.pendingBatch = this.buildReplaceBatch();
    this.notifyFrameListeners();
  }

  pushFrame(frame: SpectrumFrame): void {
    const receivedAt = performance.now();
    if (this.lastArrivalTime > 0) {
      const interval = Math.min(500, receivedAt - this.lastArrivalTime);
      this.arrivalIntervalEma = this.arrivalIntervalEma * 0.7 + interval * 0.3;
    }
    this.lastArrivalTime = receivedAt;

    let values: Float32Array;
    try {
      values = decodeFrameValues(frame);
    } catch (error) {
      logger.warn('Failed to decode spectrum frame', error);
      return;
    }

    const retainedFrame = retainFrameMeta(frame);
    let supplement: RetainedSpectrumSupplement | null = null;
    if (frame.supplement) {
      try {
        supplement = {
          frequencyRange: { ...frame.supplement.frequencyRange },
          values: decodeSupplementValues(frame.supplement),
        };
      } catch (error) {
        logger.warn('Failed to decode spectrum frame supplement', error);
      }
    }
    const previousRadioFrame = frame.kind === 'radio-sdr' ? this.histories['radio-sdr'][0]?.frame ?? null : null;
    const radioSdrLevelChanged = frame.kind === 'radio-sdr'
      && previousRadioFrame !== null
      && !areLevelDescriptorsEqual(previousRadioFrame.level, retainedFrame.level);
    if (radioSdrLevelChanged) {
      this.histories['radio-sdr'].length = 0;
      this.pendingByKind['radio-sdr'].length = 0;
      this.invalidateCachedViews('radio-sdr');
    }
    const isConfirmingRadioSdrOptimisticIntent = this.isRadioSdrOptimisticIntentConfirmed(retainedFrame);
    if (isConfirmingRadioSdrOptimisticIntent) {
      this.clearRadioSdrOptimisticIntent({ notify: false });
    }

    const canonicalFrame = this.storeCanonicalFrame({
      frame: retainedFrame,
      values,
      supplement,
      receivedAt,
      cachedViewKey: null,
      cachedViewValues: null,
      cachedAxis: null,
    });
    if (frame.kind === this.context.selectedKind) {
      this.latestRenderSnapshotKey = null;
      this.latestRenderSnapshot = null;
    }

    const radioSdrViewRangeChanged = frame.kind === 'radio-sdr' && !this.gestureViewFreeze
      ? this.applyRadioSdrViewRange(this.resolveRadioSdrViewRange(), { notify: false })
      : false;

    if (frame.kind === this.context.selectedKind) {
      if (radioSdrViewRangeChanged || radioSdrLevelChanged) {
        this.pendingByKind[frame.kind].length = 0;
        this.scheduleReplaceBatch();
      } else {
        const pendingQueue = this.pendingByKind[frame.kind];
        // Queue the canonical frame object itself (not a copy) so view
        // projections cached while draining the queue also land on the
        // history entry and can be reused by the next viewport rebuild.
        (canonicalFrame as QueuedSpectrumFrame).queuedAt = receivedAt;
        pendingQueue.push(canonicalFrame as QueuedSpectrumFrame);
        this.trimPendingQueue(frame.kind);
        this.schedule();
      }
    }

    this.syncStatusSnapshot();
  }

  private schedule(): void {
    if (this.rafId !== null) {
      return;
    }

    this.rafId = requestAnimationFrame(this.processQueue);
  }

  private processQueue = (now: number): void => {
    this.rafId = null;
    const selectedKind = this.context.selectedKind;
    if (!selectedKind) {
      return;
    }

    const pendingQueue = this.pendingByKind[selectedKind];
    if (pendingQueue.length === 0) {
      return;
    }

    const frameDuration = Math.max(
      MIN_FRAME_DURATION_MS,
      this.configuredFrameIntervalMs ?? this.arrivalIntervalEma,
    );
    const idleFreezeThreshold = Math.max(IDLE_FREEZE_MIN_MS, this.arrivalIntervalEma * 2.5);
    const oldestQueuedAt = pendingQueue[0]?.queuedAt ?? now;
    const backlogAge = now - oldestQueuedAt;
    const shouldCatchUp = pendingQueue.length > 1 && (backlogAge > frameDuration * 1.25 || pendingQueue.length >= 4);

    if (!shouldCatchUp && now - this.lastRenderTime < frameDuration) {
      this.schedule();
      return;
    }

    const historyLimit = this.getHistoryLimit(selectedKind);
    const batchSize = this.determineBatchSize(pendingQueue.length, backlogAge, frameDuration, historyLimit);
    const frames = pendingQueue.splice(0, batchSize);
    const rows: Float32Array[] = [];
    const rowTimestamps: number[] = [];
    const transformedFrames: CanonicalSpectrumFrame[] = [];
    let axis: SpectrumAxis | null = null;
    let frameToken: number | null = null;

    for (const frame of frames) {
      const transformed = this.transformFrameForCurrentView(frame);
      if (!transformed) {
        continue;
      }
      rows.push(transformed.values);
      rowTimestamps.push(frame.frame.timestamp);
      transformedFrames.push(frame);
      axis = transformed.axis;
      frameToken = frame.frame.timestamp;
    }

    if (rows.length > 0) {
      this.lastRenderTime = now;
      const supplementProjection = this.buildSupplementProjection(transformedFrames);
      this.pendingBatch = {
        mode: 'append',
        rows,
        rowTimestamps,
        axis,
        frameToken,
        hasBacklog: pendingQueue.length > 0,
          totalRows: Math.min(
            this.histories[selectedKind].length,
            historyLimit,
            this.renderRowLimit ?? Number.POSITIVE_INFINITY,
          ),
        supplementRows: supplementProjection.rows,
        supplementAxis: supplementProjection.axis,
      };
      this.notifyFrameListeners();
    }

    if (pendingQueue.length > 0 || now - this.lastArrivalTime < idleFreezeThreshold) {
      this.schedule();
    }
  };

  private determineBatchSize(
    queueLength: number,
    backlogAge: number,
    frameDuration: number,
    historyLimit: number
  ): number {
    if (queueLength <= 1) {
      return 1;
    }

    let batchSize = 1;
    if (queueLength >= historyLimit / 2) {
      batchSize = Math.max(batchSize, 4);
    }
    if (queueLength >= historyLimit) {
      batchSize = Math.max(batchSize, 6);
    }
    if (backlogAge > frameDuration * 2) {
      batchSize = Math.max(batchSize, 2);
    }
    if (backlogAge > frameDuration * 4) {
      batchSize = Math.max(batchSize, 4);
    }
    if (backlogAge > frameDuration * 8) {
      batchSize = Math.max(batchSize, 6);
    }

    return Math.min(queueLength, MAX_BATCH_SIZE, batchSize);
  }

  private trimPendingQueue(kind: SpectrumKind): void {
    const pendingQueue = this.pendingByKind[kind];
    const overflow = pendingQueue.length - this.getHistoryLimit(kind);
    if (overflow > 0) {
      pendingQueue.splice(0, overflow);
    }
  }

  private getHistoryLimit(kind: SpectrumKind): number {
    return this.historyLimits[kind];
  }

  private storeCanonicalFrame(nextFrame: CanonicalSpectrumFrame): CanonicalSpectrumFrame {
    const history = this.histories[nextFrame.frame.kind];
    const existingIndex = history.findIndex(entry => entry.frame.timestamp === nextFrame.frame.timestamp);

    if (existingIndex >= 0) {
      history[existingIndex] = nextFrame;
      return nextFrame;
    }

    history.unshift(nextFrame);
    const historyLimit = this.getHistoryLimit(nextFrame.frame.kind);
    if (history.length > historyLimit) {
      history.length = historyLimit;
    }
    return nextFrame;
  }

  private buildReplaceBatch(axisTransition: 'animate' | 'immediate' = 'animate'): SpectrumRenderBatch {
    const selectedKind = this.context.selectedKind;
    if (!selectedKind) {
      return {
        mode: 'reset',
        rows: [],
        rowTimestamps: [],
        axis: null,
        frameToken: null,
        hasBacklog: false,
        totalRows: 0,
        supplementRows: [],
        supplementAxis: null,
      };
    }

    const history = this.renderRowLimit === null
      ? this.histories[selectedKind]
      : this.histories[selectedKind].slice(0, this.renderRowLimit);
    const rows: Float32Array[] = [];
    const rowTimestamps: number[] = [];
    const transformedFrames: CanonicalSpectrumFrame[] = [];
    let axis: SpectrumAxis | null = null;

    for (const frame of history) {
      const transformed = this.transformFrameForCurrentView(frame);
      if (!transformed) {
        continue;
      }
      rows.push(transformed.values);
      rowTimestamps.push(frame.frame.timestamp);
      transformedFrames.push(frame);
      if (!axis) {
        axis = transformed.axis;
      }
    }

    const supplementProjection = this.buildSupplementProjection(transformedFrames);

    return {
      mode: rows.length > 0 ? 'replace' : 'reset',
      rows,
      rowTimestamps,
      axis,
      frameToken: history[0]?.frame.timestamp ?? null,
      hasBacklog: false,
      totalRows: rows.length,
      axisTransition,
      supplementRows: supplementProjection.rows,
      supplementAxis: supplementProjection.axis,
    };
  }

  /**
   * Collect the wide-envelope supplement rows parallel to the given frames.
   * Rows stay at their native bins; frames whose supplement range differs
   * from the newest one are projected to it (cheap at supplement bin
   * counts), so the renderer can keep one supplement axis per batch.
   */
  private buildSupplementProjection(
    frames: CanonicalSpectrumFrame[],
  ): { rows: (Float32Array | null)[]; axis: SpectrumAxis | null } {
    let latest: CanonicalSpectrumFrame | null = null;
    for (const frame of frames) {
      if (frame.supplement && (!latest || frame.frame.timestamp >= latest.frame.timestamp)) {
        latest = frame;
      }
    }
    if (!latest?.supplement) {
      return { rows: frames.map(() => null), axis: null };
    }
    const axisRange = latest.supplement.frequencyRange;
    const rows = frames.map((frame) => {
      if (!frame.supplement) {
        return null;
      }
      if (areRangesEqual(frame.supplement.frequencyRange, axisRange)) {
        return frame.supplement.values;
      }
      return cropSpectrumToRange(
        frame.supplement.values,
        frame.supplement.frequencyRange,
        axisRange,
        frame.frame.level?.min ?? 0,
      );
    });
    return {
      rows,
      axis: {
        minHz: axisRange.min,
        maxHz: axisRange.max,
        binCount: latest.supplement.values.length,
      },
    };
  }

  private transformFrameForCurrentView(
    frame: CanonicalSpectrumFrame
  ): { values: Float32Array; axis: SpectrumAxis } | null {
    const selectedKind = this.context.selectedKind;
    if (!selectedKind || frame.frame.kind !== selectedKind) {
      return null;
    }

    const viewKey = buildViewKey(selectedKind, frame.frame, this.context);
    if (
      frame.cachedViewKey === viewKey
      && frame.cachedViewValues
      && frame.cachedAxis
    ) {
      return {
        values: frame.cachedViewValues,
        axis: frame.cachedAxis,
      };
    }

    let values: Float32Array;
    let axis: SpectrumAxis;

    // Reuse the previous projection buffer when its length still matches.
    // The previous projection becomes dead the moment the rebuilt batch is
    // handed to the renderer (synchronous handoff), and the crop loops
    // overwrite every element. Never reuse frame.values itself: when the
    // projection aliases the canonical frame (equal ranges) it must stay
    // immutable.
    const reusableOut = frame.cachedViewValues
      && frame.cachedViewValues !== frame.values
      && frame.cachedViewValues.length === frame.values.length
      ? frame.cachedViewValues
      : undefined;

    if (selectedKind === 'radio-sdr') {
      const range = this.context.radioSdrViewRange;
      if (!range) {
        return null;
      }
      values = frame.supplement
        ? cropSpectrumWithSupplement(
            frame.values,
            frame.frame.frequencyRange,
            frame.supplement,
            range,
            frame.frame.level?.min ?? 0,
            reusableOut,
          )
        : cropSpectrumToRange(
            frame.values,
            frame.frame.frequencyRange,
            range,
            frame.frame.level?.min ?? 0,
            reusableOut,
          );
      axis = {
        minHz: range.min,
        maxHz: range.max,
        binCount: values.length,
      };
    } else if (selectedKind === 'openwebrx-sdr' && !this.context.isOpenWebRXDetailMode) {
      const viewport = this.context.openWebRXViewport;
      if (!viewport) {
        return null;
      }
      values = cropSpectrumToViewport(frame.values, frame.frame.frequencyRange, viewport, reusableOut);
      axis = {
        minHz: viewport.centerHz - viewport.spanHz / 2,
        maxHz: viewport.centerHz + viewport.spanHz / 2,
        binCount: values.length,
      };
    } else {
      values = frame.values;
      axis = {
        minHz: frame.frame.frequencyRange.min,
        maxHz: frame.frame.frequencyRange.max,
        binCount: frame.frame.binCount,
      };
    }

    frame.cachedViewKey = viewKey;
    frame.cachedViewValues = values;
    frame.cachedAxis = axis;
    return { values, axis };
  }

  private isRadioSdrOptimisticIntentConfirmed(frame: RetainedSpectrumFrame): boolean {
    const intent = this.radioSdrOptimisticIntent;
    if (!intent || frame.kind !== 'radio-sdr') {
      return false;
    }

    if (this.isRadioSdrServerSyncHeld()) {
      return false;
    }

    const frameSpanHz = frame.frequencyRange.max - frame.frequencyRange.min;
    if (!Number.isFinite(frameSpanHz) || frameSpanHz <= 0) {
      return false;
    }

    const frameCenterHz = frame.frequencyRange.min + frameSpanHz / 2;
    const expectedCenterHz = intent.baselineFrameCenterHz + (intent.targetFrequencyHz - intent.baselineFrequencyHz);
    const toleranceHz = Math.max(
      RADIO_SDR_OPTIMISTIC_CONFIRM_MIN_HZ,
      frameSpanHz * RADIO_SDR_OPTIMISTIC_CONFIRM_SPAN_RATIO,
    );
    return Math.abs(frameCenterHz - expectedCenterHz) <= toleranceHz;
  }

  private isRadioSdrServerSyncHeld(now = Date.now()): boolean {
    return this.radioSdrServerSyncHoldUntil === Number.POSITIVE_INFINITY
      || (this.radioSdrServerSyncHoldUntil > 0 && now < this.radioSdrServerSyncHoldUntil);
  }

  private syncStatusSnapshot(): void {
    const selectedKind = this.context.selectedKind;
    const fullRange = this.getFullRange(selectedKind);
    const nextStatus: SpectrumStreamStatus = {
      hasData: Boolean(selectedKind && this.histories[selectedKind].length > 0),
      selectedKind,
      fullRange,
      displayRange: selectedKind ? (this.histories[selectedKind][0]?.frame.frequencyRange ?? null) : null,
      level: selectedKind ? (this.histories[selectedKind][0]?.frame.level ?? null) : null,
    };

    if (
      this.statusSnapshot.hasData === nextStatus.hasData
      && this.statusSnapshot.selectedKind === nextStatus.selectedKind
      && areRangesEqual(this.statusSnapshot.fullRange, nextStatus.fullRange)
      && areRangesEqual(this.statusSnapshot.displayRange, nextStatus.displayRange)
      && areLevelDescriptorsEqual(this.statusSnapshot.level, nextStatus.level)
    ) {
      return;
    }

    this.statusSnapshot = nextStatus;
    this.notifyStatusListeners();
  }

  private notifyFrameListeners(): void {
    for (const listener of this.frameListeners) {
      listener();
    }
  }

  private notifyStatusListeners(): void {
    for (const listener of this.statusListeners) {
      listener();
    }
  }
}
