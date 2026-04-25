import { afterEach, describe, expect, it, vi } from 'vitest';
import { FT8MessageParser } from '@tx5dr/core';
import { FT8MessageType } from '@tx5dr/contracts';
import { createMockContext } from '@tx5dr/plugin-api/testing';
import {
  calculateNoReplyPenalty,
  calculateRecoveredScore,
  calculateScoreAfterFailure,
  noReplyMemoryFilterPlugin,
} from './index.js';

afterEach(() => {
  vi.useRealTimers();
});

function createParsedMessage(rawMessage: string, snr = -10) {
  return {
    snr,
    dt: 0,
    df: 1500,
    rawMessage,
    message: FT8MessageParser.parseMessage(rawMessage),
    slotId: 'slot-test',
    timestamp: Date.now(),
  };
}

describe('no-reply-memory-filter scoring', () => {
  it('allows one full no-reply failure before blocking', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(calculateScoreAfterFailure(undefined, { reason: 'tx1_max_call_attempts', unansweredTransmissions: 8 }, now)).toBe(60);
  });

  it('recovers to the block threshold after fifteen minutes from two failures', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const score = calculateRecoveredScore({ score: 20, updatedAt: now }, now + 15 * 60_000);
    expect(score).toBe(50);
  });

  it('penalizes a second fresh failure more heavily', () => {
    const firstFailureAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const score = calculateScoreAfterFailure(
      { score: 60, updatedAt: firstFailureAt },
      { reason: 'tx1_max_call_attempts', unansweredTransmissions: 8 },
      firstFailureAt,
    );
    expect(score).toBe(20);
  });

  it('uses a lighter penalty when switching to a direct caller', () => {
    expect(calculateNoReplyPenalty({ reason: 'tx1_switched_to_direct_call', unansweredTransmissions: 1 })).toBe(20);
    expect(calculateNoReplyPenalty({ reason: 'tx1_max_call_attempts', unansweredTransmissions: 8 })).toBe(40);
  });
});

describe('no-reply-memory-filter hooks', () => {
  it('blocks automatic CQ candidates while preserving direct calls to my station', async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ctx = createMockContext({ callsign: 'BG4IAJ' });
    noReplyMemoryFilterPlugin.hooks?.onQSOFail?.({
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    }, ctx);
    noReplyMemoryFilterPlugin.hooks?.onQSOFail?.({
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    }, ctx);

    const candidates = [
      createParsedMessage('CQ JA1AAA PM95'),
      createParsedMessage(FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'JA1AAA',
        targetCallsign: 'BG4IAJ',
        grid: 'PM95',
      })),
    ];
    const filtered = await noReplyMemoryFilterPlugin.hooks?.onFilterCandidates?.(candidates, ctx);

    expect(filtered).toEqual([candidates[1]]);
  });

  it('clears memory after a completed QSO', () => {
    const ctx = createMockContext({ callsign: 'BG4IAJ' });
    noReplyMemoryFilterPlugin.hooks?.onQSOFail?.({
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    }, ctx);
    expect(Object.keys(ctx.store.global.getAll())).toEqual(['callsign:JA1AAA']);

    noReplyMemoryFilterPlugin.hooks?.onQSOComplete?.({
      id: 'qso-1',
      callsign: 'JA1AAA',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: Date.now(),
      endTime: Date.now(),
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      messageHistory: [],
    }, ctx);

    expect(ctx.store.global.getAll()).toEqual({});
  });
});
