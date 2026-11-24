import * as THREE from 'three';

/**
 * Unrolls the globe into a flat map, and back, with the same scene.
 *
 * Every layer keeps its meshes and materials; only where a vertex lands on
 * screen changes. The vertex shader turns the vertex's place on the sphere
 * into longitude, latitude and height, lays that out on a plane (an
 * equirectangular map, so Maidenhead squares stay equal rectangles), and
 * blends sphere and plane by `globeMapMorph` (0 globe, 1 map). Shading keeps
 * reading the sphere (normals, sun direction, texture lookups), so the day and
 * night, the grid and the city lights stay right on the map unchanged.
 *
 * The map plane touches the globe where the camera looks: the point under the
 * camera stays put while unrolling, and on the map the camera direction is the
 * map centre. Panning the map is orbiting the camera, so globe.gl's controls,
 * point-of-view animations and the trackpad gestures work unchanged.
 *
 * The map is cut at a meridian. A triangle that straddles the cut would be
 * stretched across the whole map, and a vertex shader cannot see its
 * neighbours to split it. So each render pass shows only a band of longitude
 * around its own centre, far from its cut: vertices beyond the band (and a
 * margin wider than any triangle there) are thrown out of the view volume,
 * which drops every straddling triangle, and fragments beyond the band are
 * discarded for a clean edge. Near the poles a triangle can span more
 * longitude than the margin allows; there each fragment also checks that it
 * lies where its triangle really is. Zoomed in, one pass with its cut behind
 * the view suffices; zoomed out, two more passes draw the back of the world
 * at both sides, so the map wraps around without seams.
 */

/** The flat map ends at this latitude, like web maps; the polar fans of a UV sphere collapse there. */
export const FLAT_MAP_MAX_LATITUDE = 85;
/**
 * Heights shrink to this share on the flat map: raised layers (arcs) would
 * otherwise float with parallax under a perspective camera.
 */
export const FLAT_MAP_HEIGHT_SCALE = 0.05;
/** Longitude a single pass shows on each side of the map centre (radians). */
export const SINGLE_PASS_HALF_WIDTH = (140 * Math.PI) / 180;
/** Longitude each of the three passes shows on each side of its centre (radians). */
export const MULTI_PASS_HALF_WIDTH = Math.PI / 2;
/**
 * Ground size bound of the triangles of every layer (radians of arc): the
 * land caps, the coarsest, measure at most about 6 degrees across. A triangle
 * spans that much longitude divided by the cosine of its latitude.
 */
const MAX_TRIANGLE_ARC = (10 * Math.PI) / 180;
/** Least margin past a pass's band before vertices are dropped. */
const MIN_PASS_CULL_MARGIN = (12 * Math.PI) / 180;
/** Room kept between a band's margin and its cut, so triangles across the cut are still dropped. */
const CUT_CLEARANCE = (2 * Math.PI) / 180;
/**
 * Above this latitude a triangle across the cut can keep its vertices (the
 * margin there reaches the cut); its fragments are checked instead.
 */
const WRAP_CHECK_LATITUDE = (55 * Math.PI) / 180;
/** Fragments whose triangle lies elsewhere differ from it by more than this angle (cosine). */
const WRAP_CHECK_COS = 0.985;
/** Vertices this close to a pole have no longitude; their fans are dropped on the map. */
const POLE_DIRECTION_Y = 0.99999;
/**
 * Furthest the flat map zooms out: about one and a quarter worlds across,
 * and never past the map's top and bottom edges (the starry sky behind the
 * map would show there).
 */
const FLAT_MAP_MAX_HALF_WIDTH = 1.25 * Math.PI;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/**
 * How far past a pass's band (radians of longitude) a vertex at a latitude is
 * dropped: wider than any triangle there, so no triangle reaching into the
 * band loses a vertex, but short of the cut. Drawing less outside the band
 * keeps the zoomed-out map's side passes cheap.
 */
