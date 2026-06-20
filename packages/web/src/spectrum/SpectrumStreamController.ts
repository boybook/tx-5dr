import type { SpectrumFrame, SpectrumKind } from '@tx5dr/contracts';
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
}

export interface SpectrumRenderBatch {
  mode: 'reset' | 'replace' | 'append';
  rows: Float32Array[];
  rowTimestamps: number[];
  axis: SpectrumAxis | null;
  frameToken: number | null;
  hasBacklog: boolean;
  totalRows: number;
}

export type SpectrumHistoryLimits = number | Partial<Record<SpectrumKind, number>>;

interface RetainedSpectrumFrame {
  timestamp: number;
  kind: SpectrumKind;
  frequencyRange: { min: number; max: number };
  binCount: number;
}

interface CanonicalSpectrumFrame {
  frame: RetainedSpectrumFrame;
  values: Float32Array;
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
}

type HistoryMap = Record<SpectrumKind, CanonicalSpectrumFrame[]>;
type PendingMap = Record<SpectrumKind, QueuedSpectrumFrame[]>;
type HistoryLimitMap = Record<SpectrumKind, number>;

const DEFAULT_HISTORY = 120;
const SPECTRUM_KINDS: SpectrumKind[] = ['audio', 'radio-sdr', 'openwebrx-sdr'];
const DEFAULT_FRAME_DURATION_MS = 100;
const MIN_FRAME_DURATION_MS = 40;
const MAX_FRAME_DURATION_MS = 140;
const IDLE_FREEZE_MIN_MS = 300;
const MAX_BATCH_SIZE = 8;
const RADIO_SDR_OPTIMISTIC_TIMEOUT_MS = 2000;
const RADIO_SDR_OPTIMISTIC_CONFIRM_MIN_HZ = 50;
const RADIO_SDR_OPTIMISTIC_CONFIRM_SPAN_RATIO = 0.001;

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
    binCount: getBinCount(frame),
  };
}

export function cropSpectrumToRange(
  values: Float32Array,
  fullRange: { min: number; max: number },
  targetRange: { min: number; max: number }
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

  const output = new Float32Array(values.length);
  const maxIndex = values.length - 1;

  for (let index = 0; index < values.length; index += 1) {
    const targetFrequency = targetRange.min + (index * (targetRange.max - targetRange.min)) / Math.max(values.length - 1, 1);
    if (targetFrequency < fullRange.min || targetFrequency > fullRange.max) {
      output[index] = 0;
      continue;
    }

    const sourceRatio = (targetFrequency - fullRange.min) / fullSpan;
    const sourcePosition = Math.min(maxIndex, Math.max(0, sourceRatio * maxIndex));
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(maxIndex, leftIndex + 1);
    const factor = sourcePosition - leftIndex;
    output[index] = values[leftIndex] + (values[rightIndex] - values[leftIndex]) * factor;
  }

  return output;
}

