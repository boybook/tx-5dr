import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpectrumCoordinator } from '../SpectrumCoordinator.js';
import type { IcomScopeFrame } from 'icom-wlan-node';

class MockEngine extends EventEmitter {
  readonly spectrumScheduler = new EventEmitter() as EventEmitter & {
    setSubscriptionActive: ReturnType<typeof vi.fn>;
  };

  readonly radioManager = {
    getConfig: vi.fn(() => ({ type: 'icom-wlan' })),
    getIcomWlanManager: vi.fn(() => null),
    getActiveConnection: vi.fn(() => null),
    isConnected: vi.fn(() => true),
  };

  constructor() {
    super();
    this.spectrumScheduler.setSubscriptionActive = vi.fn();
  }

  getSpectrumScheduler() {
    return this.spectrumScheduler;
  }

  getRadioManager() {
    return this.radioManager;
  }

  getOpenWebRXAudioAdapter() {
    return null;
  }
}

function createScopeFrame(): IcomScopeFrame {
  return {
    startFreqHz: 7_050_000,
    endFreqHz: 7_150_000,
    pixels: Int16Array.from([1, 2, 3, 4]),
    segments: [],
    transport: 'lan-civ',
    timestamp: Date.now(),
  } as unknown as IcomScopeFrame;
}

describe('SpectrumCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throttles emitted ICOM WLAN scope frames before they reach websocket clients', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
    const coordinator = new SpectrumCoordinator(new MockEngine() as any);
    const frames: unknown[] = [];
    coordinator.on('frame', (frame) => frames.push(frame));

    (coordinator as any).onScopeFrame(createScopeFrame());
    vi.advanceTimersByTime(100);
    (coordinator as any).onScopeFrame(createScopeFrame());
    vi.advanceTimersByTime(149);
    (coordinator as any).onScopeFrame(createScopeFrame());
    vi.advanceTimersByTime(1);
    (coordinator as any).onScopeFrame(createScopeFrame());

    expect(frames).toHaveLength(2);
  });
});
