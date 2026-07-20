import { describe, expect, it } from 'vitest';

import { shouldPersistRightLayoutSplit } from '../rightLayoutSplitPreferences';

describe('right layout split persistence gating', () => {
  it('skips persistence for initial desktop renders and resize clamps', () => {
    expect(shouldPersistRightLayoutSplit({
      isMobile: false,
      wasDraggingSplit: false,
      isDraggingSplit: false,
    })).toBe(false);
  });

  it('skips persistence while dragging on desktop', () => {
    expect(shouldPersistRightLayoutSplit({
      isMobile: false,
      wasDraggingSplit: false,
      isDraggingSplit: true,
    })).toBe(false);
  });

  it('skips persistence on mobile even when not dragging', () => {
    expect(shouldPersistRightLayoutSplit({
      isMobile: true,
      wasDraggingSplit: true,
      isDraggingSplit: false,
    })).toBe(false);
  });

  it('allows persistence only after a desktop drag ends', () => {
    expect(shouldPersistRightLayoutSplit({
      isMobile: false,
      wasDraggingSplit: true,
      isDraggingSplit: false,
    })).toBe(true);
  });
});
