// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobeMethods } from 'react-globe.gl';

import {
  classifyGlobeWheel,
  getGlobeRadiansPerPixel,
  useGlobeTrackpadGestures,
  type GlobeView,
} from './useGlobeTrackpadGestures';

const wheel = (overrides: Partial<Parameters<typeof classifyGlobeWheel>[0]>) => ({
  ctrlKey: false,
  deltaMode: 0,
  deltaX: 0,
  deltaY: 0,
  ...overrides,
});

describe('classifyGlobeWheel', () => {
  it('recognises pinches, trackpad scrolls and mouse wheels', () => {
    expect(classifyGlobeWheel(wheel({ ctrlKey: true, deltaY: 3 }), null, 0)).toBe('pinch');
    expect(classifyGlobeWheel(wheel({ deltaX: 6, deltaY: 1.5 }), null, 0)).toBe('trackpad');
    expect(classifyGlobeWheel(wheel({ deltaY: 2.2 }), null, 0)).toBe('trackpad');
    expect(classifyGlobeWheel(wheel({ deltaY: 4.000244140625 * 2 }), null, 0)).toBe('mouse');
    expect(classifyGlobeWheel(wheel({ deltaY: 100, wheelDeltaY: -120 }), null, 0)).toBe('mouse');
    expect(classifyGlobeWheel(wheel({ deltaMode: 1, deltaY: 3 }), null, 0)).toBe('mouse');
  });

  it('keeps the kind of an ongoing sequence', () => {
    const previous = { kind: 'trackpad' as const, at: 1000 };
    expect(classifyGlobeWheel(wheel({ deltaY: 100, wheelDeltaY: -120 }), previous, 1100)).toBe('trackpad');
    expect(classifyGlobeWheel(wheel({ deltaY: 100, wheelDeltaY: -120 }), previous, 1400)).toBe('mouse');
  });
});

describe('getGlobeRadiansPerPixel', () => {
  it('moves the globe less per pixel when zoomed in', () => {
    expect(getGlobeRadiansPerPixel(0.2, 600, 50)).toBeLessThan(getGlobeRadiansPerPixel(1, 600, 50));
  });

  it('does not pan before the globe has a size', () => {
    expect(getGlobeRadiansPerPixel(1, 0, 50)).toBe(0);
  });
});

describe('useGlobeTrackpadGestures', () => {
  let pov: GlobeView;
  let canvas: HTMLCanvasElement;
  let views: GlobeView[];
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    pov = { lat: 30, lng: 120, altitude: 1 };
    views = [];
    canvas = document.createElement('canvas');
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    frames.length = 0;
  });

  function Harness() {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const globeRef = useRef<GlobeMethods | undefined>({
      pointOfView: (next?: Partial<GlobeView>) => {
        if (next) {
          pov = { ...pov, ...next };
          return undefined;
        }
        return pov;
      },
      camera: () => ({ fov: 50 }),
      controls: () => ({ minDistance: 101, maxDistance: 10000 }),
      renderer: () => ({ domElement: canvas }),
    } as unknown as GlobeMethods);
    useGlobeTrackpadGestures(containerRef, globeRef, view => views.push(view));
    return (
      <div ref={(element) => {
        containerRef.current = element;
        if (element && !element.contains(canvas)) element.appendChild(canvas);
      }}>
        <div data-testid="overlay" />
      </div>
    );
  }

  const flush = () => act(() => {
    frames.splice(0).forEach(callback => callback(0));
  });

  it('pans on a trackpad drag and zooms on a pinch in the same frame', () => {
    render(<Harness />);
    const drag = new WheelEvent('wheel', { deltaX: 3, deltaY: 2, bubbles: true, cancelable: true });
    const pinch = new WheelEvent('wheel', { deltaY: -20, ctrlKey: true, bubbles: true, cancelable: true });
    canvas.dispatchEvent(drag);
    canvas.dispatchEvent(pinch);
    expect(drag.defaultPrevented).toBe(true);
    expect(pinch.defaultPrevented).toBe(true);

    flush();
    expect(views).toHaveLength(1);
    expect(pov.lng).toBeGreaterThan(120);
    expect(pov.lng).toBeLessThan(121);
    expect(pov.lat).toBeLessThan(30);
    expect(pov.altitude).toBeLessThan(1);
  });

  it('eases towards the gesture target and then stops requesting frames', () => {
    render(<Harness />);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 0, bubbles: true, cancelable: true }));
    flush();
    const firstStep = pov.lng - 120;
    for (let index = 0; index < 200 && frames.length > 0; index += 1) flush();

    expect(frames).toHaveLength(0);
    expect(pov.lng - 120).toBeGreaterThan(firstStep * 2);
  });

  it('hands the camera back when the globe is dragged directly', () => {
    render(<Harness />);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 0, bubbles: true, cancelable: true }));
    flush();
    const afterFirstFrame = { ...pov };
    canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    flush();
    expect(pov).toEqual(afterFirstFrame);
  });

  it('leaves mouse wheels and overlay scrolling alone', () => {
    const rendered = render(<Harness />);
    const mouse = new WheelEvent('wheel', { deltaY: 4.000244140625 * 3, bubbles: true, cancelable: true });
    canvas.dispatchEvent(mouse);
    const overlay = new WheelEvent('wheel', { deltaY: 2, bubbles: true, cancelable: true });
    rendered.getByTestId('overlay').dispatchEvent(overlay);
    flush();

    expect(mouse.defaultPrevented).toBe(false);
    expect(overlay.defaultPrevented).toBe(false);
    expect(views).toEqual([]);
  });
});
