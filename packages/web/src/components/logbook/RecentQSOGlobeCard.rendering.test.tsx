// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecentQSOGlobeCard from './RecentQSOGlobeCard';

const mocks = vi.hoisted(() => ({
  globe: { pauseAnimation: vi.fn(), resumeAnimation: vi.fn(), lights: () => [] },
  props: {} as Record<string, unknown>,
  t: (key: string) => key,
}));
vi.mock('react-globe.gl', async () => {
  const React = await import('react');
  return { default: React.forwardRef((props, ref) => {
    mocks.props = props;
    React.useImperativeHandle(ref, () => mocks.globe);
    return <div data-testid="globe" />;
  }) };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: { getStationInfo: () => Promise.resolve({ data: {} }) } }));

let intersection: IntersectionObserverCallback;
let disconnect: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe() {} disconnect = disconnect;
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 400, width: 1000, height: 400, toJSON() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('logbook globe drawing lifetime', () => {
  it('pauses offscreen or in a hidden document, resumes in view, and releases listeners', async () => {
    const props = { logBookId: 'fixture', qsos: [], loading: false, pageSize: 25, pageSizeOptions: [25, 50], onPageSizeChange: () => {} };
    const view = render(<RecentQSOGlobeCard {...props} />);
    await act(async () => {});
    const points = mocks.props.pointsData;
    const arcs = mocks.props.arcsData;
    view.rerender(<RecentQSOGlobeCard {...props} pageSize={50} />);
    expect(mocks.props.pointsData).toBe(points);
    expect(mocks.props.arcsData).toBe(arcs);

    act(() => intersection([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(mocks.globe.pauseAnimation).toHaveBeenCalled();
    const resumeCount = mocks.globe.resumeAnimation.mock.calls.length;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => intersection([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(mocks.globe.resumeAnimation).toHaveBeenCalledTimes(resumeCount);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.globe.resumeAnimation).toHaveBeenCalledTimes(resumeCount + 1);
    const pausedCount = mocks.globe.pauseAnimation.mock.calls.length;
    view.rerender(<RecentQSOGlobeCard {...props} active={false} />);
    expect(mocks.globe.pauseAnimation).toHaveBeenCalledTimes(pausedCount + 1);
    view.rerender(<RecentQSOGlobeCard {...props} active />);
    expect(mocks.globe.resumeAnimation).toHaveBeenCalledTimes(resumeCount + 2);
    const resumeBeforeUnmount = mocks.globe.resumeAnimation.mock.calls.length;
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.globe.resumeAnimation).toHaveBeenCalledTimes(resumeBeforeUnmount);
  });
});

describe('logbook globe reception entry', () => {
  const props = { logBookId: 'fixture', qsos: [], loading: false, pageSize: 25, pageSizeOptions: [25, 50], onPageSizeChange: () => {} };
  const view = (state: 'disabled' | 'live') => ({ state, callsigns: ['BG5DRB'], windowMs: 1_800_000, spots: [] });

  it('offers the off-state entry only while reception feedback is disabled', async () => {
    const rendered = render(<RecentQSOGlobeCard {...props} reception={view('disabled')} canEnableReception />);
    await act(async () => {});
    expect(rendered.getByLabelText('globe.receptionOffTitle')).toBeTruthy();

    rendered.rerender(<RecentQSOGlobeCard {...props} reception={view('live')} canEnableReception />);
    expect(rendered.queryByLabelText('globe.receptionOffTitle')).toBeNull();
    expect(rendered.getByText('globe.receptionWaiting')).toBeTruthy();
  });
});

describe('logbook globe reception panel', () => {
  it('opens on hover and switches the heatmap theme inside the panel', async () => {
    const props = { logBookId: 'fixture', qsos: [], loading: false, pageSize: 25, pageSizeOptions: [25, 50], onPageSizeChange: () => {} };
    const reception = { state: 'live' as const, callsigns: ['BG5DRB'], windowMs: 1_800_000, spots: [] };
    const rendered = render(<RecentQSOGlobeCard {...props} reception={reception} />);
    await act(async () => {});
    expect(rendered.queryByRole('radiogroup')).toBeNull();

    fireEvent.mouseEnter(rendered.getByLabelText('globe.receptionHide').parentElement!);
    const spectrum = rendered.getByRole('radio', { name: 'globe.receptionThemeSpectrum' });
    expect(spectrum.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(spectrum);
    expect(rendered.getByRole('radio', { name: 'globe.receptionThemeSpectrum' }).getAttribute('aria-checked')).toBe('true');
  });
});
