import { describe, expect, it, vi } from 'vitest';
import { applyOperatorContextDraft } from './operatorContextDraft';

describe('applyOperatorContextDraft', () => {
  it('updates the authoritative ref before React state scheduling', () => {
    const ref = { current: { reportSent: -12, targetCall: 'JA1AAA' } };
    const setDraft = vi.fn(() => {
      expect(ref.current.reportSent).toBeNull();
    });

    const next = applyOperatorContextDraft(ref, setDraft, { reportSent: null });

    expect(next).toEqual({ reportSent: null, targetCall: 'JA1AAA' });
    expect(ref.current).toBe(next);
    expect(setDraft).toHaveBeenCalledWith(next);
  });
});
