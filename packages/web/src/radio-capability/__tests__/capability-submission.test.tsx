// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityState } from '@tx5dr/contracts';
import type { CapabilityWriteFeedback } from '../control-types';
import { useCapabilitySubmission } from '../useCapabilitySubmission';

const initial: CapabilityState = { id: 'rf_power', value: 0.2, supported: true, updatedAt: 1 };
function deferred() { let resolve!: (result: CapabilityWriteFeedback) => void; const promise = new Promise<CapabilityWriteFeedback>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('capability presentation handoff', () => {
  it('holds the submitted value through old/intermediate broadcasts and bridges its final receipt', async () => {
    const request = deferred(); const onWrite = vi.fn(() => request.promise);
    const { result, rerender } = renderHook(({ state }) => useCapabilitySubmission({ state, enabled: true, scope: 'a', onWrite }), { initialProps: { state: initial } });
    act(() => { result.current.write(initial.id, 0.8); });
    expect(result.current.displayState?.value).toBe(0.8); expect(initial.value).toBe(0.2);
    rerender({ state: { ...initial, value: 0.4, updatedAt: 2 } }); expect(result.current.displayState?.value).toBe(0.8);
    const confirmed = { ...initial, value: 0.8, updatedAt: 3 };
    await act(async () => request.resolve({ outcome: 'completed', state: confirmed }));
    expect(result.current.displayState?.value).toBe(0.8);
    rerender({ state: confirmed }); expect(result.current.displayState?.value).toBe(0.8);
    rerender({ state: { ...initial, value: 0.5, updatedAt: 4 } }); expect(result.current.displayState?.value).toBe(0.5);
    expect(onWrite).toHaveBeenCalledOnce();
  });
  it('ignores an older completion and adopts the latest host-limited value', async () => {
    const a = deferred(); const b = deferred(); const onWrite = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = renderHook(() => useCapabilitySubmission({ state: initial, enabled: true, scope: 'a', onWrite }));
    act(() => { result.current.write(initial.id, 0.4); result.current.write(initial.id, 0.9); });
    await act(async () => a.resolve({ outcome: 'completed', state: { ...initial, value: 0.4, updatedAt: 2 } }));
    expect(result.current.displayState?.value).toBe(0.9);
    await act(async () => b.resolve({ outcome: 'completed', state: { ...initial, value: 0.7, updatedAt: 3 } }));
    expect(result.current.displayState?.value).toBe(0.7); expect(result.current.pending).toBe(false);
  });
  it('does not replace a newer normal broadcast with an older receipt', async () => {
    const request = deferred(); const onWrite = vi.fn(() => request.promise);
    const { result, rerender } = renderHook(({ state }) => useCapabilitySubmission({ state, enabled: true, scope: 'a', onWrite }), { initialProps: { state: initial } });
    act(() => { result.current.write(initial.id, 0.8); });
    rerender({ state: { ...initial, value: 0.6, updatedAt: 4 } });
    await act(async () => request.resolve({ outcome: 'completed', state: { ...initial, value: 0.8, updatedAt: 3 } }));
    expect(result.current.displayState?.value).toBe(0.6);
  });
  it('rolls back only after the latest write fails', async () => {
    const request = deferred(); const onWrite = vi.fn(() => request.promise);
    const { result } = renderHook(() => useCapabilitySubmission({ state: initial, enabled: true, scope: 'a', onWrite }));
    act(() => { result.current.write(initial.id, 0.8); }); expect(result.current.displayState?.value).toBe(0.8);
    await act(async () => request.resolve({ outcome: 'failed', error: 'Rejected' }));
    expect(result.current.displayState?.value).toBe(0.2); expect(result.current.error).toBe('Rejected');
  });
  it('preserves the last authoritative receipt if a subsequent write fails before the store catches up', async () => {
    const a = deferred(); const b = deferred(); const onWrite = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = renderHook(() => useCapabilitySubmission({ state: initial, enabled: true, scope: 'a', onWrite }));
    act(() => { result.current.write(initial.id, 0.5); });
    await act(async () => a.resolve({ outcome: 'completed', state: { ...initial, value: 0.5, updatedAt: 2 } }));
    act(() => { result.current.write(initial.id, 0.9); });
    await act(async () => b.resolve({ outcome: 'failed', error: 'Rejected' }));
    expect(result.current.displayState?.value).toBe(0.5);
  });
  it.each(['scope', 'permission', 'unmount'])('discards pending presentation on %s changes', async kind => {
    const request = deferred(); const onWrite = vi.fn(() => request.promise);
    const { result, rerender, unmount } = renderHook(props => useCapabilitySubmission({ state: initial, onWrite, ...props }), { initialProps: { enabled: true, scope: 'a' } });
    act(() => { result.current.write(initial.id, 0.8); });
    if (kind === 'unmount') unmount(); else rerender({ enabled: kind !== 'permission', scope: kind === 'scope' ? 'b' : 'a' });
    await act(async () => request.resolve({ outcome: 'completed', state: { ...initial, value: 0.8, updatedAt: 2 } }));
    if (kind !== 'unmount') expect(result.current.displayState?.value).toBe(0.2);
  });
  it('bounds a local controlled consumer that never publishes its result', () => {
    vi.useFakeTimers(); const onWrite = vi.fn();
    const { result } = renderHook(() => useCapabilitySubmission({ state: initial, enabled: true, scope: 'a', onWrite }));
    act(() => { result.current.write(initial.id, 0.8); }); expect(result.current.displayState?.value).toBe(0.8);
    act(() => vi.runAllTimers()); expect(result.current.displayState?.value).toBe(0.2); expect(onWrite).toHaveBeenCalledOnce();
  });
});
