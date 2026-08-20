import { describe, expect, it, vi } from 'vitest';
import { RadioControllerAdapter } from '../RadioControllerAdapter.js';

describe('RadioControllerAdapter', () => {
  it('retries an unknown lease instead of reusing the cached release promise', async () => {
    let snapshot: any = {
      leaseId: null,
      source: undefined,
      phase: 'idle',
    };
    const acquireLease = vi.fn().mockImplementation(async () => {
      snapshot = { leaseId: 'lease-1', source: 'manual', phase: 'active' };
      return 'lease-1';
    });
    const releaseLease = vi.fn().mockImplementation(async () => {
      snapshot = { leaseId: 'lease-1', source: 'manual', phase: 'unknown' };
      return { success: false, reason: 'PTT release unconfirmed', physicalConfirmed: true };
    });
    const retryUnknownStop = vi.fn().mockImplementation(async () => {
      snapshot = { leaseId: null, source: undefined, phase: 'idle' };
      return { success: false, reason: 'retry succeeded without RF frame', physicalConfirmed: false };
    });
    const coordinator = {
      acquireLease,
      releaseLease,
      retryUnknownStop,
      getSnapshot: vi.fn(() => snapshot),
    };
    const radioManager = {
      isConnected: vi.fn(() => true),
      isPTTActive: vi.fn(() => false),
    };
    const adapter = new RadioControllerAdapter(radioManager as any, coordinator as any);

    await adapter.setPTT(true);
    await adapter.setPTT(false);

    expect(releaseLease).toHaveBeenCalledWith('lease-1', 'rigctld PTT release');
    expect(retryUnknownStop).toHaveBeenCalledWith('rigctld PTT release retry');
  });
});