export function getPassCullMargin(latitude: number, bandHalfWidth: number): number {
  const margin = MAX_TRIANGLE_ARC / Math.max(Math.cos(latitude), 0.02);
  return Math.min(Math.max(margin, MIN_PASS_CULL_MARGIN), Math.PI - bandHalfWidth - CUT_CLEARANCE);
}

export interface GlobeMapUniforms {
  globeMapMorph: { value: number };
  globeMapPassCenter: { value: number };
  globeMapRegionHalf: { value: number };
  globeMapRadius: { value: number };
}

/**
 * The state every globe layer shares: how far the globe is unrolled, and
 * which render pass is being drawn. Layers bind the same uniform objects, so
 * one write reaches every material.
 */
export interface GlobeMapProjection {
  readonly uniforms: GlobeMapUniforms;
  /** 0 globe, 1 flat map. */
  readonly morph: number;
  setMorph(value: number): void;
  setRadius(radius: number): void;
  /**
   * Longitude shown either side of the map centre this frame (radians); what
   * lies beyond is clipped. Points are tested against it for picking.
   */
  readonly shownHalfWidth: number;
  /** Selects the pass to draw: its centre offset from the map centre, and its band. */
  setPass(center: number, halfWidth: number): void;
  /** Sets what one frame shows in all, after its passes are chosen. */
  setShownHalfWidth(halfWidth: number): void;
}

export function createGlobeMapProjection(): GlobeMapProjection {
  const uniforms: GlobeMapUniforms = {
    globeMapMorph: { value: 0 },
    globeMapPassCenter: { value: 0 },
    globeMapRegionHalf: { value: SINGLE_PASS_HALF_WIDTH },
    globeMapRadius: { value: 100 },
  };
  let shownHalfWidth = SINGLE_PASS_HALF_WIDTH;
  return {
    uniforms,
    get morph() {
      return uniforms.globeMapMorph.value;
    },
    setMorph(value) {
      uniforms.globeMapMorph.value = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    },
    setRadius(radius) {
      if (radius > 0) uniforms.globeMapRadius.value = radius;
    },
    get shownHalfWidth() {
      return shownHalfWidth;
    },
    setPass(center, halfWidth) {
      uniforms.globeMapPassCenter.value = center;
      uniforms.globeMapRegionHalf.value = halfWidth;
    },
    setShownHalfWidth(halfWidth) {
      shownHalfWidth = halfWidth;
    },
  };
}

const glslFloat = (value: number) => (Number.isInteger(value) ? `${value}.0` : String(value));

/**
 * Vertex shader declarations. `globeMapPosition(world)` maps a world-space
 * point; `globeMapCull(clip)` drops a vertex outside the pass, applied to the
 * final gl_Position; `globeMapClipPosition(local)` does both for a local
 * position.
 */
