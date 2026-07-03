import { describe, expect, it } from 'vitest';

import { shouldPersistRightLayoutSplit } from '../rightLayoutSplitPreferences';

describe('right layout split persistence gating', () => {
  it('skips persistence while dragging on desktop', () => {
    expect(shouldPersistRightLayoutSplit({
      isMobile: false,
      isDraggingSplit: true,
    })).toBe(false);
  });

  it('skips persistence on mobile even when not dragging', () => {
    expect(shouldPersistRightLayoutSplit({
      isMobile: true,
      isDraggingSplit: false,
    })).toBe(false);
  });

  it('allows persistence after dragging ends on desktop', () => {
    expect(shouldPersistRightLayoutSplit({
      isMobile: false,
      isDraggingSplit: false,
    })).toBe(true);
  });
});
