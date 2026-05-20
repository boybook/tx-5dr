import { afterEach, describe, expect, it } from 'vitest';
import type { FT8Message, SlotPack } from '@tx5dr/contracts';
import { CallsignContextTracker } from '../CallsignContextTracker.js';

const trackers: CallsignContextTracker[] = [];

function createTracker(): CallsignContextTracker {
  const tracker = new CallsignContextTracker();
  trackers.push(tracker);
  return tracker;
}

afterEach(() => {
  for (const tracker of trackers.splice(0)) {
    tracker.dispose();
  }
});

function parseTestMessage(message: string): FT8Message {
  const parts = message.trim().split(/\s+/);
  if (parts[0] === 'CQ') {
    return {
      type: 'cq',
      senderCallsign: parts[1] ?? '',
      grid: parts[2],
    } as FT8Message;
  }

  return {
    type: 'call',
    targetCallsign: parts[0] ?? '',
    senderCallsign: parts[1] ?? '',
    grid: parts[2]?.match(/^[A-R]{2}[0-9]{2}/i) ? parts[2] : undefined,
  } as FT8Message;
}

function createSlotPack(
  startMs: number,
  frames: Array<{ message: string; snr: number }>,
): SlotPack {
  return {
    slotId: `slot-${startMs}`,
    startMs,
    endMs: startMs + 15_000,
    frames: frames.map(frame => ({
      message: frame.message,
      snr: frame.snr,
      dt: 0,
      freq: 1500,
      confidence: 0.9,
    })),
    stats: {
      totalDecodes: 1,
      successfulDecodes: frames.length > 0 ? 1 : 0,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs,
    },
    decodeHistory: [],
  };
}

describe('CallsignContextTracker SNR tracking', () => {
  it('counts a callsign once when the same slot pack is processed more than once', () => {
    const tracker = createTracker();
    const slotPack = createSlotPack(45_000, [{ message: 'CQ BG5DRB PM00', snr: -10 }]);

    tracker.updateFromSlotPack(slotPack, parseTestMessage);
    tracker.updateFromSlotPack(slotPack, parseTestMessage);

    expect(tracker.getTrackingData('BG5DRB')?.snrHistory).toEqual([
      { snr: -10, timestamp: 45_000 },
    ]);
  });

  it('updates the existing cycle point when a later window has stronger SNR', () => {
    const tracker = createTracker();

    tracker.updateFromSlotPack(
      createSlotPack(45_000, [{ message: 'CQ BG5DRB PM00', snr: -12 }]),
      parseTestMessage,
    );
    tracker.updateFromSlotPack(
      createSlotPack(45_000, [{ message: 'CQ BG5DRB PM00', snr: -5 }]),
      parseTestMessage,
    );

    expect(tracker.getTrackingData('BG5DRB')?.snrHistory).toEqual([
      { snr: -5, timestamp: 45_000 },
    ]);
  });

  it('keeps separate points for different slot cycles', () => {
    const tracker = createTracker();

    tracker.updateFromSlotPack(
      createSlotPack(45_000, [{ message: 'CQ BG5DRB PM00', snr: -12 }]),
      parseTestMessage,
    );
    tracker.updateFromSlotPack(
      createSlotPack(60_000, [{ message: 'CQ BG5DRB PM00', snr: -8 }]),
      parseTestMessage,
    );

    expect(tracker.getTrackingData('BG5DRB')?.snrHistory).toEqual([
      { snr: -12, timestamp: 45_000 },
      { snr: -8, timestamp: 60_000 },
    ]);
  });

  it('deduplicates callsigns independently within the same cycle', () => {
    const tracker = createTracker();

    tracker.updateFromSlotPack(
      createSlotPack(45_000, [
        { message: 'CQ BG5DRB PM00', snr: -12 },
        { message: 'JA1AAA BG5DRB +03', snr: -7 },
        { message: 'CQ JA1AAA PM95', snr: -18 },
      ]),
      parseTestMessage,
    );

    expect(tracker.getTrackingData('BG5DRB')?.snrHistory).toEqual([
      { snr: -7, timestamp: 45_000 },
    ]);
    expect(tracker.getTrackingData('JA1AAA')?.snrHistory).toEqual([
      { snr: -18, timestamp: 45_000 },
    ]);
  });

  it('does not include local TX echo frames in SNR history', () => {
    const tracker = createTracker();

    tracker.updateFromSlotPack(
      createSlotPack(45_000, [{ message: 'BG5DRB BG2DIH 73', snr: -999 }]),
      parseTestMessage,
    );

    expect(tracker.getTrackingData('BG2DIH')?.snrHistory).toEqual([]);
  });
});
