import { describe, expect, it } from 'vitest';
import type { FrameMessage, SlotPack, SlotPackFrequencyContext } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';
import {
  buildMyRelatedFrameGroups,
  type TransmissionLog,
  upsertTransmissionLog,
} from '../MyRelatedFramesTableModel';

const mode = MODES.FT8;

function createSlotPack(startMs: number, frames: FrameMessage[], frequencyContext?: SlotPackFrequencyContext): SlotPack {
  return {
    slotId: `slot-${startMs}`,
    startMs,
    endMs: startMs + mode.slotMs,
    frames,
    stats: {
      totalDecodes: frames.length,
      successfulDecodes: frames.filter(frame => frame.snr !== -999).length,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs,
      updateSeq: 1,
    },
    decodeHistory: [],
    ...(frequencyContext && { frequencyContext }),
  };
}

function createTxFrame(operatorId: string, message: string, freq: number): FrameMessage {
  return {
    snr: -999,
    dt: 0,
    freq,
    message,
    confidence: 1,
    operatorId,
  };
}

function createTxLog(operatorId: string, slotStartMs: number, message: string, frequency: number): TransmissionLog {
  return {
    operatorId,
    slotStartMs,
    time: new Date(slotStartMs).toISOString().slice(11, 19).replace(/:/g, ''),
    message,
    frequency,
    replaceExisting: true,
  };
}

function buildGroups(slotPacks: SlotPack[], logs: TransmissionLog[], startMs: number) {
  return buildMyRelatedFrameGroups({
    slotPacks,
    transmissionLogs: logs,
    operators: [
      { myCallsign: 'BG5BNW' },
      { myCallsign: 'BG5DRB' },
      { myCallsign: 'BH5HIE' },
    ],
    targetCallsigns: ['R9WXK', 'R8KBM', 'R4CDO'],
    myTransmitCycles: [CycleUtils.calculateCycleNumberFromMs(startMs, mode.slotMs)],
    currentMode: mode,
  });
}

describe('MyRelatedFramesTableModel', () => {
  it('upserts transmission logs by operator and slot', () => {
    const first = createTxLog('op-1', 60_000, 'CQ BG5BNW PM00', 2550);
    const replacement = createTxLog('op-1', 60_000, 'R9WXK BG5BNW PM00', 2550);

    const logs = upsertTransmissionLog(upsertTransmissionLog([], first), replacement);

    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe('R9WXK BG5BNW PM00');
  });

  it('uses the transmission log replacement instead of an older TX echo for the same operator and slot', () => {
    const startMs = 60_000;
    const slotPack = createSlotPack(startMs, [
      createTxFrame('op-1', 'CQ BG5BNW PM00', 2550),
    ]);
    const groups = buildGroups(
      [slotPack],
      [createTxLog('op-1', startMs, 'R9WXK BG5BNW PM00', 2550)],
      startMs,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages.map(message => message.message)).toEqual(['R9WXK BG5BNW PM00']);
  });

  it('shows at most one TX row per operator in the same example slot', () => {
    const startMs = Date.UTC(2026, 0, 1, 15, 45, 15);
    const slotPack = createSlotPack(startMs, [
      createTxFrame('op-1', 'CQ BG5BNW PM00', 2550),
      createTxFrame('op-2', 'CQ BG5DRB PM00', 2450),
      createTxFrame('op-3', 'R4CDO BH5HIE PM00', 2250),
    ]);
    const groups = buildGroups(
      [slotPack],
      [
        createTxLog('op-1', startMs, 'R9WXK BG5BNW PM00', 2550),
        createTxLog('op-2', startMs, 'R8KBM BG5DRB PM00', 2450),
        createTxLog('op-3', startMs, 'R4CDO BH5HIE PM00', 2250),
      ],
      startMs,
    );

    const txMessages = groups[0]?.messages.filter(message => message.db === 'TX') ?? [];
    expect(txMessages.map(message => message.message).sort()).toEqual([
      'R4CDO BH5HIE PM00',
      'R8KBM BG5DRB PM00',
      'R9WXK BG5BNW PM00',
    ]);
  });

  it('keeps same-frequency transmissions from different operators side by side', () => {
    const startMs = 60_000;
    const groups = buildGroups(
      [],
      [
        createTxLog('op-1', startMs, 'R9WXK BG5BNW PM00', 2550),
        createTxLog('op-2', startMs, 'R8KBM BG5DRB PM00', 2550),
      ],
      startMs,
    );

    expect(groups[0]?.messages.map(message => message.message).sort()).toEqual([
      'R8KBM BG5DRB PM00',
      'R9WXK BG5BNW PM00',
    ]);
  });

  it('preserves per-slot frequency context across band changes', () => {
    const firstStart = Date.UTC(2026, 0, 1, 15, 45, 0);
    const secondStart = firstStart + mode.slotMs;
    const groups = buildGroups(
      [
        createSlotPack(firstStart, [
          { snr: -8, dt: 0.1, freq: 1200, message: 'R9WXK BG5BNW -10', confidence: 1 },
        ], { frequency: 14_074_000, band: '20m', mode: 'FT8', description: '14.074 MHz' }),
        createSlotPack(secondStart, [
          { snr: -9, dt: 0.2, freq: 1300, message: 'R8KBM BG5DRB -12', confidence: 1 },
        ], { frequency: 7_074_000, band: '40m', mode: 'FT8', description: '7.074 MHz' }),
      ],
      [],
      secondStart,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.frequencyContext).toMatchObject({ frequency: 14_074_000, band: '20m' });
    expect(groups[1]?.frequencyContext).toMatchObject({ frequency: 7_074_000, band: '40m' });
  });

  it('keeps replacement transmission log frequency context', () => {
    const startMs = 60_000;
    const first = createTxLog('op-1', startMs, 'CQ BG5BNW PM00', 2550);
    first.frequencyContext = { frequency: 14_074_000, band: '20m', mode: 'FT8' };
    const replacement = createTxLog('op-1', startMs, 'R9WXK BG5BNW PM00', 2550);
    replacement.frequencyContext = { frequency: 7_074_000, band: '40m', mode: 'FT8' };

    const groups = buildGroups([], [first, replacement], startMs);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(1);
    expect(groups[0]?.messages[0]?.message).toBe('R9WXK BG5BNW PM00');
    expect(groups[0]?.frequencyContext).toMatchObject({ frequency: 7_074_000, band: '40m' });
  });
});
