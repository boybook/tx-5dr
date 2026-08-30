import { EventEmitter } from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import { SpectrumSessionCoordinator } from '../SpectrumSessionCoordinator.js';

class MockEngine extends EventEmitter<Record<string, never>> {
  engineMode: 'digital' | 'voice' | 'cw' = 'digital';
  currentModeName: 'FT8' | 'FT4' | 'VOICE' | 'CW' = 'FT8';

  readonly radioManager = {
    getActiveConnection: vi.fn((): any => null),
    getConfig: vi.fn(() => ({ type: 'icom-wlan' })),
    getCoreCapabilities: vi.fn(() => ({ readRadioMode: true })),
    getFrequency: vi.fn(),
    getIcomWlanManager: vi.fn((): any => null),
    getMode: vi.fn(),
    isConnected: vi.fn(() => false),
    isCriticalRadioOperationActive: vi.fn(() => false),
    isSessionMutationInProgress: vi.fn(() => false),
  };

  getRadioManager() {
    return this.radioManager as any;
  }

  getEngineMode() {
    return this.engineMode;
  }

  getStatus() {
    return { currentMode: { name: this.currentModeName } };
  }
}

function seedRadioSdrFrame(coordinator: SpectrumSessionCoordinator, frequency = 14_050_000) {
  (coordinator as any).lastKnownRadioFrequency = frequency;
  (coordinator as any).lastRadioFrame = {
    timestamp: Date.now(),
    kind: 'radio-sdr',
    frequencyRange: { min: frequency - 5_000, max: frequency + 5_000 },
    binaryData: {
      data: '',
      format: { type: 'int16', length: 1 },
    },
    meta: {
      sourceBinCount: 1,
      displayBinCount: 1,
      centerFrequency: frequency,
      spanHz: 10_000,
    },
  };
}

function createBusySnapshot(busy: boolean) {
  return {
    busy,
    backpressure: busy,
    criticalActive: false,
    activeCount: busy ? 1 : 0,
    activeTask: busy ? 'getFrequency' : null,
    activeRunMs: busy ? 6000 : null,
    pendingCount: busy ? 2 : 0,
    criticalPendingCount: 0,
    normalPendingCount: busy ? 2 : 0,
    oldestPendingTask: busy ? 'getLockMode' : null,
    oldestPendingWaitMs: busy ? 1000 : null,
    dedupedTaskCount: 0,
  };
}

