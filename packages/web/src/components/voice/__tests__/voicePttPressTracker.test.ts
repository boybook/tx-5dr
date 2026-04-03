import { describe, expect, it } from 'vitest';
import { VoicePttPressTracker } from '../voicePttPressTracker';

describe('VoicePttPressTracker', () => {
  it('does not request release when press is canceled before request is issued', () => {
    const tracker = new VoicePttPressTracker();
    const pressId = tracker.beginPress();

    tracker.cancelPress(pressId);

    expect(tracker.releaseActivePress()).toEqual({
      pressId: null,
      shouldRelease: false,
    });
  });

  it('requests release when press was already sent to the server', () => {
    const tracker = new VoicePttPressTracker();
    const pressId = tracker.beginPress();

    expect(tracker.markRequestIssued(pressId)).toBe(true);
    expect(tracker.releaseActivePress()).toEqual({
      pressId,
      shouldRelease: true,
    });
  });

  it('rejects stale async completions from an earlier press', () => {
    const tracker = new VoicePttPressTracker();
    const firstPressId = tracker.beginPress();

    tracker.releaseActivePress();

    const secondPressId = tracker.beginPress();

    expect(tracker.isActive(firstPressId)).toBe(false);
    expect(tracker.markRequestIssued(firstPressId)).toBe(false);
    expect(tracker.isActive(secondPressId)).toBe(true);
  });
});
