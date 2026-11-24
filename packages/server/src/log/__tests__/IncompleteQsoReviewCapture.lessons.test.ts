import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { MODES, type SlotPack } from '@tx5dr/contracts';
import { ClockCoordinator } from '../../subsystems/ClockCoordinator.js';

// Characterization of ft8-lessons QSO-30 capture wiring: the incomplete QSO
// review is fed from exactly two events, the review-ready SlotPack update
// (RX evidence without our TX echoes) and the on-air transmission log.

function createHarness() {
  const engineEmitter = new EventEmitter();
  const slotPackManager = Object.assign(new EventEmitter(), {
    setFrequencyContext: vi.fn(),
    addTransmissionFrame: vi.fn(),
    processDecodeResult: vi.fn(),
  });
  const reviewService = { observeRx: vi.fn(), observeTx: vi.fn() };
  const coordinator = new ClockCoordinator({
    engineEmitter: engineEmitter as never,
    slotClock: new EventEmitter() as never,
    decodeQueue: new EventEmitter() as never,
    slotPackManager: slotPackManager as never,
    spectrumScheduler: new EventEmitter() as never,
    operatorManager: {
      broadcastAllOperatorStatusUpdates: vi.fn(),
      reDecideOnLateDecodes: vi.fn(),
      getOperator: vi.fn((id: string) => (id === 'op-1' ? { config: { myCallsign: 'W1AAA' } } : undefined)),
      getLogManager: () => ({ getOperatorLogBookId: () => 'logbook-W1AAA' }),
    } as never,
    callsignTracker: { updateFromSlotPack: vi.fn() } as never,
    reviewService: reviewService as never,
    getTransmissionPipeline: () => ({}) as never,
    getRadioBridge: () => ({ onSpectrumEvent: vi.fn() }) as never,
    getCurrentMode: () => MODES.FT8,
  });
  coordinator.setup();
  return { coordinator, engineEmitter, slotPackManager, reviewService };
}

function reviewSlotPack(mode: string): SlotPack {
  return {
    slotId: 'slot-15000',
    startMs: 15_000,
    endMs: 30_000,
    frames: [
      { message: 'W1AAA K1BBB -12', snr: -14, dt: 0.1, freq: 1000, confidence: 0.9 },
      { message: 'K1BBB W1AAA R-09', snr: -999, dt: 0, freq: 1000, confidence: 1, operatorId: 'op-1' },
    ],
    stats: {
      totalDecodes: 1, successfulDecodes: 1, totalFramesBeforeDedup: 2, totalFramesAfterDedup: 2, lastUpdated: 15_000,
    },
    decodeHistory: [],
    frequencyContext: { frequency: 14_074_000, band: '20m', mode } as never,
  };
}

describe('incomplete QSO review capture wiring', () => {
  it('observes review-ready RX slots without local TX echoes', () => {
    const { coordinator, slotPackManager, reviewService } = createHarness();

    slotPackManager.emit('slotPackReviewUpdated', reviewSlotPack('FT8'));
    slotPackManager.emit('slotPackReviewUpdated', reviewSlotPack('JT65'));

    expect(reviewService.observeRx).toHaveBeenCalledOnce();
    expect(reviewService.observeRx).toHaveBeenCalledWith({
      mode: 'FT8', startMs: 15_000, frequency: 14_074_000,
      frames: [{ message: 'W1AAA K1BBB -12', snr: -14, freq: 1000, confidence: 0.9 }],
    });
    // Ordinary SlotPack updates are not review evidence.
    slotPackManager.emit('slotPackUpdated', reviewSlotPack('FT8'));
    expect(reviewService.observeRx).toHaveBeenCalledOnce();
    coordinator.teardown();
  });

  it('observes on-air transmission logs with the RF base and audio offset', () => {
    const { coordinator, engineEmitter, slotPackManager, reviewService } = createHarness();

    engineEmitter.emit('transmissionLog', {
      operatorId: 'op-1', time: '000015', message: 'K1BBB W1AAA R-09', frequency: 1000, slotStartMs: 15_000,
      frequencyContext: { frequency: 14_074_000, band: '20m', mode: 'FT8' },
    });

    expect(slotPackManager.addTransmissionFrame).toHaveBeenCalledOnce();
    expect(reviewService.observeTx).toHaveBeenCalledWith({
      operatorId: 'op-1', logBookId: 'logbook-W1AAA', myCallsign: 'W1AAA',
      mode: 'FT8', startMs: 15_000, frequency: 14_074_000, audioOffsetHz: 1000, text: 'K1BBB W1AAA R-09',
    });
    coordinator.teardown();
  });
});
