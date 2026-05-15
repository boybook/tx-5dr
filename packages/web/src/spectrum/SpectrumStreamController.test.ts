import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import type { SpectrumFrame, SpectrumKind } from '@tx5dr/contracts';
import { SpectrumStreamController, cropSpectrumToRange } from './SpectrumStreamController';

type ControllerInternals = {
  histories: Record<SpectrumKind, Array<{
    frame: {
      timestamp: number;
      kind: SpectrumKind;
      frequencyRange: { min: number; max: number };
      binCount: number;
      binaryData?: unknown;
    };
    values: Float32Array;
  }>>;
  pendingByKind: Record<SpectrumKind, unknown[]>;
  frameListeners: Set<() => void>;
  statusListeners: Set<() => void>;
  rafId: number | null;
};

const allKinds: SpectrumKind[] = ['audio', 'radio-sdr', 'openwebrx-sdr'];

function getInternals(controller: SpectrumStreamController): ControllerInternals {
  return controller as unknown as ControllerInternals;
}

function makeFrame(
  kind: SpectrumKind,
  timestamp: number,
  values: number[],
  frequencyRange: { min: number; max: number } = { min: 0, max: 3000 }
): SpectrumFrame {
  const pcm = new Int16Array(values);
  return {
    timestamp,
    kind,
    frequencyRange,
    binaryData: {
      data: Buffer.from(pcm.buffer).toString('base64'),
      format: {
        type: 'int16',
        length: values.length,
        scale: 1,
        offset: 0,
      },
    },
    meta: {
      sourceBinCount: values.length,
      displayBinCount: values.length,
    },
  };
}

