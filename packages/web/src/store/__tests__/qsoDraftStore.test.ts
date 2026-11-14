// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createQsoDraftStore } from '../qsoDraftStore';

describe('createQsoDraftStore', () => {
  it('starts from its defaults and keeps stores independent', () => {
    const a = createQsoDraftStore({ hisCallsign: '', trst: '599', rrst: '599' });
    const b = createQsoDraftStore({ hisCallsign: '', trst: '5NN', rrst: '5NN' });
    a.setTrst(' 579 ');
    expect(a.getSnapshot()).toEqual({ hisCallsign: '', trst: '579', rrst: '599' });
    expect(b.getSnapshot()).toEqual({ hisCallsign: '', trst: '5NN', rrst: '5NN' });
  });

  it('normalizes values and notifies subscribed components', () => {
    const store = createQsoDraftStore({ hisCallsign: '', trst: '599', rrst: '599' });
    const { result } = renderHook(() => store.useDraft());
    act(() => store.setHisCallsign(' ja1abc '));
    expect(result.current.hisCallsign).toBe('JA1ABC');
    const before = result.current;
    act(() => store.setHisCallsign('JA1ABC'));
    expect(result.current).toBe(before);
  });
});
