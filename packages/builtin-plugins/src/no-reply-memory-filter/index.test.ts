import { afterEach, describe, expect, it, vi } from 'vitest';
import { FT8MessageParser } from '@tx5dr/core';
import { FT8MessageType } from '@tx5dr/contracts';
import { createMockContext, createMockKVStore } from '@tx5dr/plugin-api/testing';
import {
  calculateNoReplyPenalty,
  calculateRecoveredScore,
  calculateScoreAfterFailure,
  clearNoReplyMemoryEntry,
  listNoReplyMemoryEntries,
  noReplyMemoryFilterPlugin,
  setNoReplyMemoryScore,
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
    expect(calculateNoReplyPenalty({ reason: 'tx1_switched_to_direct_call', unansweredTransmissions: 1 }, 30)).toBe(15);
    expect(calculateNoReplyPenalty({ reason: 'tx1_max_call_attempts', unansweredTransmissions: 8 })).toBe(40);
  });

  it('uses configured failure penalty and recovery rate', () => {
    const now = Date.UTC(2026, 0, 1, 0, 10, 0);
    expect(calculateScoreAfterFailure(
      { score: 20, updatedAt: now - 5 * 60_000 },
      { reason: 'tx1_max_call_attempts', unansweredTransmissions: 8 },
      now,
      { failurePenalty: 30, recoveryPerCycle: 1 },
    )).toBe(10);
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
    expect(Object.keys(ctx.store.operator.getAll())).toEqual(['callsign:JA1AAA']);

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

    expect(ctx.store.operator.getAll()).toEqual({});
  });

  it('keeps no-reply memory isolated per operator', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const globalStore = createMockKVStore();
    const operatorAStore = createMockKVStore();
    const operatorBStore = createMockKVStore();
    const operatorA = createMockContext({
      operatorId: 'operator-a',
      callsign: 'BG4IAJ',
      store: { global: globalStore, operator: operatorAStore },
    });
    const operatorB = createMockContext({
      operatorId: 'operator-b',
      callsign: 'BG5DRB',
      store: { global: globalStore, operator: operatorBStore },
    });

    noReplyMemoryFilterPlugin.hooks?.onQSOFail?.({
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    }, operatorA);
    noReplyMemoryFilterPlugin.hooks?.onQSOFail?.({
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    }, operatorA);

    const candidates = [createParsedMessage('CQ JA1AAA PM95')];

    expect(noReplyMemoryFilterPlugin.hooks?.onFilterCandidates?.(candidates, operatorA)).toEqual([]);
    expect(noReplyMemoryFilterPlugin.hooks?.onFilterCandidates?.(candidates, operatorB)).toEqual(candidates);
    expect(globalStore.getAll()).toEqual({});
    expect(operatorAStore.getAll()).toHaveProperty('callsign:JA1AAA');
    expect(operatorBStore.getAll()).toEqual({});
  });

  it('uses operator-scoped threshold and failure penalty settings', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ctx = createMockContext({
      callsign: 'BG4IAJ',
      config: {
        blockThreshold: 70,
        failurePenalty: 30,
      },
    });

    noReplyMemoryFilterPlugin.hooks?.onQSOFail?.({
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    }, ctx);

    expect(ctx.store.operator.get('callsign:JA1AAA')).toEqual({
      score: 70,
      updatedAt: now,
    });
    expect(noReplyMemoryFilterPlugin.hooks?.onFilterCandidates?.([
      createParsedMessage('CQ JA1AAA PM95'),
    ], ctx)).toEqual([
      expect.objectContaining({ rawMessage: 'CQ JA1AAA PM95' }),
    ]);

    noReplyMemoryFilterPlugin.hooks?.onQSOFail?.({
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    }, ctx);

    expect(ctx.store.operator.get('callsign:JA1AAA')).toEqual({
      score: 40,
      updatedAt: now,
    });
    expect(noReplyMemoryFilterPlugin.hooks?.onFilterCandidates?.([
      createParsedMessage('CQ JA1AAA PM95'),
    ], ctx)).toEqual([]);
  });
});

