import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { MODES, type SlotInfo } from '@tx5dr/contracts';
import { ClockCoordinator } from '../ClockCoordinator.js';

function slot(index: number): SlotInfo {
  const startMs = index * MODES.FT8.slotMs;
  return { id: `FT8-${index}-${startMs}`, startMs, cycleNumber: index, utcSeconds: startMs / 1000, phaseMs: 0, driftMs: 0, mode: 'FT8' };
}

describe('ClockCoordinator decode timing warning', () => {
  function setup() {
    const slotClock = new EventEmitter();
    const engineEmitter = new EventEmitter();
    const state = { transmitting: true, decoded: false };
    const hasCompletedDecodes = vi.fn(() => state.decoded);
    const warnings = vi.fn();
    engineEmitter.on('timingWarning', warnings);
    const coordinator = new ClockCoordinator({
      engineEmitter: engineEmitter as never,
      slotClock: slotClock as never,
      decodeQueue: new EventEmitter() as never,
      slotPackManager: { hasCompletedDecodes, on: vi.fn(), off: vi.fn() } as never,
      spectrumScheduler: new EventEmitter() as never,
      operatorManager: { hasActiveTransmissionsInCurrentCycle: () => state.transmitting } as never,
      callsignTracker: { updateFromSlotPack: vi.fn() } as never,
      getTransmissionPipeline: () => ({ onEncodeStart: vi.fn() }) as never,
      getRadioBridge: () => ({ onSpectrumEvent: vi.fn() }) as never,
      getCurrentMode: () => MODES.FT8,
    });
    coordinator.setup();
    const encodeStart = (index: number) => slotClock.emit('encodeStart', slot(index));
    return { coordinator, state, hasCompletedDecodes, warnings, encodeStart };
  }

  it('skips the first slot after start, warns once while decodes are missing, and resets on recovery', () => {
    const h = setup();
    try {
      h.encodeStart(10);
      expect(h.hasCompletedDecodes).not.toHaveBeenCalled();
      expect(h.warnings).not.toHaveBeenCalled();

      h.encodeStart(11);
      expect(h.hasCompletedDecodes).toHaveBeenLastCalledWith(slot(10).startMs);
      expect(h.warnings).toHaveBeenCalledTimes(1);
      expect(h.warnings).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Decode timing warning' }));

      h.encodeStart(12);
      expect(h.warnings).toHaveBeenCalledTimes(1);

      h.state.decoded = true;
      h.encodeStart(13);
      expect(h.warnings).toHaveBeenCalledTimes(1);

      h.state.decoded = false;
      h.encodeStart(14);
      expect(h.warnings).toHaveBeenCalledTimes(2);
    } finally {
      h.coordinator.teardown();
    }
  });

  it('does not check decodes when nobody transmits in the cycle', () => {
    const h = setup();
    try {
      h.state.transmitting = false;
      h.encodeStart(10);
      h.encodeStart(11);
      expect(h.hasCompletedDecodes).not.toHaveBeenCalled();
      expect(h.warnings).not.toHaveBeenCalled();
    } finally {
      h.coordinator.teardown();
    }
  });

  it('skips the first slot again after teardown and setup', () => {
    const h = setup();
    h.encodeStart(10);
    h.coordinator.teardown();
    h.coordinator.setup();
    try {
      h.encodeStart(11);
      expect(h.hasCompletedDecodes).not.toHaveBeenCalled();
      expect(h.warnings).not.toHaveBeenCalled();
    } finally {
      h.coordinator.teardown();
    }
  });
});
