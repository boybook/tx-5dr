import { EventEmitter } from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import { SpectrumSessionCoordinator } from '../SpectrumSessionCoordinator.js';

class MockEngine extends EventEmitter<Record<string, never>> {
  readonly radioManager = {
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
});
