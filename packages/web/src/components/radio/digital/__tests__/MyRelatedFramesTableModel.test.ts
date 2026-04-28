import { describe, expect, it } from 'vitest';
import type { FrameMessage, SlotPack } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';
import {
  buildMyRelatedFrameGroups,
  type TransmissionLog,
  upsertTransmissionLog,
} from '../MyRelatedFramesTableModel';

const mode = MODES.FT8;

function createSlotPack(startMs: number, frames: FrameMessage[]): SlotPack {
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
  const currentGroupKey = CycleUtils.generateSlotGroupKey(startMs, mode.slotMs);
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
    currentGroupKey,
    recentSlotGroupKeys: [],
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
});
