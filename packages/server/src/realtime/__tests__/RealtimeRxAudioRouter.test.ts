import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';

const stationState = vi.hoisted(() => ({
  listenStatus: null as { isListening: boolean; previewSessionId?: string } | null,
  monitor: null as EventEmitter | null,
}));

vi.mock('../../openwebrx/OpenWebRXStationManager.js', () => ({
  OpenWebRXStationManager: {
    getInstance: () => ({
      getListenStatus: () => stationState.listenStatus,
      getBufferedPreviewAudioService: () => stationState.monitor,
    }),
  },
}));

import { RealtimeRxAudioRouter } from '../RealtimeRxAudioRouter.js';

function createMonitor(): EventEmitter & {
  getLatestStats: () => {
    latencyMs: number;
    bufferFillPercent: number;
    isActive: boolean;
    sampleRate: number;
  };
} {
  return Object.assign(new EventEmitter(), {
    getLatestStats: () => ({
      latencyMs: 20,
      bufferFillPercent: 100,
      isActive: true,
      sampleRate: 16000,
    }),
  });
}

describe('RealtimeRxAudioRouter', () => {
  let audioStreamManager: EventEmitter;

  beforeEach(() => {
    vi.useRealTimers();
    audioStreamManager = new EventEmitter();
    stationState.listenStatus = null;
    stationState.monitor = null;
  });

  function createRouter(): RealtimeRxAudioRouter {
    return new RealtimeRxAudioRouter(audioStreamManager as never);
  }

  it('selects native radio source for radio recv', () => {
    const router = createRouter();

    const source = router.resolveSource('radio');

    expect(source?.sourcePath).toBe('native-radio');
    expect(source?.id).toBe('native-radio:radio');
  });

  it('keeps radio recv on native source even when a buffered monitor exists', () => {
    stationState.monitor = createMonitor();
    const router = createRouter();

    const source = router.resolveSource('radio');

    expect(source?.sourcePath).toBe('native-radio');
    expect(source?.id).toBe('native-radio:radio');
  });

  it('keeps OpenWebRX preview on buffered monitor source', () => {
    const previewMonitor = createMonitor();
    stationState.listenStatus = { isListening: true, previewSessionId: 'preview-1' };
    stationState.monitor = previewMonitor;
    const router = createRouter();

    const source = router.resolveSource('openwebrx-preview', 'preview-1');

    expect(source?.sourcePath).toBe('buffered-preview');
    expect(source?.id).toBe('buffered-preview:openwebrx:preview-1');
  });

  it('emits native frames without going through the buffered monitor', () => {
    const router = createRouter();
    const source = router.resolveSource('radio');
    const frames: unknown[] = [];

    source?.on('audioFrame', frame => frames.push(frame));
    audioStreamManager.emit('nativeAudioInputData', {
      samples: new Float32Array([0.1, 0.2, 0.3]),
      sampleRate: 48000,
      channels: 1,
      timestamp: 123,
      sequence: 7,
      sourceKind: 'audio-device',
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      sampleRate: 48000,
      channels: 1,
      timestamp: 123,
      sequence: 0,
      sourceKind: 'native-radio',
      nativeSourceKind: 'audio-device',
    });
    expect(router.getLatestStats('radio')).toMatchObject({
      sourcePath: 'native-radio',
      latencyMs: 0,
      bufferFillPercent: 100,
      isActive: true,
      sampleRate: 48000,
      latestSequence: 0,
    });
  });

  it('routes voice keyer TX monitor chunks through the native radio source', () => {
    const router = createRouter();
    const source = router.resolveSource('radio');
    const frames: Array<{ samples: Float32Array; sampleRate: number; nativeSourceKind?: string }> = [];

    source?.on('audioFrame', frame => frames.push(frame));
    audioStreamManager.emit('txMonitorAudioData', {
      samples: new Float32Array(640).fill(0.4),
      sampleRate: 16000,
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      sampleRate: 16000,
      channels: 1,
      sequence: 0,
      sourceKind: 'native-radio',
      nativeSourceKind: 'voice-tx-monitor',
    });
    expect(frames[0]?.samples).toHaveLength(640);
  });

  it('suppresses native RX frames while voice keyer TX monitor is active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const router = createRouter();
    const source = router.resolveSource('radio');
    const frames: Array<{ nativeSourceKind?: string; timestamp: number }> = [];

    source?.on('audioFrame', frame => frames.push(frame));
    audioStreamManager.emit('txMonitorAudioData', {
      samples: new Float32Array(1600),
      sampleRate: 16000,
    });
    audioStreamManager.emit('nativeAudioInputData', {
      samples: new Float32Array([0.1, 0.2]),
      sampleRate: 48000,
      channels: 1,
      timestamp: 1_001,
      sequence: 1,
      sourceKind: 'audio-device',
    });

    expect(frames.map(frame => frame.nativeSourceKind)).toEqual(['voice-tx-monitor']);

    vi.setSystemTime(1_221);
    audioStreamManager.emit('nativeAudioInputData', {
      samples: new Float32Array([0.3, 0.4]),
      sampleRate: 48000,
      channels: 1,
      timestamp: 1_221,
      sequence: 2,
      sourceKind: 'audio-device',
    });

    expect(frames.map(frame => frame.nativeSourceKind)).toEqual(['voice-tx-monitor', 'audio-device']);
    router.dispose();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
