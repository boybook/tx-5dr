import { useEffect, useRef, type RefObject } from 'react';
import type { GlobeMethods } from 'react-globe.gl';

/**
 * Native-map style trackpad gestures for the logbook globe.
 *
 * Browsers deliver trackpad gestures as wheel events: a two-finger drag as a
 * plain wheel event and a pinch as a wheel event with `ctrlKey` (Chromium,
 * Firefox), or as WebKit `gesture*` events (Safari). globe.gl's OrbitControls
 * treats every wheel event as zoom, so trackpad drags and pinches are taken
 * over here before they reach the canvas: drags rotate the globe so the point
 * under the fingers follows them, pinches zoom, and both may happen at once.
 * Mouse wheels are left to OrbitControls, so other platforms keep their
 * behaviour. There is no reliable device signal, so the wheel source is
 * inferred from delta values, as map libraries do.
 */

export type GlobeWheelKind = 'pinch' | 'trackpad' | 'mouse';

/** macOS mouse wheels report multiples of this delta (from MapLibre's scroll zoom). */
const MAC_MOUSE_WHEEL_DELTA = 4.000244140625;
/** Events of one gesture arrive in a stream; keep its first classification. */
const WHEEL_SEQUENCE_GAP_MS = 200;
/**
 * macOS accelerates scroll deltas, so a strict "surface follows the fingers"
 * mapping overshoots on fast swipes; this scales it down to feel natural.
 */
const PAN_SENSITIVITY = 0.55;
const PINCH_ZOOM_RATE = 0.006;
/** Bounds one event's zoom; Ctrl + mouse wheel notches report large deltas. */
const MAX_PINCH_DELTA = 25;
/** Share of the remaining distance to the target covered per 60 Hz frame. */
const SMOOTHING_PER_FRAME = 0.3;
const FRAME_MS = 1000 / 60;
const SETTLE_DEGREES = 0.0005;
const SETTLE_LOG_ALTITUDE = 0.0003;
const MIN_ALTITUDE = 0.05;
const MAX_ALTITUDE = 10;
const MAX_LATITUDE = 85;
const MIN_LONGITUDE_SCALE = 0.25;
const GLOBE_RADIUS = 100;

interface WheelLike {
  ctrlKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  /** Legacy non-standard delta; multiples of 120 come from wheel notches. */
  wheelDeltaY?: number;
}

/**
 * Classifies a wheel event. A pinch is recognised per event; a scroll keeps
 * the kind of the sequence it belongs to, so momentum events do not flip it.
 */
export function classifyGlobeWheel(
  event: WheelLike,
  previous: { kind: Exclude<GlobeWheelKind, 'pinch'>; at: number } | null,
  now: number,
): GlobeWheelKind {
  if (event.ctrlKey) return 'pinch';
  if (previous && now - previous.at < WHEEL_SEQUENCE_GAP_MS) return previous.kind;
  if (event.deltaMode !== 0) return 'mouse';
  if (event.deltaX !== 0) return 'trackpad';
  const delta = Math.abs(event.deltaY);
  if (delta > 0 && delta < 4) return 'trackpad';
  if (delta > 0 && delta % MAC_MOUSE_WHEEL_DELTA === 0) return 'mouse';
  if (event.wheelDeltaY && event.wheelDeltaY % 120 === 0) return 'mouse';
  return 'trackpad';
}

/** Radians of globe rotation per screen pixel, so the surface follows the fingers. */
export function getGlobeRadiansPerPixel(altitude: number, viewportHeight: number, fovDegrees: number): number {
  // Before layout there is no meaningful scale; do not pan at all.
  if (viewportHeight <= 0) return 0;
  const halfFov = (fovDegrees * Math.PI) / 360;
  return (2 * Math.max(altitude, 0.001) * Math.tan(halfFov)) / viewportHeight;
}

interface GestureEventLike extends Event {
  scale: number;
}

type ControlsLike = { autoRotate?: boolean; minDistance?: number; maxDistance?: number };
type CameraLike = { fov?: number };

