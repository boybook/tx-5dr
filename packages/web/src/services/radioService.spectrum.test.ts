import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpectrumKind, SpectrumViewport } from '@tx5dr/contracts';
import { RadioService } from './radioService';

const mockState = vi.hoisted(() => ({
  clients: [] as Array<{
    config: { clientVersion?: string };
    connected: boolean;
    ready: boolean;
    subscribeSpectrum: ReturnType<typeof vi.fn>;
    setSpectrumViewport: ReturnType<typeof vi.fn>;
    handlers: Map<string, Set<(data?: unknown) => void>>;
    emit: (event: string, data?: unknown) => void;
  }>,
}));

vi.mock('@tx5dr/core', () => {
  class WSClient {
    config: { clientVersion?: string };
    connected = false;
    ready = false;
    subscribeSpectrum = vi.fn();
    setSpectrumViewport = vi.fn();
    handlers = new Map<string, Set<(data?: unknown) => void>>();

    constructor(config: { clientVersion?: string }) {
      this.config = config;
      mockState.clients.push(this as never);
    }

    get isConnected() {
      return this.connected;
    }

    get isReady() {
      return this.connected && this.ready;
    }

    get connectionInfo() {
      return { isConnected: this.isReady, isConnecting: this.connected && !this.ready };
    }

    onWSEvent(event: string, handler: (data?: unknown) => void) {
      const handlers = this.handlers.get(event) ?? new Set<(data?: unknown) => void>();
      handlers.add(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    offWSEvent(event: string, handler: (data?: unknown) => void) {
      this.handlers.get(event)?.delete(handler);
      return this;
    }

    emit(event: string, data?: unknown) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(data);
      }
    }

    disconnect = vi.fn();
    connect = vi.fn();
    forceReconnect = vi.fn();
    getStatus = vi.fn();
  }

  return {
    api: { getHello: vi.fn(), setRadioDdsFrequency: vi.fn(async (params: { frequency: number; receiver?: number }) => ({ success: true, frequency: params.frequency, receiver: params.receiver ?? 0 })) },
    WSClient,
  };
});

describe('RadioService spectrum subscription reliability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.clients.length = 0;
    vi.stubGlobal('window', {
      location: {
        protocol: 'http:',
        host: 'localhost:5173',
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps desired spectrum kind while disconnected and replays with ack retry', async () => {
    const service = new RadioService();
    const client = mockState.clients[0]!;

    expect(client.config.clientVersion).toBe('1.0.0');

    service.subscribeSpectrum('audio');

    expect(service.desiredSpectrumSubscription).toBe('audio');
    expect(client.subscribeSpectrum).not.toHaveBeenCalled();

    client.connected = true;
    client.ready = true;
    service.replaySpectrumSubscription();

    expect(client.subscribeSpectrum).toHaveBeenCalledTimes(1);
    expect(client.subscribeSpectrum).toHaveBeenLastCalledWith('audio' satisfies SpectrumKind);

    await vi.advanceTimersByTimeAsync(5000);

    expect(client.subscribeSpectrum).toHaveBeenCalledTimes(2);
    expect(client.subscribeSpectrum).toHaveBeenLastCalledWith('audio');

    client.emit('spectrumSubscriptionChanged', {
      requestedKind: 'audio',
      effectiveKind: 'audio',
      ok: true,
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(client.subscribeSpectrum).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after the retry budget is exhausted', async () => {
    const service = new RadioService();
    const client = mockState.clients[0]!;
    client.connected = true;
    client.ready = true;

    service.subscribeSpectrum('radio-sdr');

    await vi.advanceTimersByTimeAsync(20_000);

    expect(client.subscribeSpectrum).toHaveBeenCalledTimes(4);
    expect(client.subscribeSpectrum).toHaveBeenLastCalledWith('radio-sdr');
  });

  it('replays the client viewport with spectrum subscriptions and updates it independently', () => {
    const service = new RadioService();
    const client = mockState.clients[0]!;
    client.connected = true;
    client.ready = true;
    const viewport: SpectrumViewport = { min: 14_070_000, max: 14_090_000, displayBinCount: 4096 };

    service.setSpectrumViewport(viewport);
    expect(client.setSpectrumViewport).not.toHaveBeenCalled();

    service.subscribeSpectrum('radio-sdr');
    expect(client.subscribeSpectrum).toHaveBeenLastCalledWith('radio-sdr', viewport);

    const nextViewport = { ...viewport, min: 14_075_000, max: 14_095_000 };
    service.setSpectrumViewport(nextViewport);
    expect(client.setSpectrumViewport).toHaveBeenLastCalledWith(nextViewport);
    expect(client.setSpectrumViewport).toHaveBeenCalledTimes(1);
    service.setSpectrumViewport({ ...nextViewport });
    expect(client.setSpectrumViewport).toHaveBeenCalledTimes(1);
  });

  it('writes DDS center frequency through the dedicated API without a VFO intent', async () => {
    const service = new RadioService();
    const core = await import('@tx5dr/core');

    await expect(service.setRadioDdsFrequency(14_075_000)).resolves.toEqual({
      success: true,
      frequency: 14_075_000,
      receiver: 0,
    });
    expect(core.api.setRadioDdsFrequency).toHaveBeenCalledWith(
      { frequency: 14_075_000 },
      '/api',
    );
  });
});