export const GLOBE_MAP_VERTEX_PARS = /* glsl */ `
uniform float globeMapMorph;
uniform float globeMapPassCenter;
uniform float globeMapRegionHalf;
uniform float globeMapRadius;
// x: longitude from the pass centre, y: latitude (radians); z: dropped.
varying vec3 vGlobeMap;
// The same longitude as a direction, which interpolates without wrapping.
varying vec2 vGlobeMapWrap;

const float GLOBE_MAP_PI = 3.141592653589793;
const float GLOBE_MAP_TAU = 6.283185307179586;

float globeMapWrap(float angle) {
  return angle - GLOBE_MAP_TAU * floor(angle / GLOBE_MAP_TAU + 0.5);
}

vec3 globeMapPosition(vec3 world) {
  vGlobeMap = vec3(0.0);
  vGlobeMapWrap = vec2(0.0, 1.0);
  if (globeMapMorph <= 0.0) return world;
  float r = length(world);
  vec3 dir = world / max(r, 1e-6);
  vec3 eye = normalize(cameraPosition);
  float eyeLng = atan(eye.x, eye.z);
  float eyeLat = asin(clamp(eye.y, -1.0, 1.0));
  vec3 east = vec3(cos(eyeLng), 0.0, -sin(eyeLng));
  vec3 north = cross(eye, east);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  float offset = globeMapWrap(atan(dir.x, dir.z) - eyeLng - globeMapPassCenter);
  float x = globeMapPassCenter + offset;
  vec3 flatPosition = eye * (globeMapRadius + (r - globeMapRadius) * ${glslFloat(FLAT_MAP_HEIGHT_SCALE)})
    + east * (globeMapRadius * x)
    + north * (globeMapRadius * (lat - eyeLat));
  float margin = clamp(
    ${glslFloat(MAX_TRIANGLE_ARC)} / max(cos(lat), 0.02),
    ${glslFloat(MIN_PASS_CULL_MARGIN)},
    GLOBE_MAP_PI - globeMapRegionHalf - ${glslFloat(CUT_CLEARANCE)}
  );
  bool dropped = abs(offset) > globeMapRegionHalf + margin || abs(dir.y) > ${glslFloat(POLE_DIRECTION_Y)};
  vGlobeMap = vec3(offset, lat, dropped ? 1.0 : 0.0);
  vGlobeMapWrap = vec2(sin(offset), cos(offset));
  return mix(world, flatPosition, globeMapMorph);
}

vec4 globeMapCull(vec4 clip) {
  // Far beyond the far plane: clipping leaves no visible part of a triangle
  // that reaches this vertex.
  return vGlobeMap.z > 0.5 ? vec4(0.0, 0.0, 1e6, 1.0) : clip;
}

vec4 globeMapClipPosition(vec3 local) {
  vec3 mapped = globeMapPosition((modelMatrix * vec4(local, 1.0)).xyz);
  return globeMapCull(projectionMatrix * viewMatrix * vec4(mapped, 1.0));
}
`;

/** Fragment shader declarations: `globeMapClipped()` is true outside the pass band and the map. */
export const GLOBE_MAP_FRAGMENT_PARS = /* glsl */ `
uniform float globeMapMorph;
uniform float globeMapRegionHalf;
varying vec3 vGlobeMap;
varying vec2 vGlobeMapWrap;

bool globeMapClipped() {
  if (globeMapMorph <= 0.0) return false;
  // Half-open, so neighbouring passes never both draw their shared edge.
  if (vGlobeMap.x < -globeMapRegionHalf || vGlobeMap.x >= globeMapRegionHalf) return true;
  float latitude = abs(vGlobeMap.y);
  if (globeMapMorph > 0.5 && latitude > ${glslFloat(FLAT_MAP_MAX_LATITUDE * DEG)}) return true;
  // A triangle stretched across the cut: its longitude, interpolated as a
  // direction, points elsewhere than where the fragment was drawn.
  return latitude > ${glslFloat(WRAP_CHECK_LATITUDE)}
    && dot(normalize(vGlobeMapWrap), vec2(sin(vGlobeMap.x), cos(vGlobeMap.x))) < ${glslFloat(WRAP_CHECK_COS)};
}
`;

/** three's project_vertex chunk with the world position mapped. */
const PROJECT_VERTEX = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = viewMatrix * vec4( globeMapPosition( ( modelMatrix * mvPosition ).xyz ), 1.0 );
gl_Position = projectionMatrix * mvPosition;
`;

/**
 * Lit materials on the flat map: sphere normals would leave a fixed bright
 * patch where the globe faces the light, so the map takes an even share of
 * the scene's light instead. Once flat, the per-pixel lighting and bump
 * mapping it replaces are skipped (see LIT_SECTION).
 */
const FLAT_LIGHT = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
  vec3 globeMapIrradiance = ambientLightColor + directionalLights[ 0 ].color * 0.6;
#else
  vec3 globeMapIrradiance = ambientLightColor;
#endif
outgoingLight = mix( outgoingLight, BRDF_Lambert( diffuseColor.rgb ) * globeMapIrradiance + totalEmissiveRadiance, globeMapMorph );
`;

/** The lighting of three's lit materials, from the material's own lights chunk to the end. */
const LIT_SECTION = /#include <lights_(?:phong|lambert|toon|physical)_fragment>[\s\S]*?#include <lights_fragment_end>/;

