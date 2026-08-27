import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { MODES } from '@tx5dr/contracts';
import { ClockCoordinator } from '../ClockCoordinator.js';

describe('ClockCoordinator decode frequency context', () => {
  it('captures authoritative RF context before SlotPack creation', () => {
    const decodeQueue = new EventEmitter();
    const setFrequencyContext = vi.fn();
    const processDecodeResult = vi.fn();
    const coordinator = new ClockCoordinator({
      engineEmitter: new EventEmitter() as never,
      slotClock: new EventEmitter() as never,
      decodeQueue: decodeQueue as never,
      slotPackManager: {
        setFrequencyContext,
        processDecodeResult,
        on: vi.fn(),
        off: vi.fn(),
      } as never,
      spectrumScheduler: new EventEmitter() as never,
      operatorManager: { broadcastAllOperatorStatusUpdates: vi.fn() } as never,
      callsignTracker: { updateFromSlotPack: vi.fn() } as never,
      getTransmissionPipeline: () => ({
        onSlotStart: vi.fn(), onEncodeStart: vi.fn(), onTransmitStart: vi.fn(),
      }) as never,
      getRadioBridge: () => ({ onSpectrumEvent: vi.fn() }) as never,
      getCurrentMode: () => MODES.FT8,
      getFrequencyContext: () => ({ frequency: 14_074_000, band: '20m', mode: 'FT8' }),
    });

    coordinator.setup();
    const decodeResult = { slotId: 'slot-1' };
    decodeQueue.emit('decodeComplete', decodeResult);

    expect(setFrequencyContext).toHaveBeenCalledWith({ frequency: 14_074_000, band: '20m', mode: 'FT8' });
    expect(processDecodeResult).toHaveBeenCalledWith(decodeResult);
    expect(setFrequencyContext.mock.invocationCallOrder[0])
      .toBeLessThan(processDecodeResult.mock.invocationCallOrder[0]!);
    coordinator.teardown();
  });
});
