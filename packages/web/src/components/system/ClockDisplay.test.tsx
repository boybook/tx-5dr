// @vitest-environment jsdom
import { Profiler } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClockDisplay } from './ClockDisplay';

const mocks = vi.hoisted(() => ({ offset: 0, t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('../../store/authStore', () => ({ useHasMinRole: () => false }));
vi.mock('../../store/radioStore', () => ({
  useClockStatus: () => ({ appliedOffsetMs: mocks.offset }),
  useConnection: () => ({ state: { isConnected: false } }),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); mocks.offset = 0; });

it('updates displayed seconds across midnight and offset changes without committing every poll', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T23:59:59.000Z'));
  const commit = vi.fn();
  const view = render(<Profiler id="clock" onRender={commit}><ClockDisplay /></Profiler>);
  const initialCommits = commit.mock.calls.length;
  act(() => vi.advanceTimersByTime(800));
  expect(view.container.textContent).toContain('23:59:59');
  expect(commit).toHaveBeenCalledTimes(initialCommits);
  act(() => vi.advanceTimersByTime(200));
  expect(view.container.textContent).toContain('00:00:00');
  mocks.offset = 5000;
  view.rerender(<Profiler id="clock" onRender={commit}><ClockDisplay /></Profiler>);
  act(() => vi.advanceTimersByTime(200));
  expect(view.container.textContent).toContain('00:00:05');
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