export interface GlobeView {
  lat: number;
  lng: number;
  altitude: number;
}

/** Pan bounds of a flat map view; null on the globe. */
export type GlobePanLimitsFn = (altitude: number) => { maxLatitude: number; uniformLongitude: boolean } | null;

export function useGlobeTrackpadGestures(
  containerRef: RefObject<HTMLElement | null>,
  globeRef: RefObject<GlobeMethods | undefined>,
  onViewChange: (view: GlobeView) => void,
  getPanLimits?: GlobePanLimitsFn,
): void {
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const getPanLimitsRef = useRef(getPanLimits);
  getPanLimitsRef.current = getPanLimits;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let previousScroll: { kind: Exclude<GlobeWheelKind, 'pinch'>; at: number } | null = null;
    let frame = 0;
    let lastFrameAt = 0;
    let gestureActive = false;
    let gestureStartAltitude = 1;
    /**
     * Gestures move this target; each frame eases the camera towards it, so
     * uneven event timing still renders as smooth motion at the display rate.
     * Longitude is kept unwrapped so a long swipe does not jump at ±180.
     */
    let target: GlobeView | null = null;

    const altitudeLimits = () => {
      const controls = globeRef.current?.controls() as ControlsLike | undefined;
      const min = controls?.minDistance ? controls.minDistance / GLOBE_RADIUS - 1 : MIN_ALTITUDE;
      const max = controls?.maxDistance ? controls.maxDistance / GLOBE_RADIUS - 1 : MAX_ALTITUDE;
      return { min: Math.max(MIN_ALTITUDE, min), max: Math.min(MAX_ALTITUDE, max) };
    };
    const clampAltitude = (altitude: number) => {
      const { min, max } = altitudeLimits();
      return Math.min(max, Math.max(min, altitude));
    };

    const ensureTarget = (): GlobeView | null => {
      if (!target) {
        const view = globeRef.current?.pointOfView() as GlobeView | undefined;
        if (!view) return null;
        target = { ...view };
      }
      return target;
    };

    const panTarget = (dx: number, dy: number) => {
      const next = ensureTarget();
      const globe = globeRef.current;
      if (!next || !globe) return;
      const camera = globe.camera() as CameraLike;
      const radiansPerPixel = getGlobeRadiansPerPixel(next.altitude, container.clientHeight, camera.fov ?? 50);
      const degreesPerPixel = (radiansPerPixel * PAN_SENSITIVITY * 180) / Math.PI;
      // A flat map keeps its edge out of view and is as wide at every latitude.
      const limits = getPanLimitsRef.current?.(next.altitude) ?? null;
      const maxLatitude = limits ? Math.min(MAX_LATITUDE, limits.maxLatitude) : MAX_LATITUDE;
      next.lat = Math.max(-maxLatitude, Math.min(maxLatitude, next.lat - dy * degreesPerPixel));
      const longitudeScale = limits?.uniformLongitude ? 1 : Math.max(MIN_LONGITUDE_SCALE, Math.cos((next.lat * Math.PI) / 180));
      next.lng += (dx * degreesPerPixel) / longitudeScale;
    };

    const step = (time: number) => {
      frame = 0;
      const globe = globeRef.current;
      const goal = target;
      if (!globe || !goal) {
        lastFrameAt = 0;
        return;
      }
      const current = globe.pointOfView() as GlobeView;
      const elapsed = lastFrameAt ? Math.min(64, Math.max(1, time - lastFrameAt)) : FRAME_MS;
      lastFrameAt = time;
      // Frame-rate independent easing: the same feel at 60 Hz and 120 Hz.
      const ease = 1 - Math.pow(1 - SMOOTHING_PER_FRAME, elapsed / FRAME_MS);

      const lngGap = ((((goal.lng - current.lng) % 360) + 540) % 360) - 180;
      const latGap = goal.lat - current.lat;
      const logAltitudeGap = Math.log(goal.altitude) - Math.log(current.altitude);
      const settled = Math.abs(lngGap) < SETTLE_DEGREES
        && Math.abs(latGap) < SETTLE_DEGREES
        && Math.abs(logAltitudeGap) < SETTLE_LOG_ALTITUDE;
      const factor = settled ? 1 : ease;

      let lng = current.lng + lngGap * factor;
      lng = ((((lng + 180) % 360) + 360) % 360) - 180;
      const view = {
        lat: current.lat + latGap * factor,
        lng,
        altitude: Math.exp(Math.log(current.altitude) + logAltitudeGap * factor),
      };
      // Keep the target continuous with the normalised camera longitude.
      goal.lng = view.lng + lngGap * (1 - factor);

      (globe.controls() as ControlsLike).autoRotate = false;
      globe.pointOfView(view, 0);
      onViewChangeRef.current(view);

      if (settled) {
        target = null;
        lastFrameAt = 0;
      } else {
        frame = window.requestAnimationFrame(step);
      }
    };

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(step);
    };

    // A direct drag hands the camera back to OrbitControls.
    const handlePointerDown = () => {
      target = null;
      lastFrameAt = 0;
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    // Only gestures over the globe itself; overlays such as the DXCC panel
    // keep their own scrolling.
    const isOnGlobe = (event: Event) => {
      const canvas = (globeRef.current?.renderer() as { domElement?: HTMLElement } | undefined)?.domElement;
      const target = event.target as Node | null;
      return !!canvas && !!target && (canvas === target || canvas.contains(target));
    };

    const handleWheel = (event: WheelEvent) => {
      if (!isOnGlobe(event)) return;
      const now = performance.now();
      const kind = classifyGlobeWheel(event as WheelEvent & { wheelDeltaY?: number }, previousScroll, now);
      if (kind !== 'pinch') previousScroll = { kind, at: now };
      if (kind === 'mouse') return;

      // Keep the event from OrbitControls, page zoom and history swipes.
      event.preventDefault();
      event.stopPropagation();
      if (kind === 'pinch') {
        // Safari reports pinches as gesture events; avoid counting them twice.
        const next = gestureActive ? null : ensureTarget();
        if (next) {
          const delta = Math.max(-MAX_PINCH_DELTA, Math.min(MAX_PINCH_DELTA, event.deltaY));
          next.altitude = clampAltitude(next.altitude * Math.exp(delta * PINCH_ZOOM_RATE));
        }
      } else {
        const scale = event.deltaMode === 1 ? 16 : 1;
        panTarget(event.deltaX * scale, event.deltaY * scale);
      }
      schedule();
    };

    const handleGestureStart = (event: Event) => {
      if (!isOnGlobe(event)) return;
      event.preventDefault();
      gestureActive = true;
      gestureStartAltitude = ensureTarget()?.altitude ?? 1;
    };
    const handleGestureChange = (event: Event) => {
      if (!gestureActive) return;
      event.preventDefault();
      const scale = (event as GestureEventLike).scale;
      const next = scale ? ensureTarget() : null;
      if (!next) return;
      next.altitude = clampAltitude(gestureStartAltitude / scale);
      schedule();
    };
    const handleGestureEnd = (event: Event) => {
      if (!gestureActive) return;
      event.preventDefault();
      gestureActive = false;
    };

    // Capture on the container so the events are handled before they reach
    // the canvas, where OrbitControls listens.
    container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    container.addEventListener('pointerdown', handlePointerDown, { capture: true });
    container.addEventListener('gesturestart', handleGestureStart, { passive: false });
    container.addEventListener('gesturechange', handleGestureChange, { passive: false });
    container.addEventListener('gestureend', handleGestureEnd, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true });
      container.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      container.removeEventListener('gesturestart', handleGestureStart);
      container.removeEventListener('gesturechange', handleGestureChange);
      container.removeEventListener('gestureend', handleGestureEnd);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [containerRef, globeRef]);
}