describe('SpectrumStreamController memory behavior', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let cancelAnimationFrameMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 1;
    cancelAnimationFrameMock = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    vi.stubGlobal('atob', (input: string) => Buffer.from(input, 'base64').toString('binary'));
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = nextRafId;
      nextRafId += 1;
      rafCallbacks.set(id, callback);
      return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushNextAnimationFrame(now = 1000): void {
    const nextEntry = rafCallbacks.entries().next();
    if (nextEntry.done) {
      throw new Error('No animation frame callback is queued');
    }
    const [id, callback] = nextEntry.value;
    rafCallbacks.delete(id);
    callback(now);
  }

  it('does not retain raw base64 payloads in history', () => {
    const controller = new SpectrumStreamController(3);
    const sourceFrame = makeFrame('audio', 1, Array.from({ length: 1024 }, (_, index) => index % 100));

    controller.pushFrame(sourceFrame);

    const retained = getInternals(controller).histories.audio[0];
    expect(retained.values).toBeInstanceOf(Float32Array);
    expect(retained.frame.binaryData).toBeUndefined();
    expect(JSON.stringify(retained.frame)).not.toContain(sourceFrame.binaryData.data);
  });

  it('trims each spectrum kind with its own history limit', () => {
    const controller = new SpectrumStreamController({
      audio: 3,
      'radio-sdr': 2,
      'openwebrx-sdr': 1,
    });

    for (const kind of allKinds) {
      for (let index = 0; index < 5; index += 1) {
        controller.pushFrame(makeFrame(kind, index + 1, [index]));
      }
    }

    const internals = getInternals(controller);
    expect(internals.histories.audio).toHaveLength(3);
    expect(internals.histories['radio-sdr']).toHaveLength(2);
    expect(internals.histories['openwebrx-sdr']).toHaveLength(1);
    expect(internals.histories.audio.map(entry => entry.frame.timestamp)).toEqual([5, 4, 3]);
    expect(internals.histories['radio-sdr'].map(entry => entry.frame.timestamp)).toEqual([5, 4]);
    expect(internals.histories['openwebrx-sdr'].map(entry => entry.frame.timestamp)).toEqual([5]);
  });

  it('clears histories, pending queues and scheduled frames on reset', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({ selectedKind: 'audio' });
    const frameListener = vi.fn();
    controller.subscribeFrameTick(frameListener);

    controller.pushFrame(makeFrame('audio', 1, [1, 2, 3]));
    expect(getInternals(controller).pendingByKind.audio).toHaveLength(1);
    expect(rafCallbacks.size).toBe(1);

    controller.reset();

    const internals = getInternals(controller);
    expect(internals.histories.audio).toHaveLength(0);
    expect(internals.pendingByKind.audio).toHaveLength(0);
    expect(internals.rafId).toBeNull();
    expect(cancelAnimationFrameMock).toHaveBeenCalled();
    expect(controller.consumeRenderBatch()?.mode).toBe('reset');
    expect(frameListener).toHaveBeenCalled();
  });

  it('clears histories, pending queues, listeners and RAF on destroy', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({ selectedKind: 'audio' });
    controller.subscribeFrameTick(() => {});
    controller.subscribeStatus(() => {});
    controller.pushFrame(makeFrame('audio', 1, [1, 2, 3]));

    controller.destroy();

    const internals = getInternals(controller);
    expect(internals.histories.audio).toHaveLength(0);
    expect(internals.pendingByKind.audio).toHaveLength(0);
    expect(internals.frameListeners.size).toBe(0);
    expect(internals.statusListeners.size).toBe(0);
    expect(internals.rafId).toBeNull();
    expect(controller.consumeRenderBatch()).toBeNull();
    expect(cancelAnimationFrameMock).toHaveBeenCalled();
  });

  it('uses radio SDR frame-native range and axis metadata', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({
      selectedKind: 'radio-sdr',
    });

    controller.pushFrame(makeFrame('radio-sdr', 10, [0, 100, 200, 300, 400], { min: 0, max: 400 }));
    flushNextAnimationFrame();
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('replace');
    expect(batch?.axis).toEqual({ minHz: 0, maxHz: 400, binCount: 5 });
    expect(batch?.rowTimestamps).toEqual([10]);
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([0, 100, 200, 300, 400]);
  });

  it('reuses spectrum rows when cropping to the same source range', () => {
    const values = new Float32Array([0, 100, 200]);
    const cropped = cropSpectrumToRange(values, { min: 900, max: 1100 }, { min: 900, max: 1100 });

    expect(cropped).toBe(values);
  });

  it('ignores stale radio SDR display ranges that do not overlap the incoming frame', () => {
    const controller = new SpectrumStreamController(4);
    const legacyController = controller as unknown as {
      updateContext(nextContext: {
        selectedKind: SpectrumKind;
        radioSdrDisplayRange: { min: number; max: number };
      }): void;
    };
    legacyController.updateContext({
      selectedKind: 'radio-sdr',
      radioSdrDisplayRange: { min: 1_000, max: 2_000 },
    });

    controller.pushFrame(makeFrame('radio-sdr', 10, [10, 20, 30, 40, 50], { min: 0, max: 400 }));
    flushNextAnimationFrame();
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('replace');
    expect(batch?.axis).toEqual({ minHz: 0, maxHz: 400, binCount: 5 });
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([10, 20, 30, 40, 50]);
  });

  it('remaps cached radio SDR history when the latest frame range changes', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({ selectedKind: 'radio-sdr' });
    controller.pushFrame(makeFrame('radio-sdr', 10, [0, 100, 200], { min: 900, max: 1100 }));
    flushNextAnimationFrame();
    controller.consumeRenderBatch();

    controller.pushFrame(makeFrame('radio-sdr', 11, [10, 110, 210], { min: 1000, max: 1200 }));
    flushNextAnimationFrame();
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('replace');
    expect(batch?.axis).toEqual({ minHz: 1000, maxHz: 1200, binCount: 3 });
    expect(batch?.rowTimestamps).toEqual([11, 10]);
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([10, 110, 210]);
    expect(Array.from(batch?.rows[1] ?? [])).toEqual([100, 200, 0]);
  });

  it('optimistically remaps cached radio SDR history after a local frequency intent', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({ selectedKind: 'radio-sdr' });
    controller.pushFrame(makeFrame('radio-sdr', 10, [0, 100, 200], { min: 900, max: 1100 }));
    flushNextAnimationFrame();
    controller.consumeRenderBatch();

    controller.setRadioSdrOptimisticFrequencyIntent({
      targetFrequencyHz: 1010,
      baselineFrequencyHz: 1000,
      baselineFrameCenterHz: 1000,
    });
    flushNextAnimationFrame();
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('replace');
    expect(batch?.axis).toEqual({ minHz: 910, maxHz: 1110, binCount: 3 });
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([10, 110, 0]);

    controller.setRadioSdrOptimisticFrequencyIntent(null);
  });

  it('keeps the newest optimistic radio SDR offset for stale frames during pending tuning', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({ selectedKind: 'radio-sdr' });
    controller.pushFrame(makeFrame('radio-sdr', 10, [0, 100, 200], { min: 900, max: 1100 }));
    flushNextAnimationFrame();
    controller.consumeRenderBatch();

    controller.setRadioSdrOptimisticFrequencyIntent({
      targetFrequencyHz: 1100,
      baselineFrequencyHz: 1000,
      baselineFrameCenterHz: 1000,
    });
    flushNextAnimationFrame();
    controller.consumeRenderBatch();

    controller.pushFrame(makeFrame('radio-sdr', 11, [10, 110, 210], { min: 900, max: 1100 }));
    flushNextAnimationFrame(1200);
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('append');
    expect(batch?.axis).toEqual({ minHz: 1000, maxHz: 1200, binCount: 3 });
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([110, 210, 0]);

    controller.setRadioSdrOptimisticFrequencyIntent(null);
  });

  it('uses only the latest optimistic radio SDR intent when tuning changes rapidly', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({ selectedKind: 'radio-sdr' });
    controller.pushFrame(makeFrame('radio-sdr', 10, [0, 100, 200], { min: 900, max: 1100 }));
    flushNextAnimationFrame();
    controller.consumeRenderBatch();

    controller.setRadioSdrOptimisticFrequencyIntent({
      targetFrequencyHz: 1100,
      baselineFrequencyHz: 1000,
      baselineFrameCenterHz: 1000,
    });
    flushNextAnimationFrame();
    controller.consumeRenderBatch();
    controller.setRadioSdrOptimisticFrequencyIntent({
      targetFrequencyHz: 1200,
      baselineFrequencyHz: 1000,
      baselineFrameCenterHz: 1000,
    });
    flushNextAnimationFrame();
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('replace');
    expect(batch?.axis).toEqual({ minHz: 1100, maxHz: 1300, binCount: 3 });
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([200, 0, 0]);

    controller.setRadioSdrOptimisticFrequencyIntent(null);
  });

  it('coalesces rapid radio SDR view range changes into one replace batch per RAF', () => {
    const controller = new SpectrumStreamController(4);
    const frameListener = vi.fn();
    controller.updateContext({ selectedKind: 'radio-sdr' });
    controller.subscribeFrameTick(frameListener);
    controller.pushFrame(makeFrame('radio-sdr', 10, [0, 100, 200], { min: 900, max: 1100 }));
    flushNextAnimationFrame();
    controller.consumeRenderBatch();
    frameListener.mockClear();

    controller.setRadioSdrOptimisticFrequencyIntent({
      targetFrequencyHz: 1100,
      baselineFrequencyHz: 1000,
      baselineFrameCenterHz: 1000,
    });
    controller.setRadioSdrOptimisticFrequencyIntent({
      targetFrequencyHz: 1200,
      baselineFrequencyHz: 1000,
      baselineFrameCenterHz: 1000,
    });

    expect(rafCallbacks.size).toBe(1);
    flushNextAnimationFrame();
    const batch = controller.consumeRenderBatch();

    expect(frameListener).toHaveBeenCalledTimes(1);
    expect(batch?.mode).toBe('replace');
    expect(batch?.axis).toEqual({ minHz: 1100, maxHz: 1300, binCount: 3 });

    controller.setRadioSdrOptimisticFrequencyIntent(null);
  });

  it('clears optimistic radio SDR offset when a confirming frame arrives', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({ selectedKind: 'radio-sdr' });
    controller.pushFrame(makeFrame('radio-sdr', 10, [0, 100, 200], { min: 900, max: 1100 }));
    flushNextAnimationFrame();
    controller.consumeRenderBatch();

    controller.setRadioSdrOptimisticFrequencyIntent({
      targetFrequencyHz: 1100,
      baselineFrequencyHz: 1000,
      baselineFrameCenterHz: 1000,
    });
    flushNextAnimationFrame();
    controller.consumeRenderBatch();

    controller.pushFrame(makeFrame('radio-sdr', 11, [10, 110, 210], { min: 1000, max: 1200 }));
    flushNextAnimationFrame();
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('replace');
    expect(batch?.axis).toEqual({ minHz: 1000, maxHz: 1200, binCount: 3 });
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([10, 110, 210]);
    expect(Array.from(batch?.rows[1] ?? [])).toEqual([100, 200, 0]);
  });

  it('falls back to the latest native radio SDR range when optimistic tuning times out', () => {
    vi.useFakeTimers();
    try {
      const controller = new SpectrumStreamController(4);
      controller.updateContext({ selectedKind: 'radio-sdr' });
      controller.pushFrame(makeFrame('radio-sdr', 10, [0, 100, 200], { min: 900, max: 1100 }));
      flushNextAnimationFrame();
      controller.consumeRenderBatch();

      controller.setRadioSdrOptimisticFrequencyIntent({
        targetFrequencyHz: 1100,
        baselineFrequencyHz: 1000,
        baselineFrameCenterHz: 1000,
        timeoutMs: 10,
      });
      flushNextAnimationFrame();
      controller.consumeRenderBatch();

      vi.advanceTimersByTime(10);
      flushNextAnimationFrame();
      const batch = controller.consumeRenderBatch();

      expect(batch?.mode).toBe('replace');
      expect(batch?.axis).toEqual({ minHz: 900, maxHz: 1100, binCount: 3 });
      expect(Array.from(batch?.rows[0] ?? [])).toEqual([0, 100, 200]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a full bounded radio SDR history when rebuilding the selected view', () => {
    const controller = new SpectrumStreamController({
      audio: 120,
      'radio-sdr': 120,
      'openwebrx-sdr': 40,
    });
    controller.updateContext({
      selectedKind: 'radio-sdr',
    });

    for (let index = 0; index < 130; index += 1) {
      controller.pushFrame(makeFrame(
        'radio-sdr',
        index + 1,
        [index, index + 100, index + 200, index + 300, index + 400],
        { min: 0, max: 400 }
      ));
    }

    controller.updateContext({
      selectedKind: 'audio',
    });
    controller.consumeRenderBatch();

    controller.updateContext({
      selectedKind: 'radio-sdr',
    });
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('replace');
    expect(batch?.rows).toHaveLength(120);
    expect(batch?.rowTimestamps).toHaveLength(120);
    expect(batch?.rowTimestamps[0]).toBe(130);
    expect(batch?.rowTimestamps[119]).toBe(11);
    expect(batch?.totalRows).toBe(120);
    expect(batch?.axis).toEqual({ minHz: 0, maxHz: 400, binCount: 5 });
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([129, 229, 329, 429, 529]);
    expect(getInternals(controller).histories['radio-sdr']).toHaveLength(120);
  });

  it('keeps OpenWebRX viewport transforms and axis metadata', () => {
    const controller = new SpectrumStreamController(4);
    controller.updateContext({
      selectedKind: 'openwebrx-sdr',
      openWebRXViewport: { centerHz: 200, spanHz: 200 },
      isOpenWebRXDetailMode: false,
    });

    controller.pushFrame(makeFrame('openwebrx-sdr', 11, [0, 100, 200, 300, 400], { min: 0, max: 400 }));
    flushNextAnimationFrame();
    const batch = controller.consumeRenderBatch();

    expect(batch?.mode).toBe('append');
    expect(batch?.axis).toEqual({ minHz: 100, maxHz: 300, binCount: 5 });
    expect(batch?.rowTimestamps).toEqual([11]);
    expect(Array.from(batch?.rows[0] ?? [])).toEqual([100, 150, 200, 250, 300]);
  });
});
