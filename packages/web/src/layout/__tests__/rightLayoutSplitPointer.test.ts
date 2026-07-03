import { describe, expect, it } from 'vitest';

import {
  isActiveRightLayoutSplitPointer,
  shouldStartRightLayoutSplitPointerDrag,
} from '../rightLayoutSplitPreferences';

describe('right layout split pointer gating', () => {
  it('allows primary touch pointers on desktop', () => {
    expect(shouldStartRightLayoutSplitPointerDrag({
      isMobile: false,
      isPrimary: true,
      pointerType: 'touch',
      button: 0,
    })).toBe(true);
  });

  it('allows only primary left mouse button on desktop', () => {
    expect(shouldStartRightLayoutSplitPointerDrag({
      isMobile: false,
      isPrimary: true,
      pointerType: 'mouse',
      button: 0,
    })).toBe(true);

    expect(shouldStartRightLayoutSplitPointerDrag({
      isMobile: false,
      isPrimary: true,
      pointerType: 'mouse',
      button: 1,
    })).toBe(false);
  });

  it('rejects non-primary pointers and mobile layout drags', () => {
    expect(shouldStartRightLayoutSplitPointerDrag({
      isMobile: false,
      isPrimary: false,
      pointerType: 'touch',
      button: 0,
    })).toBe(false);

    expect(shouldStartRightLayoutSplitPointerDrag({
      isMobile: true,
      isPrimary: true,
      pointerType: 'touch',
      button: 0,
    })).toBe(false);
  });

  it('matches only the active pointer id', () => {
    expect(isActiveRightLayoutSplitPointer(7, 7)).toBe(true);
    expect(isActiveRightLayoutSplitPointer(7, 8)).toBe(false);
    expect(isActiveRightLayoutSplitPointer(null, 7)).toBe(false);
  });
});