const DIRECT_PROJECTION = /projectionMatrix\s*\*\s*modelViewMatrix\s*\*\s*vec4\(\s*([A-Za-z_][\w.]*)\s*,\s*1\.0\s*\)/g;
const MAIN_START = /void\s+main\s*\(\s*\)\s*\{/;
const MAIN_END = /\}\s*$/;

export interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
}

/**
 * How a material takes the map: `map` unrolls with it; `fade` (globe.gl's
 * atmosphere glow) fades out, having no place on a map; `hide` (a shader of
 * unknown shape) is hidden while the globe is unrolled.
 */
export type GlobeMapMaterialKind = 'map' | 'fade' | 'hide';

type MaterialLike = {
  isShaderMaterial?: boolean;
  isSpriteMaterial?: boolean;
  vertexShader?: string;
  uniforms?: Record<string, unknown>;
};

export function classifyGlobeMapMaterial(material: MaterialLike): GlobeMapMaterialKind {
  // Sprites face the camera from their own vertex shader.
  if (material.isSpriteMaterial) return 'hide';
  if (!material.isShaderMaterial) return 'map';
  const uniforms = material.uniforms ?? {};
  if ('coefficient' in uniforms && 'power' in uniforms && 'hollowRadius' in uniforms) return 'fade';
  DIRECT_PROJECTION.lastIndex = 0;
  return material.vertexShader && DIRECT_PROJECTION.test(material.vertexShader) ? 'map' : 'hide';
}

/** Rewrites a material's shaders to unroll with the map; false when their shape is unknown. */
export function patchShaderForGlobeMap(shader: ShaderSource, uniforms: GlobeMapUniforms): boolean {
  let vertex = shader.vertexShader;
  const usesProjectChunk = vertex.includes('#include <project_vertex>');
  if (usesProjectChunk) vertex = vertex.replace('#include <project_vertex>', PROJECT_VERTEX);
  let direct = false;
  vertex = vertex.replace(DIRECT_PROJECTION, (_match, local: string) => {
    direct = true;
    return `projectionMatrix * viewMatrix * vec4(globeMapPosition((modelMatrix * vec4(${local}, 1.0)).xyz), 1.0)`;
  });
  if ((!usesProjectChunk && !direct) || !MAIN_END.test(vertex) || !MAIN_START.test(shader.fragmentShader)) {
    return false;
  }
  vertex = vertex.replace(MAIN_END, '  gl_Position = globeMapCull(gl_Position);\n}\n');

  let fragment = shader.fragmentShader.replace(MAIN_START, match => `${match}\n  if (globeMapClipped()) discard;`);
  if (fragment.includes('#include <lights_fragment_begin>') && fragment.includes('#include <opaque_fragment>')) {
    fragment = fragment.replace('#include <opaque_fragment>', `${FLAT_LIGHT}\n#include <opaque_fragment>`);
    // A uniform branch: the whole map skips it at once.
    fragment = fragment
      .replace('#include <normal_fragment_maps>', 'if (globeMapMorph < 1.0) {\n#include <normal_fragment_maps>\n}')
      .replace(LIT_SECTION, section => `if (globeMapMorph < 1.0) {\n${section}\n}`);
  }

  shader.vertexShader = `${GLOBE_MAP_VERTEX_PARS}\n${vertex}`;
  shader.fragmentShader = `${GLOBE_MAP_FRAGMENT_PARS}\n${fragment}`;
  Object.assign(shader.uniforms, uniforms);
  return true;
}

