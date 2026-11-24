// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecentQSOGlobeCard from './RecentQSOGlobeCard';
import type { GlobeMarker } from '../../utils/globeMarkerLayer';

const mocks = vi.hoisted(() => {
  const canvas = { current: null as HTMLCanvasElement | null };
  const markers = { current: [] as Array<{ data: { kind: string } }> };
  const props = { current: {} as Record<string, unknown> };
  return {
    canvas,
    markers,
    props,
    globe: {
      pauseAnimation: () => {},
      resumeAnimation: () => {},
      lights: () => [],
      controls: () => ({ autoRotate: true }),
      renderer: () => ({ domElement: canvas.current }),
    },
  };
});

vi.mock('react-globe.gl', async () => {
  const React = await import('react');
  return { default: React.forwardRef((props: Record<string, unknown>, ref) => {
    mocks.props.current = props;
    React.useImperativeHandle(ref, () => mocks.globe);
    return <canvas data-testid="globe-canvas" ref={(element) => { mocks.canvas.current = element; }} />;
  }) };
});
// Picking needs a rendered camera; here any click on the canvas hits the live station.
vi.mock('../../utils/globeMarkerLayer', () => ({
  createGlobeMarkerLayer: () => ({
    mesh: { visible: true, renderOrder: 0, scale: { x: 1, setScalar: () => {} } },
    altitude: 0,
    setGlobeRadius: () => {},
    setVisible: () => {},
    setMarkers: (next: GlobeMarker[]) => { mocks.markers.current = next as never; },
    pick: () => mocks.markers.current.find(marker => marker.data.kind === 'live') ?? null,
    setLabelContainer: () => {},
    dispose: () => {},
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: { getStationInfo: () => Promise.resolve({ data: {} }) } }));

beforeEach(() => {
  // jsdom has no PointerEvent; without one, pointer events lose their coordinates.
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? 'mouse';
    }
  });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 400, width: 1000, height: 400, toJSON() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const liveDecodes = {
  operatorId: 'op', band: '20m', slotMs: 15_000,
  slots: [{
    operatorId: 'op', slotId: 's', slotStartMs: Date.now() - 20_000, slotMs: 15_000, band: '20m',
    decodes: [{ callsign: 'JA1ABC', message: 'CQ JA1ABC PM95', messageType: 'cq' as const, snr: -8, dt: 0, freq: 1200,
      location: { lat: 35.7, lng: 139.7, precision: 'grid' as const }, analysis: { isNewDxccEntity: true } }],
  }],
};

function setup() {
  const select = vi.fn(async () => ({ requestId: 'r', operatorId: 'op-1', callsign: 'JA1ABC', status: 'called' as const }));
  const view = render(
    <RecentQSOGlobeCard logBookId="fixture" qsos={[]} loading={false} pageSize={25} pageSizeOptions={[25]} onPageSizeChange={() => {}}
      liveDecodes={liveDecodes}
      liveTargeting={{ supported: true, operators: [{ id: 'op-1', label: 'BG5DRB' }], defaultOperatorId: 'op-1', select }} />,
  );
  const canvas = view.getByTestId('globe-canvas');
  const press = (from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1], pointerType: 'mouse' });
    fireEvent.pointerUp(canvas, { clientX: to[0], clientY: to[1], pointerType: 'mouse' });
  };
  return { view, canvas, select, press };
}

describe('calling a heard station from the globe', () => {
  it('pins the station card on a click, not on a drag, and closes it with Escape', async () => {
    const { view, press } = setup();
    await act(async () => {});

    act(() => press([200, 150], [230, 150]));
    expect(view.queryByRole('dialog')).toBeNull();

    act(() => press([200, 150], [201, 151]));
    expect(view.getByRole('dialog')).toBeTruthy();
    expect(view.getByText('globe.callAction')).toBeTruthy();

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('calls at once on a double click', async () => {
    const { view, canvas, select } = setup();
    await act(async () => {});
    await act(async () => { fireEvent.doubleClick(canvas, { clientX: 200, clientY: 150 }); });
    expect(select).toHaveBeenCalledWith('op-1', expect.objectContaining({ callsign: 'JA1ABC' }));
    expect(view.getByRole('status').textContent).toBe('globe.callSent');
  });
});

describe('pinned station card and camera moves', () => {
  // Regression: closing on every camera change closed the card at once while
  // the globe was auto-rotating.
  it('stays open while the globe turns by itself and closes when the user drags', async () => {
    const { view, canvas, press } = setup();
    await act(async () => {});
    act(() => press([200, 150], [200, 150]));
    expect(view.getByRole('dialog')).toBeTruthy();

    act(() => { (mocks.props.current.onZoom as (pov: object) => void)({ lat: 10, lng: 20, altitude: 1 }); });
    expect(view.getByRole('dialog')).toBeTruthy();

    act(() => {
      fireEvent.pointerDown(canvas, { clientX: 300, clientY: 200, pointerType: 'mouse' });
      fireEvent.pointerMove(canvas, { clientX: 340, clientY: 200, pointerType: 'mouse' });
    });
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
