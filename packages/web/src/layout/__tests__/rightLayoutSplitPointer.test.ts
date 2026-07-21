import { describe, expect, it } from 'vitest';

import {
  isActiveRightLayoutSplitPointer,
  shouldStartRightLayoutSplitPointerDrag,
} from '../rightLayoutSplitPreferences';

describe('right layout split pointer gating', () => {
  it('allows primary touch pointers', () => {
    expect(shouldStartRightLayoutSplitPointerDrag({
      hasActivePointer: false,
      isPrimary: true,
      pointerType: 'touch',
      button: 0,
    })).toBe(true);
  });

  it('allows only primary left mouse button', () => {
    expect(shouldStartRightLayoutSplitPointerDrag({
      hasActivePointer: false,
      isPrimary: true,
      pointerType: 'mouse',
      button: 0,
    })).toBe(true);

    expect(shouldStartRightLayoutSplitPointerDrag({
      hasActivePointer: false,
      isPrimary: true,
      pointerType: 'mouse',
      button: 1,
    })).toBe(false);
  });

  it('rejects non-primary pointers', () => {
    expect(shouldStartRightLayoutSplitPointerDrag({
      hasActivePointer: false,
      isPrimary: false,
      pointerType: 'touch',
      button: 0,
    })).toBe(false);
  });

  it('rejects a second pointer while a drag is active', () => {
    expect(shouldStartRightLayoutSplitPointerDrag({
      hasActivePointer: true,
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
