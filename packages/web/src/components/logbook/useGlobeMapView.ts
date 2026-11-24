import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { GlobeMethods } from 'react-globe.gl';
import {
  createGlobeMapSceneSync,
  getFlatMapViewLimits,
  installGlobeMapPasses,
  needsSidePasses,
  type GlobeMapProjection,
} from '../../utils/globeMapProjection';
import { createLogger } from '../../utils/logger';

const logger = createLogger('GlobeMapView');

/**
 * The logbook globe's 3D globe / flat map switch (see globeMapProjection).
 *
 * Unrolling animates one shared uniform; the scene is never rebuilt. On the
 * flat map the camera still orbits the globe centre, which pans the map, so
 * globe.gl's controls and the trackpad gestures keep working; the controls
 * only get map limits: the view stays within the map's latitudes and cannot
 * zoom out past about a world and a quarter.
 */

export type GlobeView = 'globe' | 'flat';

const STORAGE_KEY = 'tx5dr.logbook.globeView';
const MORPH_MS = 800;
/** Frames to wait for globe.gl to create its renderer (about ten seconds). */
const INSTALL_WAIT_FRAMES = 600;

type Controls = {
  autoRotate: boolean;
  minPolarAngle: number;
  maxPolarAngle: number;
  maxDistance: number;
};
type Camera = {
  position: { length(): number };
  fov: number;
  aspect: number;
};
type SceneRoot = { children: unknown[] };

export function loadGlobeView(): GlobeView {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'flat' ? 'flat' : 'globe';
  } catch {
    return 'globe';
  }
}

function saveGlobeView(view: GlobeView): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

/** globe.gl's three-globe object: the root of every globe layer. */
function findGlobeRoot(scene: SceneRoot): { traverse(callback: (node: never) => void): void } | null {
  for (const child of scene.children) {
    if (child && typeof (child as { getGlobeRadius?: unknown }).getGlobeRadius === 'function') {
      return child as { traverse(callback: (node: never) => void): void };
    }
  }
  return null;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface GlobePanLimits {
  maxLatitude: number;
  /** A degree of longitude is the same width at every latitude (the flat map). */
  uniformLongitude: boolean;
}

export function useGlobeMapView(
  globeRef: RefObject<GlobeMethods | undefined>,
  projection: GlobeMapProjection,
  running: boolean,
) {
  const [view, setView] = useState<GlobeView>(loadGlobeView);
  const flatRef = useRef(view === 'flat');
  flatRef.current = view === 'flat';
  const runningRef = useRef(running);
  runningRef.current = running;
  const defaultsRef = useRef<Pick<Controls, 'minPolarAngle' | 'maxPolarAngle' | 'maxDistance'> | null>(null);

  // Hooks the render loop once globe.gl has built it.
  useEffect(() => {
    let frame = 0;
    let remaining = INSTALL_WAIT_FRAMES;
    let uninstall: (() => void) | null = null;
    const install = () => {
      const globe = globeRef.current;
      if (!globe || typeof globe.postProcessingComposer !== 'function' || typeof globe.scene !== 'function') {
        if (--remaining > 0) frame = window.requestAnimationFrame(install);
        return;
      }
      const scene = globe.scene() as unknown as SceneRoot & Parameters<typeof installGlobeMapPasses>[0]['scene'];
      const camera = globe.camera() as unknown as Camera;
      const controls = globe.controls() as unknown as Controls;
      const radius = globe.getGlobeRadius();
      projection.setRadius(radius);
      defaultsRef.current = {
        minPolarAngle: controls.minPolarAngle,
        maxPolarAngle: controls.maxPolarAngle,
        maxDistance: controls.maxDistance,
      };
      const sceneSync = createGlobeMapSceneSync(projection);
      let root = findGlobeRoot(scene);
      uninstall = installGlobeMapPasses({
        composer: globe.postProcessingComposer() as unknown as Parameters<typeof installGlobeMapPasses>[0]['composer'],
        scene,
        camera,
        projection,
        beforeFrame: () => {
          root ??= findGlobeRoot(scene);
          if (root) sceneSync.sync(root as never);
          const limits = getFlatMapViewLimits(camera.position.length() / radius - 1, camera.fov, camera.aspect);
          if (flatRef.current && projection.morph >= 1) {
            const maxLatitude = (limits.maxCenterLatitude * Math.PI) / 180;
            controls.minPolarAngle = Math.PI / 2 - maxLatitude;
            controls.maxPolarAngle = Math.PI / 2 + maxLatitude;
            controls.maxDistance = radius * (1 + limits.maxAltitude);
          }
          return needsSidePasses(projection.morph, limits.halfWidth);
        },
      });
      logger.debug('Globe map projection installed');
    };
    install();
    return () => {
      window.cancelAnimationFrame(frame);
      uninstall?.();
    };
  }, [globeRef, projection]);

  // Unrolls or rolls up the globe. The first run applies the saved view at once.
  const firstRunRef = useRef(true);
  useEffect(() => {
    const flat = view === 'flat';
    const target = flat ? 1 : 0;
    const globe = globeRef.current;
    const controls = globe && typeof globe.controls === 'function' ? globe.controls() as unknown as Controls : null;
    if (controls) {
      if (flat) {
        controls.autoRotate = false;
      } else if (defaultsRef.current) {
        Object.assign(controls, defaultsRef.current);
      }
    }
    if (firstRunRef.current) {
      firstRunRef.current = false;
      projection.setMorph(target);
      return;
    }
    saveGlobeView(view);
    logger.info('Logbook globe view changed', { view });
    if (!runningRef.current || !globe) {
      projection.setMorph(target);
      return;
    }

    if (flat && typeof globe.camera === 'function') {
      // Land on a view the map allows, while it unrolls.
      const camera = globe.camera() as unknown as Camera;
      const pov = globe.pointOfView();
      const altitude = Math.min(pov.altitude, getFlatMapViewLimits(pov.altitude, camera.fov, camera.aspect).maxAltitude);
      const maxLatitude = getFlatMapViewLimits(altitude, camera.fov, camera.aspect).maxCenterLatitude;
      const lat = Math.max(-maxLatitude, Math.min(maxLatitude, pov.lat));
      if (altitude !== pov.altitude || lat !== pov.lat) {
        globe.pointOfView({ lat, lng: pov.lng, altitude }, MORPH_MS);
      }
    }

    const start = projection.morph;
    const duration = MORPH_MS * Math.abs(target - start);
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = duration > 0 ? Math.min(1, (now - startedAt) / duration) : 1;
      projection.setMorph(start + (target - start) * easeInOutCubic(t));
      if (t < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(frame);
      // A switch cut short still ends in a whole view.
      if (!runningRef.current) projection.setMorph(target);
    };
  }, [view, globeRef, projection]);


  /** Pan bounds for the trackpad gestures at an altitude; null on the globe. */
  const getPanLimits = useCallback((altitude: number): GlobePanLimits | null => {
    if (!flatRef.current) return null;
    const camera = globeRef.current && typeof globeRef.current.camera === 'function'
      ? globeRef.current.camera() as unknown as Camera
      : null;
    return {
      maxLatitude: getFlatMapViewLimits(altitude, camera?.fov ?? 50, camera?.aspect ?? 1).maxCenterLatitude,
      uniformLongitude: true,
    };
  }, [globeRef]);

  return { view, setView, flatRef, getPanLimits };
}