/** Fades globe.gl's atmosphere glow out early in the unrolling. */
export function patchShaderForGlobeMapFade(shader: ShaderSource, uniforms: GlobeMapUniforms): boolean {
  if (!MAIN_END.test(shader.fragmentShader)) return false;
  shader.fragmentShader = `uniform float globeMapMorph;\n${shader.fragmentShader.replace(
    MAIN_END,
    '  gl_FragColor.a *= clamp(1.0 - globeMapMorph * 3.0, 0.0, 1.0);\n}\n',
  )}`;
  shader.uniforms.globeMapMorph = uniforms.globeMapMorph;
  return true;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Where a world-space point is drawn, into `out` (the vertex shader's
 * mapping, for the map centre's own pass). Returns false when the point is
 * clipped: beyond `shownHalfWidth` of the map centre, or past the map's edge.
 */
export function mapGlobePoint(
  world: Vec3Like,
  eyePosition: Vec3Like,
  morph: number,
  radius: number,
  shownHalfWidth: number,
  out: Vec3Like,
): boolean {
  if (!(morph > 0)) {
    out.x = world.x;
    out.y = world.y;
    out.z = world.z;
    return true;
  }
  const r = Math.hypot(world.x, world.y, world.z) || 1e-6;
  const dirY = world.y / r;
  const eyeLength = Math.hypot(eyePosition.x, eyePosition.y, eyePosition.z) || 1e-6;
  const ex = eyePosition.x / eyeLength;
  const ey = eyePosition.y / eyeLength;
  const ez = eyePosition.z / eyeLength;
  const eyeLng = Math.atan2(ex, ez);
  const eyeLat = Math.asin(Math.max(-1, Math.min(1, ey)));
  const lat = Math.asin(Math.max(-1, Math.min(1, dirY)));
  const offset = wrapAngle(Math.atan2(world.x / r, world.z / r) - eyeLng);
  // east = (cos, 0, -sin) of the eye longitude; north = eye x east.
  const eastX = Math.cos(eyeLng);
  const eastZ = -Math.sin(eyeLng);
  const northX = ey * eastZ;
  const northY = ez * eastX - ex * eastZ;
  const northZ = -ey * eastX;
  const lift = radius + (r - radius) * FLAT_MAP_HEIGHT_SCALE;
  const across = radius * offset;
  const up = radius * (lat - eyeLat);
  const flatX = ex * lift + eastX * across + northX * up;
  const flatY = ey * lift + northY * up;
  const flatZ = ez * lift + eastZ * across + northZ * up;
  out.x = world.x + (flatX - world.x) * morph;
  out.y = world.y + (flatY - world.y) * morph;
  out.z = world.z + (flatZ - world.z) * morph;
  if (Math.abs(offset) > shownHalfWidth || Math.abs(dirY) > POLE_DIRECTION_Y) return false;
  return !(morph > 0.5 && Math.abs(lat) > FLAT_MAP_MAX_LATITUDE * DEG);
}

/** An angle in [-PI, PI). */
export function wrapAngle(angle: number): number {
  return angle - TAU * Math.floor(angle / TAU + 0.5);
}

/**
 * Where a ray meets the flat map, in latitude and longitude; null when it
 * misses the map. The map lies across the camera's line of sight at the globe
 * radius, so the eye position is the ray's origin.
 */
export function intersectFlatMap(origin: Vec3Like, direction: Vec3Like, radius: number): { lat: number; lng: number } | null {
  const eyeLength = Math.hypot(origin.x, origin.y, origin.z);
  if (!(eyeLength > radius) || !(radius > 0)) return null;
  const ex = origin.x / eyeLength;
  const ey = origin.y / eyeLength;
  const ez = origin.z / eyeLength;
  const along = direction.x * ex + direction.y * ey + direction.z * ez;
  if (!(along < 0)) return null;
  const t = (radius - eyeLength) / along;
  const px = origin.x + direction.x * t - ex * radius;
  const py = origin.y + direction.y * t - ey * radius;
  const pz = origin.z + direction.z * t - ez * radius;
  const eyeLng = Math.atan2(ex, ez);
  const eyeLat = Math.asin(Math.max(-1, Math.min(1, ey)));
  const eastX = Math.cos(eyeLng);
  const eastZ = -Math.sin(eyeLng);
  const northX = ey * eastZ;
  const northY = ez * eastX - ex * eastZ;
  const northZ = -ey * eastX;
  const lat = eyeLat + (px * northX + py * northY + pz * northZ) / radius;
  if (Math.abs(lat) > FLAT_MAP_MAX_LATITUDE * DEG) return null;
  const lng = wrapAngle(eyeLng + (px * eastX + pz * eastZ) / radius);
  return { lat: lat / DEG, lng: lng / DEG };
}

export interface FlatMapViewLimits {
  /** Longitude visible either side of the centre (radians). */
  halfWidth: number;
  /** Highest camera altitude (globe radii) that still fills the view with map. */
  maxAltitude: number;
  /** Highest map-centre latitude (degrees) that keeps the map's edge out of view. */
  maxCenterLatitude: number;
}

/** What a perspective camera this high above the flat map sees, and how far it may go. */
export function getFlatMapViewLimits(altitude: number, fovDegrees: number, aspect: number): FlatMapViewLimits {
  const tanHalf = Math.tan(((fovDegrees > 0 ? fovDegrees : 50) * DEG) / 2);
  const safeAspect = aspect > 0 ? aspect : 1;
  const safeAltitude = Math.max(0, altitude);
  return {
    halfWidth: safeAltitude * tanHalf * safeAspect,
    maxAltitude: Math.min(FLAT_MAP_MAX_HALF_WIDTH / (tanHalf * safeAspect), (FLAT_MAP_MAX_LATITUDE * DEG) / tanHalf),
    maxCenterLatitude: Math.max(0, FLAT_MAP_MAX_LATITUDE - (safeAltitude * tanHalf) / DEG),
  };
}

/** Whether a frame needs the two side passes: the map is flat and its edge comes into view. */
export function needsSidePasses(morph: number, halfWidth: number): boolean {
  return morph >= 1 && halfWidth > SINGLE_PASS_HALF_WIDTH - 5 * DEG;
}

type SceneNode = {
  isMesh?: boolean;
  isLine?: boolean;
  isPoints?: boolean;
  visible: boolean;
  frustumCulled: boolean;
  userData: Record<string, unknown>;
  material?: PatchableMaterial | PatchableMaterial[];
};

type PatchableMaterial = MaterialLike & {
  onBeforeCompile: (shader: ShaderSource, renderer: unknown) => void;
  customProgramCacheKey: () => string;
  needsUpdate: boolean;
};

/**
 * `userData` flags of the globe's own layers, which build the mapping into
 * their shaders and must not be patched again.
 */
export const GLOBE_MAP_NATIVE = 'globeMapNative';
/** `userData` flag of a layer hidden on the finished flat map (the horizon haze). */
export const GLOBE_MAP_HIDDEN_FLAT = 'globeMapHiddenFlat';

/**
 * Keeps globe.gl's objects unrolling with the map. globe.gl builds and
 * rebuilds its meshes (and clones arc materials) at any time, so `sync` runs
 * every frame before drawing: it patches materials it has not seen, before
 * their first compile, and switches frustum culling off while unrolled (the
 * bounding spheres describe the globe, not the map).
 */
export function createGlobeMapSceneSync(projection: GlobeMapProjection) {
  const kinds = new WeakMap<object, GlobeMapMaterialKind>();
  const culledBefore = new WeakSet<object>();
  const hiddenNodes = new WeakSet<SceneNode>();

  const patch = (material: PatchableMaterial): GlobeMapMaterialKind => {
    let kind = kinds.get(material);
    if (kind) return kind;
    kind = classifyGlobeMapMaterial(material);
    kinds.set(material, kind);
    if (kind === 'hide') return kind;
    const previous = material.onBeforeCompile;
    const baseKey = material.customProgramCacheKey();
    const patcher = kind === 'map' ? patchShaderForGlobeMap : patchShaderForGlobeMapFade;
    material.onBeforeCompile = (shader, renderer) => {
      previous?.call(material, shader, renderer);
      patcher(shader, projection.uniforms);
    };
    material.customProgramCacheKey = () => `globe-map-${kind}|${baseKey}`;
    material.needsUpdate = true;
    return kind;
  };

  const setHidden = (node: SceneNode, hidden: boolean) => {
    if (hidden) {
      if (node.visible) {
        node.visible = false;
        hiddenNodes.add(node);
      }
    } else if (hiddenNodes.delete(node)) {
      node.visible = true;
    }
  };

  const visit = (node: SceneNode) => {
    const morph = projection.morph;
    if (node.userData?.[GLOBE_MAP_NATIVE]) {
      if (node.userData[GLOBE_MAP_HIDDEN_FLAT]) setHidden(node, morph >= 1);
      return;
    }
    if (!node.material || !(node.isMesh || node.isLine || node.isPoints)) return;
    let hideWhenMorphed = false;
    let hideWhenFlat = false;
    if (Array.isArray(node.material)) {
      for (const material of node.material) {
        const kind = patch(material);
        hideWhenMorphed ||= kind === 'hide';
        hideWhenFlat ||= kind === 'fade';
      }
    } else {
      const kind = patch(node.material);
      hideWhenMorphed = kind === 'hide';
      hideWhenFlat = kind === 'fade';
    }
    setHidden(node, (hideWhenMorphed && morph > 0) || (hideWhenFlat && morph >= 1));
    if (morph > 0) {
      if (node.frustumCulled) {
        culledBefore.add(node);
        node.frustumCulled = false;
      }
    } else if (culledBefore.has(node)) {
      culledBefore.delete(node);
      node.frustumCulled = true;
    }
  };

  return {
    sync(root: { traverse(callback: (node: SceneNode) => void): void }) {
      root.traverse(visit);
    },
  };
}

type RenderPassLike = {
  render: (renderer: RendererLike, writeBuffer: unknown, readBuffer: unknown, deltaTime: number, maskActive: boolean) => void;
};

type RendererLike = {
  autoClear: boolean;
  render(scene: unknown, camera: unknown): void;
};

type SceneLike = {
  background: unknown;
  children: Array<{ isMesh?: boolean; visible: boolean; material?: { side?: number } }>;
};

/**
 * Draws each frame in the passes the flat map needs. globe.gl renders through
 * an EffectComposer whose first pass draws the scene; that pass is wrapped so
 * `beforeFrame` runs once per frame, and the two side passes (when zoomed out
 * on the map) draw into the same target without clearing. The starry
 * background is drawn once, by the first pass. Returns the uninstaller.
 */
export function installGlobeMapPasses(options: {
  composer: { passes: RenderPassLike[] };
  scene: SceneLike;
  camera: unknown;
  projection: GlobeMapProjection;
  /** Runs before each frame is drawn; returns whether the side passes are needed. */
  beforeFrame: () => boolean;
}): () => void {
  const pass = options.composer.passes[0];
  if (!pass) return () => {};
  const { scene, camera, projection, beforeFrame } = options;
  const original = pass.render;
  pass.render = function renderGlobeMapPasses(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const sides = beforeFrame();
    const halfWidth = sides ? MULTI_PASS_HALF_WIDTH : SINGLE_PASS_HALF_WIDTH;
    projection.setShownHalfWidth(sides ? Math.PI : SINGLE_PASS_HALF_WIDTH);
    projection.setPass(0, halfWidth);
    // The finished map fills the view (its limits keep its edges out), so the
    // starry sky behind it would only cost a screenful of texture reads.
    const flat = projection.morph >= 1;
    if (!flat && !sides) {
      original.call(this, renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    const sky = scene.children.filter(child => child.isMesh && child.visible && child.material?.side === THREE.BackSide);
    sky.forEach(child => { child.visible = false; });
    try {
      original.call(this, renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      if (!sides) return;
      const background = scene.background;
      const autoClear = renderer.autoClear;
      scene.background = null;
      renderer.autoClear = false;
      try {
        for (const center of [Math.PI, -Math.PI]) {
          projection.setPass(center, halfWidth);
          renderer.render(scene, camera);
        }
      } finally {
        renderer.autoClear = autoClear;
        scene.background = background;
        projection.setPass(0, halfWidth);
      }
    } finally {
      sky.forEach(child => { child.visible = true; });
    }
  };
  return () => {
    pass.render = original;
  };
}
