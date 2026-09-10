// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';
import { parseControlNumber } from '../control-values';
import { useNumberControl } from '../useNumberControl';

const descriptor: CapabilityDescriptor = { id: 'af_gain', category: 'audio', valueType: 'number', readable: true, writable: true,
  range: { min: 0, max: 1, step: 0.01 }, display: { mode: 'percent' }, updateMode: 'event', labelI18nKey: 'af', hasSurfaceControl: false };
const state: CapabilityState = { id: 'af_gain', value: 0.2, supported: true, updatedAt: 1 };
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('capability numeric editing', () => {
  it('rejects empty and non-finite input and converts percentages before clamping', () => {
    for (const text of ['', '  ', 'NaN', 'Infinity', '-Infinity', 'bad']) expect(parseControlNumber(text, descriptor)).toBeNull();
    expect(parseControlNumber('35', descriptor)).toBe(0.35);
    expect(parseControlNumber('135', descriptor)).toBe(1);
  });
  it('round-trips native units and snaps to declared steps', () => {
    const native = { ...descriptor, display: { mode: 'value' as const, transform: { scale: 60, offset: -60 } } };
    expect(parseControlNumber('-18', native)).toBe(0.7);
    expect(parseControlNumber('-17.9', native)).toBe(0.7);
  });
  it('only commits an input once when Enter is followed by blur', () => {
    const onWrite = vi.fn();
    const { result } = renderHook(() => useNumberControl({ descriptor, state, enabled: true, scope: 'a', discrete: false, onWrite }));
    act(() => result.current.edit('35'));
    act(() => { result.current.commit(); result.current.commit(); });
    expect(onWrite.mock.calls).toEqual([[0.35]]);
  });
  it('cancels text editing and accepts host updates without writing them back', () => {
    const onWrite = vi.fn();
    const { result, rerender } = renderHook(({ value }) => useNumberControl({ descriptor, state: { ...state, value }, enabled: true, scope: 'a', discrete: false, onWrite }), { initialProps: { value: 0.2 } });
    act(() => result.current.edit('40'));
    rerender({ value: 0.3 });
    expect(result.current.input).toBe('40');
    act(() => result.current.cancel());
    expect(result.current.input).toBe('30');
    expect(onWrite).not.toHaveBeenCalled();
  });
  it('merges a drag and flushes its final value without duplicating it', () => {
    vi.useFakeTimers(); const onWrite = vi.fn();
    const { result } = renderHook(() => useNumberControl({ descriptor, state, enabled: true, scope: 'a', discrete: false, onWrite }));
    act(() => { result.current.slide(0.3); result.current.slide(0.4); });
    act(() => vi.advanceTimersByTime(149)); expect(onWrite).not.toHaveBeenCalled();
    act(() => result.current.endSlide());
    act(() => vi.runAllTimers()); expect(onWrite.mock.calls).toEqual([[0.4]]);
  });
  it('does not cancel a new drag when a previous read error is cleared', () => {
    vi.useFakeTimers(); const onWrite = vi.fn();
    const { result, rerender } = renderHook(({ error }: { error?: string }) => useNumberControl({ descriptor,
      state: { ...state, lastError: error }, enabled: true, scope: 'a', discrete: false, onWrite }), { initialProps: { error: 'Previous read timed out' } as { error?: string } });
    act(() => result.current.slide(0.6)); rerender({ error: undefined });
    expect(result.current.displayValue).toBe(0.6);
    act(() => result.current.endSlide()); expect(onWrite.mock.calls).toEqual([[0.6]]);
  });
  it.each(['scope', 'permission', 'target', 'failure', 'unmount'])('discards queued edits on %s changes', (change) => {
    vi.useFakeTimers(); const onWrite = vi.fn();
    const initial = { descriptor, state, enabled: true, scope: 'a', discrete: false, onWrite };
    const { result, rerender, unmount } = renderHook(props => useNumberControl(props), { initialProps: initial });
    act(() => result.current.slide(0.8));
    if (change === 'scope') rerender({ ...initial, scope: 'b' });
    if (change === 'permission') rerender({ ...initial, enabled: false });
    if (change === 'target') rerender({ ...initial, descriptor: { ...descriptor, target: { scope: 'receiver', receiver: 1 } } });
    if (change === 'failure') rerender({ ...initial, state: { ...state, lastError: 'Rejected' } });
    if (change === 'unmount') unmount();
    act(() => vi.runAllTimers()); expect(onWrite).not.toHaveBeenCalled();
  });
});
