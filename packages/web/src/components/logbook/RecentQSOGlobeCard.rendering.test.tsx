// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
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
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.globe.resumeAnimation).toHaveBeenCalledTimes(resumeCount + 1);
  });
});
