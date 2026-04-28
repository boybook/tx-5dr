import { describe, expect, it } from 'vitest';
import { RealtimeClockSync, unwrapServerTimestamp32Ms } from '../RealtimeClockSync';

describe('RealtimeClockSync', () => {
  it('calculates offset and rtt from clock-sync pong messages', () => {
    const sync = new RealtimeClockSync();
    const ping = sync.createPing(1_000);

    expect(sync.handlePong({
      ...ping,
      serverReceivedAtMs: 1_050,
      serverSentAtMs: 1_052,
    }, 1_102)).toBe(true);

    const snapshot = sync.getSnapshot();
    expect(snapshot.rttMs).toBe(100);
    expect(snapshot.offsetMs).toBe(0);
    expect(snapshot.confidence).toBe('low');
  });

  it('uses the lowest-rtt sample as the active offset', () => {
    const sync = new RealtimeClockSync();
    const slow = sync.createPing(1_000);
    sync.handlePong({
      ...slow,
      serverReceivedAtMs: 1_120,
      serverSentAtMs: 1_120,
    }, 1_240);

    const fast = sync.createPing(2_000);
    sync.handlePong({
      ...fast,
      serverReceivedAtMs: 2_030,
      serverSentAtMs: 2_030,
    }, 2_060);

    const snapshot = sync.getSnapshot();
    expect(snapshot.rttMs).toBe(60);
    expect(snapshot.offsetMs).toBe(0);
    expect(snapshot.sampleCount).toBe(2);
  });

  it('unwraps 32-bit server timestamps around the nearest server time', () => {
    const nearWrapReference = 0x1_0000_0000 + 250;
    expect(unwrapServerTimestamp32Ms(120, nearWrapReference)).toBe(0x1_0000_0000 + 120);
    expect(unwrapServerTimestamp32Ms(0xffff_ff00, nearWrapReference)).toBe(0xffff_ff00);
  });
});