describe('SpectrumSessionCoordinator', () => {
  it('prefers numeric mode bandwidth for the voice overlay and keeps it cached across transient read failures', async () => {
    const engine = new MockEngine();
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    const resolveVoiceState = (coordinator as any).resolveVoiceState.bind(coordinator) as (
      currentRadioFrequency: number | null,
    ) => Promise<{
      bandwidthLabel: string | null;
      occupiedBandwidthHz: number | null;
      offsetModel: string | null;
      radioMode: string | null;
    }>;

    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getMode
      .mockResolvedValueOnce({ mode: 'USB', bandwidth: 2400 })
      .mockRejectedValueOnce(new Error('temporary read failure'));

    const firstState = await resolveVoiceState(null);
    expect(firstState).toMatchObject({
      radioMode: 'USB',
      bandwidthLabel: '2400 Hz',
      occupiedBandwidthHz: 2400,
      offsetModel: 'upper',
    });

    const recoveredFromCacheState = await resolveVoiceState(null);
    expect(recoveredFromCacheState).toMatchObject({
      radioMode: 'USB',
      bandwidthLabel: '2400 Hz',
      occupiedBandwidthHz: 2400,
      offsetModel: 'upper',
    });
  });

  it('derives ICOM WLAN scope span from the latest frame instead of polling CAT', async () => {
    const engine = new MockEngine();
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    const getCurrentSpectrumSpan = vi.fn().mockResolvedValue(25_000);
    const controller = {
      frameSpanScale: 2,
      preferFrameSpan: true,
      getSupportedSpans: vi.fn().mockResolvedValue([25_000, 50_000]),
      getCurrentSpan: getCurrentSpectrumSpan,
      setSpan: vi.fn(),
    };
    (coordinator as any).lastRadioFrame = {
      kind: 'radio-sdr',
      frequencyRange: { min: 7_050_000, max: 7_150_000 },
      meta: { spanHz: 100_000 },
    };

    const span = await (coordinator as any).resolveCurrentSpan(controller, null);

    expect(span).toBe(50_000);
    expect(getCurrentSpectrumSpan).not.toHaveBeenCalled();
  });

  it('does not issue CAT-backed spectrum reads while a radio session mutation is active', async () => {
    const engine = new MockEngine();
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    const connection = {
      configureSpectrumDisplay: vi.fn(),
      getSpectrumDisplayState: vi.fn().mockRejectedValue(new Error('must not read spectrum state')),
    };

    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.isSessionMutationInProgress.mockReturnValue(true);
    engine.radioManager.getActiveConnection.mockReturnValue(connection);

    const state = await coordinator.refresh('radio-sdr');

    expect(state.kind).toBe('radio-sdr');
    expect(connection.getSpectrumDisplayState).not.toHaveBeenCalled();
    expect(engine.radioManager.getMode).not.toHaveBeenCalled();
  });

  it('does not issue CAT-backed spectrum reads while the radio I/O queue is busy', async () => {
    const engine = new MockEngine();
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    const connection = {
      configureSpectrumDisplay: vi.fn(),
      getSpectrumDisplayState: vi.fn().mockRejectedValue(new Error('must not read spectrum state')),
      getRadioIoQueueSnapshot: vi.fn(() => ({
        busy: true,
        backpressure: true,
        criticalActive: false,
        activeCount: 1,
        activeTask: 'startManagedSpectrum',
        activeRunMs: 6000,
        pendingCount: 3,
        criticalPendingCount: 0,
        normalPendingCount: 3,
        oldestPendingTask: 'getSpectrumDisplayState',
        oldestPendingWaitMs: 2000,
        dedupedTaskCount: 1,
      })),
    };

    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getActiveConnection.mockReturnValue(connection);

    const state = await coordinator.refresh('radio-sdr');

    expect(state.kind).toBe('radio-sdr');
    expect(connection.getSpectrumDisplayState).not.toHaveBeenCalled();
    expect(engine.radioManager.getMode).not.toHaveBeenCalled();
  });

  it('does not derive radio SDR display range from CAT fixed edges before frames arrive', async () => {
    const engine = new MockEngine();
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    const connection = {
      configureSpectrumDisplay: vi.fn(),
      getSpectrumDisplayState: vi.fn().mockResolvedValue({
        mode: 'fixed',
        edgeLowHz: 14_073_000,
        edgeHighHz: 14_078_000,
        spanHz: 5000,
        supportsFixedEdges: true,
        supportedSpans: [5000, 10_000],
      }),
      getRadioIoQueueSnapshot: vi.fn(() => createBusySnapshot(false)),
    };

    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getActiveConnection.mockReturnValue(connection);
    engine.radioManager.getFrequency.mockResolvedValue(14_074_000);

    const state = await coordinator.refresh('radio-sdr');

    expect(state.displayRange).toBeNull();
    expect(state.edgeLowHz).toBe(14_073_000);
    expect(state.edgeHighHz).toBe(14_078_000);
  });

  it('reuses cached digital window controls while the radio I/O queue is busy', async () => {
    const engine = new MockEngine();
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    const frequency = 14_074_000;
    let busy = false;
    const connection = {
      configureSpectrumDisplay: vi.fn(),
      getSpectrumDisplayState: vi.fn().mockResolvedValue({
        mode: 'fixed',
        edgeLowHz: frequency - 1000,
        edgeHighHz: frequency + 4000,
        spanHz: 5000,
        supportsFixedEdges: true,
        supportedSpans: [5000, 10_000],
      }),
      getRadioIoQueueSnapshot: vi.fn(() => createBusySnapshot(busy)),
    };

    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getActiveConnection.mockReturnValue(connection);
    seedRadioSdrFrame(coordinator, frequency);
    (coordinator as any).lastRadioFrame.frequencyRange = {
      min: frequency - 1000,
      max: frequency + 4000,
    };
    (coordinator as any).lastRadioFrame.meta.spanHz = 5000;

    const first = await coordinator.refresh('radio-sdr');
    const firstDigitalControl = first.controls.find(control => control.id === 'digital-window-toggle');
    expect(firstDigitalControl).toMatchObject({
      visible: true,
      enabled: true,
      active: true,
    });

    busy = true;
    connection.getSpectrumDisplayState.mockClear();
    (coordinator as any).markDirty();
    const second = await coordinator.refresh('radio-sdr');
    const secondDigitalControl = second.controls.find(control => control.id === 'digital-window-toggle');

    expect(connection.getSpectrumDisplayState).not.toHaveBeenCalled();
    expect(secondDigitalControl).toEqual(firstDigitalControl);
  });

  it('reuses cached zoom controls while the radio I/O queue is busy', async () => {
    const engine = new MockEngine();
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    let busy = false;
    const activeConnection = {
      getSpectrumDisplayState: vi.fn().mockResolvedValue({
        mode: 'center',
        spanHz: 10_000,
        supportsFixedEdges: true,
        supportedSpans: [5000, 10_000, 20_000],
      }),
      getRadioIoQueueSnapshot: vi.fn(() => createBusySnapshot(busy)),
    };
    const zoomConnection = {
      frameSpanScale: 1,
      preferFrameSpan: false,
      getSupportedSpans: vi.fn().mockResolvedValue([20_000, 10_000, 5000]),
      getCurrentSpan: vi.fn().mockResolvedValue(10_000),
      setSpan: vi.fn(),
    };

    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getActiveConnection.mockReturnValue(activeConnection);
    vi.spyOn(coordinator as any, 'getZoomCapableConnection').mockReturnValue(zoomConnection);
    seedRadioSdrFrame(coordinator);

    const first = await coordinator.refresh('radio-sdr');
    const firstZoomControls = first.controls.filter(control => control.id === 'zoom-step');
    expect(firstZoomControls).toHaveLength(2);
    expect(firstZoomControls.every(control => control.visible && control.enabled)).toBe(true);

    busy = true;
    activeConnection.getSpectrumDisplayState.mockClear();
    zoomConnection.getSupportedSpans.mockClear();
    zoomConnection.getCurrentSpan.mockClear();
    (coordinator as any).markDirty();
    const second = await coordinator.refresh('radio-sdr');
    const secondZoomControls = second.controls.filter(control => control.id === 'zoom-step');

    expect(activeConnection.getSpectrumDisplayState).not.toHaveBeenCalled();
    expect(zoomConnection.getSupportedSpans).not.toHaveBeenCalled();
    expect(zoomConnection.getCurrentSpan).not.toHaveBeenCalled();
    expect(secondZoomControls).toEqual(firstZoomControls);
  });

  it('clears cached digital-only controls after leaving digital mode', async () => {
    const engine = new MockEngine();
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    const connection = {
      configureSpectrumDisplay: vi.fn(),
      getSpectrumDisplayState: vi.fn().mockResolvedValue({
        mode: 'fixed',
        edgeLowHz: 14_073_000,
        edgeHighHz: 14_078_000,
        spanHz: 5000,
        supportsFixedEdges: true,
        supportedSpans: [5000, 10_000],
      }),
      getRadioIoQueueSnapshot: vi.fn(() => createBusySnapshot(false)),
    };

    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getActiveConnection.mockReturnValue(connection);
    seedRadioSdrFrame(coordinator, 14_074_000);

    const digitalState = await coordinator.refresh('radio-sdr');
    expect(digitalState.controls.some(control => control.id === 'digital-window-toggle')).toBe(true);

    engine.engineMode = 'voice';
    engine.currentModeName = 'VOICE';
    (coordinator as any).markDirty();
    const voiceState = await coordinator.refresh('radio-sdr');

    expect(voiceState.controls.some(control => control.id === 'digital-window-toggle')).toBe(false);
  });

  it('enables CW radio SDR RF gestures without digital operator markers', async () => {
    const engine = new MockEngine();
    engine.engineMode = 'cw';
    engine.currentModeName = 'CW';
    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getMode.mockResolvedValue({ mode: 'CW', bandwidth: 500 });
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    seedRadioSdrFrame(coordinator);

    const state = await coordinator.refresh('radio-sdr');

    expect(state.kind).toBe('radio-sdr');
    expect(state.interaction).toMatchObject({
      showTxMarkers: false,
      showRxMarkers: false,
      canDragTx: false,
      canDragFrequency: true,
      canRightClickSetFrequency: true,
      canDoubleClickSetFrequency: true,
      frequencyGestureTarget: 'radio-frequency',
      frequencyStepHz: 10,
    });
  });

  it('keeps digital radio SDR operator marker semantics unchanged', async () => {
    const engine = new MockEngine();
    engine.engineMode = 'digital';
    engine.currentModeName = 'FT8';
    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getMode.mockResolvedValue({ mode: 'USB', bandwidth: 3000 });
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    seedRadioSdrFrame(coordinator);

    const state = await coordinator.refresh('radio-sdr');

    expect(state.interaction).toMatchObject({
      showTxMarkers: true,
      showRxMarkers: true,
      canDragTx: true,
      canDragFrequency: false,
      canRightClickSetFrequency: true,
      canDoubleClickSetFrequency: false,
      frequencyGestureTarget: 'operator-tx',
      frequencyStepHz: 1,
    });
  });

  it('exposes TCI IQ sample-rate zoom without the unsupported digital window control', async () => {
    const engine = new MockEngine();
    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getConfig.mockReturnValue({ type: 'tci' } as any);
    engine.radioManager.getMode.mockResolvedValue({ mode: 'DIGU', bandwidth: 3000 });
    const setSpan = vi.fn().mockResolvedValue(48_000);
    const spanController = {
      frameSpanScale: 1,
      preferFrameSpan: false,
      getSupportedSpans: vi.fn().mockResolvedValue([48_000, 96_000, 192_000, 384_000]),
      getCurrentSpan: vi.fn().mockResolvedValue(96_000),
      setSpan,
    };
    const spectrumCoordinator = Object.assign(new EventEmitter(), {
      getActiveRadioSpectrumSource: () => ({ spanController }),
    });
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    seedRadioSdrFrame(coordinator, 14_074_000);
    (coordinator as any).lastRadioFrame.frequencyRange = { min: 14_026_000, max: 14_122_000 };
    (coordinator as any).lastRadioFrame.meta.spanHz = 96_000;

    const state = await coordinator.refresh('radio-sdr');
    expect(state.frequencyRangeMode).toBe('absolute-center');
    expect(state.controls.filter(control => control.id === 'zoom-step')).toHaveLength(2);
    expect(state.controls.some(control => control.id === 'digital-window-toggle')).toBe(false);
    expect(state.interaction).toMatchObject({
      showTxMarkers: true,
      showRxMarkers: true,
      canDragTx: true,
      frequencyGestureTarget: 'operator-tx',
    });

    await coordinator.invokeControl('radio-sdr', 'zoom-step', 'in');
    expect(setSpan).toHaveBeenCalledWith(48_000);
  });

  it('hides TCI zoom controls when all sample rates map to one IF window', async () => {
    const engine = new MockEngine();
    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getConfig.mockReturnValue({ type: 'tci' } as any);
    engine.radioManager.getMode.mockResolvedValue({ mode: 'DIGU', bandwidth: 3000 });
    const spanController = {
      frameSpanScale: 1,
      preferFrameSpan: false,
      getSupportedSpans: vi.fn().mockResolvedValue([48_000]),
      getCurrentSpan: vi.fn().mockResolvedValue(48_000),
      setSpan: vi.fn(),
    };
    const spectrumCoordinator = Object.assign(new EventEmitter(), {
      getActiveRadioSpectrumSource: () => ({ spanController }),
    });
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    seedRadioSdrFrame(coordinator, 14_074_000);
    (coordinator as any).lastRadioFrame.frequencyRange = { min: 14_054_469, max: 14_093_531 };
    (coordinator as any).lastRadioFrame.meta.spanHz = 39_062;

    const state = await coordinator.refresh('radio-sdr');

    expect(state.controls.some(control => control.id === 'zoom-step')).toBe(false);
  });

  it('keeps voice radio SDR RF gestures and coarse step unchanged', async () => {
    const engine = new MockEngine();
    engine.engineMode = 'voice';
    engine.currentModeName = 'VOICE';
    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getMode.mockResolvedValue({ mode: 'USB', bandwidth: 2400 });
    const spectrumCoordinator = new EventEmitter();
    const coordinator = new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);
    seedRadioSdrFrame(coordinator);

    const state = await coordinator.refresh('radio-sdr');

    expect(state.interaction).toMatchObject({
      showTxMarkers: false,
      showRxMarkers: false,
      canDragTx: false,
      canDragFrequency: true,
      canRightClickSetFrequency: true,
      canDoubleClickSetFrequency: true,
      frequencyGestureTarget: 'radio-frequency',
      frequencyStepHz: 1000,
    });
  });

  it('restores radio SDR display mode to center when entering CW', async () => {
    const engine = new MockEngine();
    engine.engineMode = 'cw';
    engine.currentModeName = 'CW';
    const connection = {
      configureSpectrumDisplay: vi.fn().mockResolvedValue(undefined),
      getSpectrumDisplayState: vi.fn().mockResolvedValue({
        mode: 'fixed',
        edgeLowHz: 14_073_000,
        edgeHighHz: 14_078_000,
        spanHz: 5000,
        supportsFixedEdges: true,
        supportedSpans: [5000, 10_000],
      }),
      getRadioIoQueueSnapshot: vi.fn(() => createBusySnapshot(false)),
    };
    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getActiveConnection.mockReturnValue(connection);
    const spectrumCoordinator = new EventEmitter();
    new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);

    (engine as any).emit('modeChanged');

    await vi.waitFor(() => {
      expect(connection.configureSpectrumDisplay).toHaveBeenCalledWith({ mode: 'center' });
    });
  });

  it('retries non-digital radio SDR center restore after CAT queue backpressure clears', async () => {
    vi.useFakeTimers();
    const engine = new MockEngine();
    engine.engineMode = 'voice';
    engine.currentModeName = 'VOICE';
    let busy = true;
    const connection = {
      configureSpectrumDisplay: vi.fn().mockResolvedValue(undefined),
      getSpectrumDisplayState: vi.fn().mockResolvedValue({
        mode: 'fixed',
        edgeLowHz: 14_073_000,
        edgeHighHz: 14_078_000,
        spanHz: 5000,
        supportsFixedEdges: true,
        supportedSpans: [5000, 10_000],
      }),
      getRadioIoQueueSnapshot: vi.fn(() => createBusySnapshot(busy)),
    };
    engine.radioManager.isConnected.mockReturnValue(true);
    engine.radioManager.getActiveConnection.mockReturnValue(connection);
    engine.radioManager.getConfig.mockReturnValue({ type: 'serial' });
    const spectrumCoordinator = new EventEmitter();
    new SpectrumSessionCoordinator(engine as any, spectrumCoordinator as any);

    (engine as any).emit('modeChanged');
    await Promise.resolve();
    expect(connection.configureSpectrumDisplay).not.toHaveBeenCalled();

    busy = false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(connection.configureSpectrumDisplay).toHaveBeenCalledWith({ mode: 'center' });
    vi.useRealTimers();
  });
});
