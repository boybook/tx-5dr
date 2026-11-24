import * as THREE from 'three';

/**
 * The parts of a three.js mesh the globe shell layers expose. `three` is
 * untyped in this package (see src/types/third-party-globe.d.ts).
 */
export interface GlobeShellMesh {
  visible: boolean;
  renderOrder: number;
  scale: { x: number; setScalar(value: number): void };
}

/**
 * A CSS colour as the globe's custom shaders take it. three linearises CSS
 * colours, but these shaders write their output unconverted to an sRGB
 * canvas, so they need the original sRGB components to match the CSS (and the
 * legends drawn with it).
 */
export function toShaderColor(color: string, target: ShaderColor = new THREE.Color()): ShaderColor {
  return target.set(color).convertLinearToSRGB();
}

/** The parts of a three.js Color the shader layers use. */
export interface ShaderColor {
  r: number;
  g: number;
  b: number;
  set(color: string): ShaderColor;
  convertLinearToSRGB(): ShaderColor;
}

/** Relative altitude of globe.gl's land caps (the `polygonAltitude` prop). */
export const GLOBE_LAND_CAP_ALTITUDE = 0.0025;

/**
 * Clearance a shell keeps above the land caps after its facet sag. The shells
 * that shade the ground skip the depth test, and the near plane follows the
 * camera height (see getCameraNear), but a shell that still tests depth (the
 * grid overlay) needs room to resolve against the caps; closer than this it
 * would z-fight with them and flicker.
 */
export const GLOBE_SHELL_MIN_CAP_CLEARANCE = 0.0012;

/**
 * Deepest dip of a UV sphere's flat facets below the true sphere, relative to
 * its radius: a facet's middle sits half a facet diagonal from its corners.
 */
export function getSphereFacetSag(widthSegments: number, heightSegments: number): number {
  const halfWidth = Math.PI / widthSegments;
  const halfHeight = Math.PI / (2 * heightSegments);
  return 1 - Math.cos(Math.hypot(halfWidth, halfHeight));
}

/**
 * Draw order of the globe's translucent layers, lowest first.
 *
 * The shells that shade the ground (night shade, city lights, haze) enclose
 * the globe and are drawn front faces only: nothing of the ground can be in
 * front of them, so they skip the depth test and rely on this order alone,
 * which keeps them from flickering against the land caps at any zoom.
 *
 * The night shade darkens the ground: it is drawn after the land caps and
 * before every marker. It writes no depth, so markers, arcs and rings drawn
 * after it are never dimmed by it and never z-fight with it, whatever their
 * altitude. three.js sorts by the nearest Group's renderOrder before an
 * object's own, so the land caps take theirs on their polygon Groups.
 */
export const GLOBE_RENDER_ORDER = {
  land: -3,
  nightShade: -2,
  /** City lights shine on top of the darkened ground, below every marker. */
  cityLights: -1.5,
  receptionGlow: -1,
  /** Aerial haze at the horizon: veils the ground, never the data drawn after it. */
  haze: -0.5,
  /** globe.gl's own arcs and rings, which keep its default order. */
  arcsAndRings: 0,
  gridOverlay: 3,
  /** Every point marker (see globeMarkerLayer): drawn last, without depth, hidden on the far side by the shader. */
  pointMarkers: 4,
} as const;

type GlobeMaterialLike = {
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
};

type GlobeSceneNode = {
  __globeObjType?: string;
  renderOrder: number;
  isMesh?: boolean;
  material?: GlobeMaterialLike | GlobeMaterialLike[];
  children?: GlobeSceneNode[];
};

/**
 * Depth bias of the land caps, in depth-buffer steps. The caps sit only
 * 0.0025 radii above the globe and their flat facets dip closer still; the
 * bias makes them win every depth comparison with the globe surface below,
 * at any zoom, instead of flickering where the two are too close to tell
 * apart.
 */
export const LAND_CAP_DEPTH_BIAS = { factor: -1, units: -4 } as const;

function biasLandCaps(group: GlobeSceneNode): void {
  for (const child of group.children ?? []) {
    if (!child.isMesh || !child.material) continue;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = LAND_CAP_DEPTH_BIAS.factor;
      material.polygonOffsetUnits = LAND_CAP_DEPTH_BIAS.units;
    }
  }
}

/**
 * Puts globe.gl's own ground layers in {@link GLOBE_RENDER_ORDER}, and biases
 * the land caps' depth above the globe surface. globe.gl offers neither as an
 * option, so its objects are adjusted in place (it keeps and recolours the
 * same materials). Returns whether any land cap was found.
 */
export function applyGlobeLayerOrder(scene: { traverse(callback: (node: GlobeSceneNode) => void): void }): boolean {
  let foundLand = false;
  scene.traverse((node) => {
    if (node.__globeObjType === 'polygon') {
      foundLand = true;
      node.renderOrder = GLOBE_RENDER_ORDER.land;
      biasLandCaps(node);
    } else if (node.__globeObjType === 'heatmap') {
      node.renderOrder = GLOBE_RENDER_ORDER.receptionGlow;
    }
  });
  return foundLand;
}

/** globe.gl's fixed near plane, kept as the floor when the camera is close. */
export const MIN_CAMERA_NEAR = 0.05;
/** Share of the camera's height above the surface used as the near plane. */
const CAMERA_NEAR_SHARE = 0.25;

/**
 * Near plane for a camera this high above the globe surface (globe units).
 *
 * Depth precision falls with the square of the distance and rises with the
 * near plane. globe.gl keeps the near plane at 0.05 so the camera can skim the
 * surface, which leaves too little precision once zoomed out: layers a
 * fraction of a unit apart flicker. Scaling the near plane with the height
 * keeps precision about the same at every zoom; nothing the globe draws comes
 * nearer the camera than a quarter of its height above the ground.
 */
export function getCameraNear(heightAboveSurface: number): number {
  if (!(heightAboveSurface > 0)) return MIN_CAMERA_NEAR;
  return Math.max(MIN_CAMERA_NEAR, heightAboveSurface * CAMERA_NEAR_SHARE);
}
