import { describe, expect, it, vi } from 'vitest';
import { handleRealtimeClockSyncControlMessage } from '../RealtimeClockSyncControl.js';

describe('RealtimeClockSyncControl', () => {
  it('responds to JSON clock sync messages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const sent: Record<string, unknown>[] = [];

    const handled = handleRealtimeClockSyncControlMessage(
      Buffer.from(JSON.stringify({ type: 'clock-sync', id: 'a', clientSentAtMs: 9_950 })),
      (payload) => sent.push(payload),
    );

    expect(handled).toBe(true);
    expect(sent).toEqual([{ type: 'clock-sync', id: 'a', clientSentAtMs: 9_950, serverReceivedAtMs: 10_000, serverSentAtMs: 10_000 }]);
    vi.useRealTimers();
  });

  it('ignores binary audio-like payloads', () => {
    const sent = vi.fn();

    const handled = handleRealtimeClockSyncControlMessage(Buffer.from([0x54, 0x58, 0x35, 0x44]), sent);

    expect(handled).toBe(false);
    expect(sent).not.toHaveBeenCalled();
  });
});