function cropSpectrumToViewport(
  values: Float32Array,
  fullRange: { min: number; max: number },
  viewport: OpenWebRXViewport
): Float32Array {
  return cropSpectrumToRange(values, fullRange, {
    min: viewport.centerHz - viewport.spanHz / 2,
    max: viewport.centerHz + viewport.spanHz / 2,
  });
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
  };
  private statusSnapshot: SpectrumStreamStatus = {
    hasData: false,
    selectedKind: null,
    fullRange: null,
  };
  private pendingBatch: SpectrumRenderBatch | null = null;
  private rafId: number | null = null;
  private replaceRafId: number | null = null;
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

  getFullRange = (kind: SpectrumKind | null): { min: number; max: number } | null => {
    if (!kind) {
      return null;
    }

    const latest = this.histories[kind][0]?.frame ?? null;
    return latest ? latest.frequencyRange : null;
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
    this.context = {
      ...this.context,
      radioSdrViewRange: null,
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
    return latestFrame ? { ...latestFrame.frequencyRange } : null;
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
    return this.applyRadioSdrCenterViewRange(fullRange);
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
    this.invalidateCachedViews('radio-sdr');
    if (options.notify !== false) {
      this.rebuildSelectedViewIfNeeded('radio-sdr');
    }
    return true;
  }

  private scheduleReplaceBatch(): void {
    this.pendingBatch = null;
    if (this.replaceRafId !== null) {
      return;
    }

    this.replaceRafId = requestAnimationFrame(() => {
      this.replaceRafId = null;
      this.pendingBatch = this.buildReplaceBatch();
      this.notifyFrameListeners();
    });
  }

  private cancelScheduledReplaceBatch(): void {
    if (this.replaceRafId !== null) {
      cancelAnimationFrame(this.replaceRafId);
      this.replaceRafId = null;
    }
  }

  updateContext(nextContext: Partial<StreamContext>): void {
    const previous = this.context;
    this.context = {
      ...previous,
      ...nextContext,
      radioSdrCenterViewMode: nextContext.radioSdrCenterViewMode ?? previous.radioSdrCenterViewMode,
      radioSdrReferenceFrequencyHz: 'radioSdrReferenceFrequencyHz' in nextContext
        ? normalizeRadioSdrReferenceFrequency(nextContext.radioSdrReferenceFrequencyHz)
        : previous.radioSdrReferenceFrequencyHz,
    };

    const selectedKindChanged = previous.selectedKind !== this.context.selectedKind;
    const openWebRXViewportChanged = !areViewportsEqual(previous.openWebRXViewport, this.context.openWebRXViewport);
    const detailModeChanged = previous.isOpenWebRXDetailMode !== this.context.isOpenWebRXDetailMode;
    const radioSdrCenterViewChanged = previous.radioSdrCenterViewMode !== this.context.radioSdrCenterViewMode
      || previous.radioSdrReferenceFrequencyHz !== this.context.radioSdrReferenceFrequencyHz;
    if (radioSdrCenterViewChanged) {
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
    const isConfirmingRadioSdrOptimisticIntent = this.isRadioSdrOptimisticIntentConfirmed(retainedFrame);
    if (isConfirmingRadioSdrOptimisticIntent) {
      this.clearRadioSdrOptimisticIntent({ notify: false });
    }

    const canonicalFrame = this.storeCanonicalFrame({
      frame: retainedFrame,
      values,
      receivedAt,
      cachedViewKey: null,
      cachedViewValues: null,
      cachedAxis: null,
    });

    const radioSdrViewRangeChanged = frame.kind === 'radio-sdr'
      ? this.applyRadioSdrViewRange(this.resolveRadioSdrViewRange(), { notify: false })
      : false;

    if (frame.kind === this.context.selectedKind) {
      if (radioSdrViewRangeChanged) {
        this.pendingByKind[frame.kind].length = 0;
        this.scheduleReplaceBatch();
      } else {
        const pendingQueue = this.pendingByKind[frame.kind];
        pendingQueue.push({
          ...canonicalFrame,
          queuedAt: receivedAt,
        });
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

    const frameDuration = Math.max(MIN_FRAME_DURATION_MS, Math.min(MAX_FRAME_DURATION_MS, this.arrivalIntervalEma));
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
    let axis: SpectrumAxis | null = null;
    let frameToken: number | null = null;

    for (const frame of frames) {
      const transformed = this.transformFrameForCurrentView(frame);
      if (!transformed) {
        continue;
      }
      rows.push(transformed.values);
      rowTimestamps.push(frame.frame.timestamp);
      axis = transformed.axis;
      frameToken = frame.frame.timestamp;
    }

    if (rows.length > 0) {
      this.lastRenderTime = now;
      this.pendingBatch = {
        mode: 'append',
        rows,
        rowTimestamps,
        axis,
        frameToken,
        hasBacklog: pendingQueue.length > 0,
        totalRows: Math.min(this.histories[selectedKind].length, historyLimit),
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

  private buildReplaceBatch(): SpectrumRenderBatch {
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
      };
    }

    const history = this.histories[selectedKind];
    const rows: Float32Array[] = [];
    const rowTimestamps: number[] = [];
    let axis: SpectrumAxis | null = null;

    for (const frame of history) {
      const transformed = this.transformFrameForCurrentView(frame);
      if (!transformed) {
        continue;
      }
      rows.push(transformed.values);
      rowTimestamps.push(frame.frame.timestamp);
      if (!axis) {
        axis = transformed.axis;
      }
    }

    return {
      mode: rows.length > 0 ? 'replace' : 'reset',
      rows,
      rowTimestamps,
      axis,
      frameToken: history[0]?.frame.timestamp ?? null,
      hasBacklog: false,
      totalRows: rows.length,
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

    if (selectedKind === 'radio-sdr') {
      const range = this.context.radioSdrViewRange;
      if (!range) {
        return null;
      }
      values = cropSpectrumToRange(frame.values, frame.frame.frequencyRange, range);
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
      values = cropSpectrumToViewport(frame.values, frame.frame.frequencyRange, viewport);
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
    };

    if (
      this.statusSnapshot.hasData === nextStatus.hasData
      && this.statusSnapshot.selectedKind === nextStatus.selectedKind
      && areRangesEqual(this.statusSnapshot.fullRange, nextStatus.fullRange)
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
