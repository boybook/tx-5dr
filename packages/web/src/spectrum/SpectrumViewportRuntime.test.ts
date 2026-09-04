import { describe, expect, it, vi } from 'vitest';
import { createSpectrumViewportRuntime } from './SpectrumViewportRuntime';

describe('SpectrumViewportRuntime', () => {
  it('shares one preview range without retaining the caller object', () => {
    const runtime = createSpectrumViewportRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);
    const range = { min: 1000, max: 2000 };

    runtime.setPreviewRange(range);
    range.min = 0;

    expect(runtime.getPreviewRange()).toEqual({ min: 1000, max: 2000 });
    expect(runtime.getPhase()).toBe('preview');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('coalesces identical previews and notifies once when the gesture clears', () => {
    const runtime = createSpectrumViewportRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);

    runtime.setPreviewRange({ min: 1000, max: 2000 });
    runtime.setPreviewRange({ min: 1000, max: 2000 });
    runtime.setCommittedRange({ min: 1500, max: 2500 });
    expect(runtime.getPhase()).toBe('commit-hold');
    runtime.clear();
    runtime.setPreviewRange(null);
    runtime.setPreviewRange(null);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(runtime.getPreviewRange()).toBeNull();
  });
});
