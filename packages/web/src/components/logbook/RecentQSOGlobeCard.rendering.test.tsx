// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecentQSOGlobeCard from './RecentQSOGlobeCard';

const mocks = vi.hoisted(() => ({
  globe: { pauseAnimation: vi.fn(), resumeAnimation: vi.fn(), lights: () => [] },
  props: {} as Record<string, unknown>,
  t: (key: string) => key,
  getLogBookWorkedGrids: vi.fn(),
}));
vi.mock('react-globe.gl', async () => {
  const React = await import('react');
  return { default: React.forwardRef((props, ref) => {
    mocks.props = props;
    React.useImperativeHandle(ref, () => mocks.globe);
    return <div data-testid="globe" />;
  }) };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
  // The highlight settings module initialises i18n on import.
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@tx5dr/core', async original => ({
  ...await original<object>(),
  api: {
    getStationInfo: () => Promise.resolve({ data: {} }),
    getLogBookWorkedGrids: mocks.getLogBookWorkedGrids,
  },
}));

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
  // jsdom has no 2D canvas; the grid layer then draws without labels.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 400, width: 1000, height: 400, toJSON() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('logbook globe drawing lifetime', () => {
  it('pauses offscreen or in a hidden document, resumes in view, and releases listeners', async () => {
    const props = { logBookId: 'fixture', qsos: [], loading: false, pageSize: 25, pageSizeOptions: [25, 50], onPageSizeChange: () => {} };
    const view = render(<RecentQSOGlobeCard {...props} />);
    await act(async () => {});
    const layers = mocks.props.customLayerData;
    const arcs = mocks.props.arcsData;
    view.rerender(<RecentQSOGlobeCard {...props} pageSize={50} />);
    expect(mocks.props.customLayerData).toBe(layers);
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
    expect(rendered.queryByRole('radiogroup', { name: 'globe.receptionTheme' })).toBeNull();

    fireEvent.mouseEnter(rendered.getByLabelText('globe.receptionHide').parentElement!);
    const spectrum = rendered.getByRole('radio', { name: 'globe.receptionThemeSpectrum' });
    expect(spectrum.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(spectrum);
    expect(rendered.getByRole('radio', { name: 'globe.receptionThemeSpectrum' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('logbook globe GPU overlays', () => {
  const props = { logBookId: 'fixture', qsos: [], loading: false, pageSize: 25, pageSizeOptions: [25, 50], onPageSizeChange: () => {} };
  type ShellLayer = { mesh: { visible: boolean } };

  it('draws grids and the terminator as shell layers instead of per-cell objects', async () => {
    mocks.getLogBookWorkedGrids.mockResolvedValue({
      success: true,
      data: { items: [{ grid: 'PM01', count: 3, confirmedCount: 1 }], meta: { total: 1 } },
    });
    const rendered = render(<RecentQSOGlobeCard {...props} bandFilter="20m" modeFilter="FT4" />);
    await act(async () => {});

    const [gridLayer, terminatorLayer] = mocks.props.customLayerData as ShellLayer[];
    expect(gridLayer.mesh.visible).toBe(false);
    expect(terminatorLayer.mesh.visible).toBe(true);
    expect(mocks.props.pathsData).toBeUndefined();
    expect(mocks.props.tilesData).toBeUndefined();
    expect(mocks.props.labelsData).toBeUndefined();

    await act(async () => { fireEvent.click(rendered.getByLabelText('globe.showWorkedGrids')); });
    expect(mocks.getLogBookWorkedGrids).toHaveBeenCalledWith('fixture', { band: '20m', mode: 'FT4' });
    expect(gridLayer.mesh.visible).toBe(true);
    expect(rendered.getByText('globe.legendConfirmed')).toBeTruthy();

    act(() => { fireEvent.click(rendered.getByLabelText('globe.hideTerminator')); });
    expect(terminatorLayer.mesh.visible).toBe(false);
    // Toggling overlays never replaces the layer list, so globe.gl keeps the meshes.
    expect((mocks.props.customLayerData as ShellLayer[])[0]).toBe(gridLayer);
  });
});

describe('logbook globe hover panels', () => {
  const props = { logBookId: 'fixture', qsos: [], loading: false, pageSize: 25, pageSizeOptions: [25, 50], onPageSizeChange: () => {} };

  it('keeps the reception panel mounted and animates it open and closed', async () => {
    vi.useFakeTimers();
    try {
      const reception = { state: 'live' as const, callsigns: ['BG5DRB'], windowMs: 1_800_000, spots: [] };
      const rendered = render(<RecentQSOGlobeCard {...props} reception={reception} />);
      await act(async () => {});
      const panel = rendered.container.querySelector('.globe-pop[aria-hidden]') as HTMLElement;
      expect(panel.dataset.open).toBe('false');

      const chip = rendered.getByText('globe.receptionWaiting').closest('div.relative') as HTMLElement;
      act(() => { fireEvent.mouseEnter(chip); });
      expect(panel.dataset.open).toBe('true');

      act(() => { fireEvent.mouseLeave(chip); });
      act(() => { vi.advanceTimersByTime(250); });
      // Closed, but still in the document so it can animate out.
      expect(panel.dataset.open).toBe('false');
      expect(rendered.container.contains(panel)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('logbook globe live stations', () => {
  const props = { logBookId: 'fixture', qsos: [], loading: false, pageSize: 25, pageSizeOptions: [25, 50], onPageSizeChange: () => {} };

  it('summarises stations heard now and hides them with the toggle', async () => {
    const slotStartMs = Date.now() - 20_000;
    const liveDecodes = {
      operatorId: 'op',
      band: '20m',
      slotMs: 15_000,
      slots: [{
        operatorId: 'op', slotId: 's1', slotStartMs, slotMs: 15_000, band: '20m',
        decodes: [
          { callsign: 'JA1ABC', message: 'CQ JA1ABC PM95', messageType: 'cq' as const, snr: -8, dt: 0, freq: 1200,
            location: { lat: 35.7, lng: 139.7, precision: 'grid' as const }, analysis: { isNewDxccEntity: true } },
          { callsign: 'W1AW', message: 'JA1XYZ W1AW -10', messageType: 'signal_report' as const, snr: -15, dt: 0, freq: 900,
            location: { lat: 41.7, lng: -72.7, precision: 'grid' as const }, analysis: {} },
        ],
      }],
    };
    const rendered = render(<RecentQSOGlobeCard {...props} liveDecodes={liveDecodes} />);
    await act(async () => {});
    expect(mocks.props.pointsData).toBeUndefined();
    expect(rendered.getByText('globe.liveSummary')).toBeTruthy();

    act(() => { fireEvent.click(rendered.getByLabelText('globe.hideLive')); });
    expect(rendered.queryByText('globe.liveSummary')).toBeNull();
  });
});
