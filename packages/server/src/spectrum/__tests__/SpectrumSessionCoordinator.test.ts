import { EventEmitter } from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import { SpectrumSessionCoordinator } from '../SpectrumSessionCoordinator.js';
import { IcomWlanConnection } from '../../radio/connections/IcomWlanConnection.js';

class MockEngine extends EventEmitter<Record<string, never>> {
  readonly radioManager = {
    getConfig: vi.fn(() => ({ type: 'icom-wlan' })),
    getCoreCapabilities: vi.fn(() => ({ readRadioMode: true })),
    getMode: vi.fn(),
    isConnected: vi.fn(() => false),
  };

  getRadioManager() {
    return this.radioManager as any;
  }
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
    const connection = new IcomWlanConnection();
    const getCurrentSpectrumSpan = vi.fn().mockResolvedValue(25_000);
    (connection as any).getCurrentSpectrumSpan = getCurrentSpectrumSpan;
    (coordinator as any).lastRadioFrame = {
      kind: 'radio-sdr',
      frequencyRange: { min: 7_050_000, max: 7_150_000 },
      meta: { spanHz: 100_000 },
    };

    const span = await (coordinator as any).resolveCurrentSpan(connection, null);

    expect(span).toBe(50_000);
    expect(getCurrentSpectrumSpan).not.toHaveBeenCalled();
  });
});
