import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperatorStatus } from '@tx5dr/contracts';
import {
  TARGET_REQUEST_TIMEOUT_MS,
  TargetRequestTracker,
  buildSelectedFrame,
  resolveTargetOperators,
} from './liveTargeting';
import type { LiveStation } from './liveDecodes';

function operator(id: string, myCall?: string): OperatorStatus {
  return { id, context: { myCall } } as unknown as OperatorStatus;
}

describe('resolveTargetOperators', () => {
  it("prefers the page's operator, takes a lone operator, and otherwise lets the user pick", () => {
    expect(resolveTargetOperators([operator('a', 'BG5DRB'), operator('b', 'BG5CCB')], 'b')).toMatchObject({ defaultId: 'b' });
    expect(resolveTargetOperators([operator('a', 'BG5DRB')])).toEqual({ options: [{ id: 'a', label: 'BG5DRB' }], defaultId: 'a' });
    expect(resolveTargetOperators([operator('a'), operator('b')], 'gone').defaultId).toBeUndefined();
    expect(resolveTargetOperators([operator('a')]).options[0].label).toBe('a');
  });
});

describe('buildSelectedFrame', () => {
  it('sends the decode the station was heard in', () => {
    const station = {
      slotStartMs: 1_700_000_010_000,
      decode: { message: 'CQ JA1ABC PM95', snr: -8, dt: 0.2, freq: 1200 },
    } as LiveStation;
    expect(buildSelectedFrame(station)).toEqual({ message: 'CQ JA1ABC PM95', snr: -8, dt: 0.2, freq: 1200, slotStartMs: 1_700_000_010_000 });
  });
});

describe('TargetRequestTracker', () => {
  afterEach(() => vi.useRealTimers());
  const command = { operatorId: 'op', callsign: 'JA1ABC', selectedFrame: { message: 'CQ', snr: 0, dt: 0, freq: 0, slotStartMs: 0 } };

  it('resolves a request with its own result only', async () => {
    const tracker = new TargetRequestTracker();
    const sent: string[] = [];
    const pending = tracker.request(command, sent.push.bind(sent) as never);
    const requestId = (sent[0] as unknown as { requestId: string }).requestId;
    tracker.resolve({ requestId: 'other', operatorId: 'op', callsign: 'X', status: 'called' });
    tracker.resolve({ requestId, operatorId: 'op', callsign: 'JA1ABC', status: 'queued' });
    await expect(pending).resolves.toMatchObject({ status: 'queued' });
  });

  it('times out when the server never answers, and fails at once on disconnect', async () => {
    vi.useFakeTimers();
    const tracker = new TargetRequestTracker();
    const late = tracker.request(command, () => {});
    vi.advanceTimersByTime(TARGET_REQUEST_TIMEOUT_MS);
    await expect(late).resolves.toMatchObject({ status: 'rejected', reason: 'timeout' });

    const cut = tracker.request(command, () => {});
    tracker.failAll();
    await expect(cut).resolves.toMatchObject({ status: 'rejected', reason: 'disconnected' });
  });
});
