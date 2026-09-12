// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeterData } from '@tx5dr/contracts';
import { useBufferedMeterData } from '../useBufferedMeterData';

const power = { raw: 10, watts: 10, maxWatts: 100, percent: 10 };
const initial: MeterData = { swr: { raw: 1.2, swr: 1.2, alert: false }, alc: null, level: null, power };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('independent meter hold lifetimes', () => {
  it('holds a missing reading for three seconds while other meters update', () => {
    const { result, rerender } = renderHook(({ data }) => useBufferedMeterData(data, true), { initialProps: { data: initial } });
    rerender({ data: { ...initial, swr: null } });
    act(() => vi.advanceTimersByTime(2000));
    rerender({ data: { ...initial, swr: null, power: { ...power, watts: 20 } } });
    expect(result.current.swr).toEqual({ value: initial.swr, isTimeout: false });
    act(() => vi.advanceTimersByTime(999));
    expect(result.current.swr.isTimeout).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.swr.isTimeout).toBe(true);
    expect(result.current.power.value?.watts).toBe(20);
  });

  it('cancels the deadline when a new reading arrives', () => {
    const { result, rerender } = renderHook(({ data }) => useBufferedMeterData(data, true), { initialProps: { data: initial } });
    rerender({ data: { ...initial, swr: null } });
    act(() => vi.advanceTimersByTime(2500));
    const current = { ...initial.swr!, raw: 1.3, swr: 1.3 };
    rerender({ data: { ...initial, swr: current } });
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.swr).toEqual({ value: current, isTimeout: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears TX readings immediately and rejects a sample from the previous PTT epoch', () => {
    const { result, rerender } = renderHook(({ data, transmitting }) => useBufferedMeterData(data, transmitting), { initialProps: { data: initial, transmitting: true } });
    rerender({ data: initial, transmitting: false });
    expect(result.current.power).toEqual({ value: null, isTimeout: true });
    rerender({ data: initial, transmitting: true });
    expect(result.current.power.value).toBeNull();
    rerender({ data: { ...initial, power: { ...power } }, transmitting: true });
    expect(result.current.power.value).toEqual(power);
  });

  it('cleans up timers on unmount under StrictMode', () => {
    const { rerender, unmount } = renderHook(({ data }) => useBufferedMeterData(data, true), {
      initialProps: { data: initial }, wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    rerender({ data: { ...initial, swr: null, power: null } });
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
