import { describe, expect, it } from 'vitest';
import { resolveQueuedFrameOrder, type FrameDisplayMessage } from '../FramesTable';

function frame(overrides: Partial<FrameDisplayMessage> = {}): FrameDisplayMessage {
  return {
    utc: '12:00:00',
    db: -10,
    dt: 0.1,
    freq: 1200,
    message: 'CQ JA1AAA PM95',
    ...overrides,
  };
}

describe('FramesTable queue marker', () => {
  it('matches the decoded sender against the selected operator queue', () => {
    expect(resolveQueuedFrameOrder(frame({
      logbookAnalysis: { callsign: 'ja1aaa/p' },
    }), { JA1AAA: 2 })).toBe(2);
  });

  it('does not mark unrelated or empty queue projections', () => {
    const message = frame({ logbookAnalysis: { callsign: 'JA2BBB' } });
    expect(resolveQueuedFrameOrder(message, { JA1AAA: 1 })).toBeUndefined();
    expect(resolveQueuedFrameOrder(message, {})).toBeUndefined();
  });
});