describe('no-reply-memory-filter memory manager', () => {
  it('lists memory with recovered effective scores', () => {
    const now = Date.UTC(2026, 0, 1, 0, 10, 0);
    const ctx = createMockContext({ callsign: 'BG4IAJ' });
    ctx.store.operator.set('callsign:JA1AAA', {
      score: 20,
      updatedAt: now - 5 * 60_000,
    });

    const result = listNoReplyMemoryEntries(ctx, now);

    expect(result.entries).toEqual([
      {
        callsign: 'JA1AAA',
        score: 30,
        storedScore: 20,
        updatedAt: now - 5 * 60_000,
        blocked: true,
        minutesUntilCallable: 10,
        minutesUntilFull: 35,
      },
    ]);
    expect(result.blockThreshold).toBe(50);
  });

  it('lists memory using operator-scoped threshold and recovery settings', () => {
    const now = Date.UTC(2026, 0, 1, 0, 10, 0);
    const ctx = createMockContext({
      callsign: 'BG4IAJ',
      config: {
        blockThreshold: 60,
        recoveryPerCycle: 1,
      },
    });
    ctx.store.operator.set('callsign:JA1AAA', {
      score: 20,
      updatedAt: now - 5 * 60_000,
    });

    const result = listNoReplyMemoryEntries(ctx, now);

    expect(result.entries[0]).toEqual(expect.objectContaining({
      callsign: 'JA1AAA',
      score: 40,
      blocked: true,
      minutesUntilCallable: 5,
      minutesUntilFull: 15,
    }));
    expect(result.blockThreshold).toBe(60);
    expect(result.recoveryPerCycle).toBe(1);
  });

  it('cleans entries that have recovered to full score', () => {
    const now = Date.UTC(2026, 0, 1, 0, 30, 0);
    const ctx = createMockContext({ callsign: 'BG4IAJ' });
    ctx.store.operator.set('callsign:JA1AAA', {
      score: 40,
      updatedAt: now - 30 * 60_000,
    });

    expect(listNoReplyMemoryEntries(ctx, now).entries).toEqual([]);
    expect(ctx.store.operator.getAll()).toEqual({});
  });

  it('sets an existing callsign score as the current effective score', () => {
    const oldTime = Date.UTC(2026, 0, 1, 0, 0, 0);
    const now = Date.UTC(2026, 0, 1, 0, 5, 0);
    const ctx = createMockContext({ callsign: 'BG4IAJ' });
    ctx.store.operator.set('callsign:JA1AAA', {
      score: 20,
      updatedAt: oldTime,
    });

    const entry = setNoReplyMemoryScore(ctx, 'ja1aaa', 60, now);

    expect(entry?.callsign).toBe('JA1AAA');
    expect(entry?.score).toBe(60);
    expect(ctx.store.operator.get('callsign:JA1AAA')).toEqual({
      score: 60,
      updatedAt: now,
    });
  });

  it('deletes an entry when setting score to full', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const ctx = createMockContext({ callsign: 'BG4IAJ' });
    ctx.store.operator.set('callsign:JA1AAA', {
      score: 20,
      updatedAt: now,
    });

    expect(setNoReplyMemoryScore(ctx, 'JA1AAA', 100, now)).toBeNull();
    expect(ctx.store.operator.getAll()).toEqual({});
  });

  it('clears an existing callsign entry', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const ctx = createMockContext({ callsign: 'BG4IAJ' });
    ctx.store.operator.set('callsign:JA1AAA', {
      score: 20,
      updatedAt: now,
    });

    expect(clearNoReplyMemoryEntry(ctx, 'JA1AAA')).toEqual({ success: true });
    expect(ctx.store.operator.getAll()).toEqual({});
  });

  it('rejects invalid manager writes', () => {
    const ctx = createMockContext({ callsign: 'BG4IAJ' });
    ctx.store.operator.set('callsign:JA1AAA', {
      score: 20,
      updatedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
    });

    expect(() => setNoReplyMemoryScore(ctx, 'BAD CALL', 50)).toThrow('Invalid callsign');
    expect(() => setNoReplyMemoryScore(ctx, 'JA1BBB', 50)).toThrow('Unknown callsign');
    expect(() => setNoReplyMemoryScore(ctx, 'JA1AAA', -1)).toThrow('Score must be between 0 and 100');
    expect(() => setNoReplyMemoryScore(ctx, 'JA1AAA', 101)).toThrow('Score must be between 0 and 100');
    expect(() => clearNoReplyMemoryEntry(ctx, 'JA1BBB')).toThrow('Unknown callsign');
  });
});
