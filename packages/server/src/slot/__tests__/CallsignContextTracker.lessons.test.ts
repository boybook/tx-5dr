import { afterEach, describe, expect, it } from 'vitest';
import type { SlotPack } from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
import { CallsignContextTracker } from '../CallsignContextTracker.js';

// Characterization of ft8-lessons QSO-32: the decoder SNR history describes
// how we hear a station, so our own TX echo (snr -999) never enters it.

const trackers: CallsignContextTracker[] = [];

afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.dispose();
});

function createTracker(): CallsignContextTracker {
  const tracker = new CallsignContextTracker();
  trackers.push(tracker);
  return tracker;
}

function slotPack(startMs: number, frames: Array<{ message: string; snr: number }>): SlotPack {
  return {
    slotId: `slot-${startMs}`,
    startMs,
    endMs: startMs + 15_000,
    frames: frames.map(frame => ({ ...frame, dt: 0, freq: 1500, confidence: 1 })),
    stats: {
      totalDecodes: frames.length,
      successfulDecodes: frames.length,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs,
    },
    decodeHistory: [],
  };
}

const parse = (message: string) => FT8MessageParser.parseMessage(message);

describe('CallsignContextTracker SNR history and local TX echoes', () => {
  it('excludes our own TX echo from the sender SNR history', () => {
    const tracker = createTracker();

    tracker.updateFromSlotPack(slotPack(15_000, [{ message: 'CQ BG5DRB PM00', snr: -999 }]), parse);
    tracker.updateFromSlotPack(slotPack(30_000, [{ message: 'CQ BG5DRB PM00', snr: -11 }]), parse);

    expect(tracker.getTrackingData('BG5DRB')?.snrHistory).toEqual([
      { snr: -11, timestamp: 30_000 },
    ]);
  });

  it('still learns the directed report carried by our TX echo', () => {
    const tracker = createTracker();

    tracker.updateFromSlotPack(slotPack(15_000, [{ message: 'JA1AAA BG5DRB -07', snr: -999 }]), parse);

    expect(tracker.getReport('BG5DRB', 'JA1AAA')).toBe(-7);
    expect(tracker.getTrackingData('BG5DRB')?.snrHistory ?? []).toEqual([]);
  });
});
