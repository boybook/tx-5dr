import { describe, expect, it } from 'vitest';
import { SlotPackSchema } from '@tx5dr/contracts';
import { getDirectedReplyPairs, ReplyNotificationTracker } from '../replyNotificationTracker';

export function pack(startMs: number, messages = ['BG5DRB JA1ABC PM95'], updateSeq = 1) {
  return SlotPackSchema.parse({
    slotId: `slot-${startMs}`, startMs, endMs: startMs + 15000,
    frames: messages.map(message => ({ message, snr: -12, dt: 0.1, freq: 1000 })),
    stats: { updateSeq },
  });
}

describe('directed reply identity', () => {
  it.each(['BG5DRB JA1ABC PM95', 'BG5DRB JA1ABC -12', 'BG5DRB JA1ABC R-12', 'BG5DRB JA1ABC RRR', 'BG5DRB JA1ABC RR73', '<BG5DRB> JA1ABC 73'])('matches %s', message => {
    expect(getDirectedReplyPairs(message, [' bg5drb '])).toEqual(['BG5DRB:JA1ABC']);
  });
  it.each(['CQ JA1ABC PM95', 'JA1ABC BG5DRB -12', 'BG5DRB BG6ABC PM95', 'BG5DRB <...> -12', '<...> JA1ABC -12', 'HELLO BG5DRB', 'BG5DR JA1ABC -12', 'W1AW JA1ABC -12', 'BG5DRB JA1ABC HELLO', 'BG5DRB JA1ABC -12 HELLO', 'BG5DRB <123> -12', 'BG5DRB <HELLO> -12'])('ignores %s', message => {
    expect(getDirectedReplyPairs(message, ['BG5DRB', 'BG6ABC'])).toEqual([]);
  });
  it('matches both Fox/Hound targets only with a known Fox identity', () => {
    expect(getDirectedReplyPairs('BG5DRB RR73; BG6ABC <4G0G> +04', ['BG5DRB', 'BG6ABC']))
      .toEqual(['BG5DRB:4G0G', 'BG6ABC:4G0G']);
    expect(getDirectedReplyPairs('BG5DRB RR73; BG6ABC <4> +04', ['BG5DRB'])).toEqual([]);
  });
});

describe('reply notification tracker', () => {
  const mine = ['BG5DRB', 'BG6ABC'];
  it('alerts once per caller and rearms exactly two minutes after the last directed message', () => {
    const tracker = new ReplyNotificationTracker();
    expect(tracker.consume(pack(0), mine, true)).not.toBeNull();
    expect(tracker.consume(pack(30000, ['BG5DRB JA1ABC R-12']), mine, true)).toBeNull();
    expect(tracker.consume(pack(149999), mine, true)).toBeNull();
    expect(tracker.consume(pack(269999), mine, true)).not.toBeNull();
  });
  it('coalesces callers and staged updates within a slot, ignoring metrics and sequence regressions', () => {
    const tracker = new ReplyNotificationTracker();
    expect(tracker.consume(pack(0), mine, true)).not.toBeNull();
    expect(tracker.consume(pack(0, ['BG5DRB JA1ABC PM95', 'BG6ABC JA2ABC PM95'], 2), mine, true)).toBeNull();
    expect(tracker.consume(pack(0, ['BG5DRB JA3ABC PM95'], 1), mine, true)).toBeNull();
    expect(tracker.consume(pack(30000, ['BG6ABC JA2ABC -12']), mine, true)).toBeNull();
    expect(tracker.consume(pack(30000, ['BG5DRB JA3ABC PM95'], 2), mine, true)).not.toBeNull();
  });
  it('separates local/remote pairs and excludes transmitted frames', () => {
    const tracker = new ReplyNotificationTracker();
    const tx = pack(0);
    tx.frames[0].snr = -999;
    expect(tracker.consume(tx, mine, true)).toBeNull();
    expect(tracker.consume(pack(30000), mine, true)).not.toBeNull();
    expect(tracker.consume(pack(60000, ['BG6ABC JA1ABC PM95']), mine, true)).not.toBeNull();
  });
  it('baselines disabled and history traffic, while new callers still alert after sync', () => {
    const tracker = new ReplyNotificationTracker();
    expect(tracker.consume(pack(0), mine, false)).toBeNull();
    expect(tracker.consume(pack(0), mine, true)).toBeNull();
    tracker.setSyncing(true);
    expect(tracker.consume(pack(30000, ['BG5DRB JA2ABC PM95']), mine, true)).toBeNull();
    tracker.setSyncing(false);
    expect(tracker.consume(pack(60000, ['BG5DRB JA2ABC -12']), mine, true)).toBeNull();
    expect(tracker.consume(pack(60000, ['BG5DRB JA3ABC PM95'], 2), mine, true)).not.toBeNull();
  });
  it('never alerts old unseen slots and does not renew a pair on replayed messages', () => {
    const tracker = new ReplyNotificationTracker();
    tracker.consume(pack(30000), mine, true);
    expect(tracker.consume(pack(0, ['BG5DRB JA2ABC PM95']), mine, true)).toBeNull();
    expect(tracker.consume(pack(30000), mine, true)).toBeNull();
    expect(tracker.consume(pack(150000), mine, true)).not.toBeNull();
  });
  it('resets deduplication for a new connection', () => {
    const tracker = new ReplyNotificationTracker();
    tracker.consume(pack(0), mine, true);
    tracker.reset();
    expect(tracker.consume(pack(0), mine, true)).not.toBeNull();
  });
});
