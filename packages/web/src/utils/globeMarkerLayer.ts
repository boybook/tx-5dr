import * as THREE from 'three';
import { GLOBE_RENDER_ORDER, toShaderColor, type GlobeShellMesh } from './globeShell';
import {
  GLOBE_MAP_FRAGMENT_PARS,
  GLOBE_MAP_NATIVE,
  GLOBE_MAP_VERTEX_PARS,
  createGlobeMapProjection,
  mapGlobePoint,
  type GlobeMapProjection,
} from './globeMapProjection';

/**
 * Every point marker of the logbook globe in one instanced draw call.
 *
 * Markers are flat, screen-facing glyphs of a fixed pixel size, drawn by a
 * shader from signed distance functions: they stay crisp and readable at any
 * zoom, cost the same whether there are ten or a thousand, and updating them
 * rewrites a few typed arrays instead of rebuilding meshes. Markers on the far
 * side of the globe fade out at the limb.
 *
 * Shapes carry one meaning each across the globe:
 * - `dot`: a station (heard now, or worked);
 * - `diamond`: a station calling CQ, which can be answered;
 * - `ring`: a station that heard us (PSK Reporter); its pings expand from it;
 * - `home`: this station.
 * Hollow glyphs mark an approximate position.
 *
 * Nothing appears or disappears abruptly: new markers fade and grow in,
 * removed ones fade and shrink out, opacity changes ease over, and a marker
 * can flash briefly (a fresh decode). All of it runs in the shader from a few
 * timestamps per instance, so animating costs no CPU work per frame.
 */

export type GlobeMarkerShape = 'dot' | 'diamond' | 'ring' | 'home';

const SHAPE_IDS: Record<GlobeMarkerShape, number> = { dot: 0, diamond: 1, ring: 2, home: 3 };

export interface GlobeMarker<T = unknown> {
  id: string;
  lat: number;
  lng: number;
  shape: GlobeMarkerShape;
  /** Glyph diameter in CSS pixels. */
  size: number;
  /** CSS colour. */
  color: string;
  opacity: number;
  hollow?: boolean;
  /** Higher draws on top and wins hover picking. */
  priority: number;
  /** `performance.now()` time of a strong arrival; the glyph overshoots, then settles. */
  popAt?: number;
  /** `performance.now()` time of a brief emphasis: a slight swell and a soft glow. */
  flashAt?: number;
  /** Text shown next to the glyph. */
  label?: string;
  data: T;
}

/** Altitude of the marker anchors; markers draw above everything regardless. */
const MARKER_ALTITUDE = 0.004;
/** Room around a glyph for its halo, flash glow and antialiasing, in pixels. */
const GLYPH_PADDING = 10;
/** Seconds a new marker takes to fade and grow in (glyph and label alike). */
const APPEAR_SECONDS = 0.35;
/** Seconds a removed marker takes to fade out; it is dropped after this. */
const VANISH_SECONDS = 0.6;
/** Seconds an opacity change eases over. */
const OPACITY_EASE_SECONDS = 0.6;
/**
 * Seconds the flash highlight takes to sweep across a glyph and its label.
 * The label's CSS animation (index.css, globe-label-sheen) uses the same length.
 */
export const SHEEN_SECONDS = 0.55;
/** Pointer distance beyond a glyph's edge that still picks it. */
const PICK_SLOP = 5;
const MAX_LABELS = 40;

const vertexShader = /* glsl */ `
${GLOBE_MAP_VERTEX_PARS}
attribute vec3 aCenter;
attribute vec4 aColor;
attribute vec4 aStyle;
/** appearAt, flashAt, vanishAt, opacityChangeAt (seconds; negative: none). */
attribute vec4 aTiming;
attribute float aPrevOpacity;
uniform vec2 uViewport;
uniform float uTime;
varying vec2 vOffset;
varying vec4 vColor;
varying vec3 vStyle;
varying float vFlash;
varying float vFlashAge;

float since(float at) {
  return at < 0.0 ? 1e6 : uTime - at;
}

float popScale(float popAt) {
  if (popAt < 0.0) return 1.0;
  float t = clamp((uTime - popAt) / 0.45, 0.0, 1.0);
  // Ease out back: grows past full size, then settles.
  float u = t - 1.0;
  return 1.0 + 2.70158 * u * u * u + 1.70158 * u * u;
}

void main() {
  // Facing reads the globe: unrolled, nothing is on the far side.
  vec4 mvSphere = modelViewMatrix * vec4(aCenter, 1.0);
  vec3 normalView = normalize(normalMatrix * normalize(aCenter));
  float facing = dot(normalView, normalize(-mvSphere.xyz));
  float visibility = mix(smoothstep(0.03, 0.2, facing), 1.0, globeMapMorph);
  vec4 mvCenter = viewMatrix * vec4(globeMapPosition((modelMatrix * vec4(aCenter, 1.0)).xyz), 1.0);

  float appear = clamp(since(aTiming.x) / ${APPEAR_SECONDS.toFixed(2)}, 0.0, 1.0);
  float appearEase = 1.0 - (1.0 - appear) * (1.0 - appear);
  float vanish = clamp(since(aTiming.z) / ${VANISH_SECONDS.toFixed(2)}, 0.0, 1.0);
  if (aTiming.z < 0.0) vanish = 0.0;
  float flashAge = since(aTiming.y);
  float flash = flashAge < 1.2 ? exp(-flashAge * 4.0) : 0.0;
  float opacityEase = smoothstep(0.0, 1.0, clamp(since(aTiming.w) / ${OPACITY_EASE_SECONDS.toFixed(2)}, 0.0, 1.0));
  float opacity = mix(aPrevOpacity, aColor.a, opacityEase);

  float scale = popScale(aStyle.w) * mix(0.6, 1.0, appearEase) * (1.0 - 0.3 * vanish) * (1.0 + 0.22 * flash);
  float size = aStyle.y * scale;
  float quad = size + ${GLYPH_PADDING * 2}.0;
  vec4 clip = projectionMatrix * mvCenter;
  clip.xy += position.xy * quad / uViewport * clip.w;
  float alpha = opacity * visibility * appear * (1.0 - vanish);
  gl_Position = alpha > 0.0 ? globeMapCull(clip) : vec4(2.0, 2.0, 2.0, 1.0);
  vOffset = position.xy * quad * 0.5;
  vColor = vec4(aColor.rgb, alpha);
  vStyle = vec3(aStyle.x, size, aStyle.z);
  vFlash = flash;
  vFlashAge = flashAge;
}
`;

const fragmentShader = /* glsl */ `
${GLOBE_MAP_FRAGMENT_PARS}
varying vec2 vOffset;
varying vec4 vColor;
varying vec3 vStyle;
varying float vFlash;
varying float vFlashAge;

const float STROKE = 1.6;
const float SHEEN_SECONDS = ${SHEEN_SECONDS.toFixed(2)};
const float HALO = 1.6;
const float GLOW = 7.0;

// Signed distance in pixels to the glyph outline: negative inside.
float shapeDistance(vec2 p, float shape, float radius) {
  if (shape < 0.5) return length(p) - radius;
  if (shape < 1.5) return (abs(p.x) + abs(p.y) - radius * 1.2) * 0.7071;
  return length(p) - radius;
}

void main() {
  if (globeMapClipped()) discard;
  float shape = vStyle.x;
  float radius = vStyle.y * 0.5;
  float hollow = vStyle.z;
  vec2 p = vOffset;
  float d = shapeDistance(p, shape, radius);

  float ink;
  if (shape > 2.5) {
    // Home: a ring around a centre dot.
    float ring = abs(length(p) - radius + STROKE) - STROKE * 0.75;
    float dot = length(p) - radius * 0.38;
    ink = min(ring, dot);
  } else if (shape > 1.5 || hollow > 0.5) {
    ink = abs(d + STROKE * 0.5) - STROKE * 0.5;
  } else {
    ink = d;
  }

  float aa = max(fwidth(ink), 0.75);
  float inkAlpha = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, ink);
  // A dark halo separates glyphs from the glow and texture beneath.
  float haloAlpha = (1.0 - smoothstep(-aa * 0.5, aa * 0.5, ink - HALO)) * 0.55 * (1.0 - vFlash);
  // A fresh decode briefly lights up: brighter ink and a soft glow around it.
  float glow = vFlash * 0.55 * (1.0 - smoothstep(0.0, GLOW, max(d, 0.0)));
  vec3 inkColor = mix(vColor.rgb, vec3(1.0), 0.4 * vFlash);
  // A narrow highlight sweeps once across the glyph, top left to bottom right.
  float sheenProgress = vFlashAge / SHEEN_SECONDS;
  if (sheenProgress < 1.0) {
    float along = dot(p / max(radius, 1.0), vec2(0.7071, -0.7071));
    float band = exp(-pow((along - mix(-1.7, 1.7, sheenProgress)) / 0.3, 2.0));
    float fade = smoothstep(0.0, 0.15, sheenProgress) * (1.0 - smoothstep(0.8, 1.0, sheenProgress));
    inkColor = mix(inkColor, vec3(1.0), 0.85 * band * fade);
  }
  vec3 color = inkColor * inkAlpha + vColor.rgb * glow * (1.0 - inkAlpha);
  float alpha = inkAlpha + (haloAlpha + glow) * (1.0 - inkAlpha);
  alpha = min(alpha, 1.0);
  if (alpha * vColor.a < 0.004) discard;
  gl_FragColor = vec4(color, alpha) * vColor.a;
}
`;

export interface GlobeMarkerLayer {
  readonly mesh: GlobeShellMesh;
  readonly altitude: number;
  /** Markers are placed in globe units; globe.gl reports its radius through this. */
  setGlobeRadius(radius: number): void;
  setVisible(visible: boolean): void;
  setMarkers(markers: readonly GlobeMarker[]): void;
  /** Marker under a canvas-relative point, or null. */
  pick(x: number, y: number): GlobeMarker | null;
  /** Element that receives one positioned child per labelled marker. */
  setLabelContainer(container: HTMLElement | null): void;
  dispose(): void;
}

type Vector3Like = { x: number; y: number; z: number };

function toGlobePosition(lat: number, lng: number, radius: number): Vector3Like {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  return {
    x: radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}

type ScreenPoint = { x: number; y: number; facing: number };
type LabelRecord = { element: HTMLDivElement; color: string; opacity: string; transform: string };

export function createGlobeMarkerLayer(projection: GlobeMapProjection = createGlobeMapProjection()): GlobeMarkerLayer {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const viewport = new THREE.Vector2(1, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uViewport: { value: viewport },
      uTime: { value: 0 },
      ...projection.uniforms,
    },
    transparent: true,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = GLOBE_RENDER_ORDER.pointMarkers;
  mesh.frustumCulled = false;
  mesh.name = 'globe-markers';
  mesh.userData[GLOBE_MAP_NATIVE] = true;
  // Picking is done in screen space by pick(); globe.gl must not hit the quads.
  mesh.raycast = () => {};

  let capacity = 0;
  let centers = new Float32Array(0);
  let colors = new Float32Array(0);
  let styles = new Float32Array(0);
  let timings = new Float32Array(0);
  let prevOpacities = new Float32Array(0);
  let markers: GlobeMarker[] = [];
  /** Per marker id: when it appeared and how its opacity last changed (seconds). */
  const states = new Map<string, { appearAt: number; opacity: number; prevOpacity: number; opacityChangeAt: number }>();
  /** Removed markers, kept while they fade out. */
  let ghosts: Array<{ marker: GlobeMarker; vanishAt: number }> = [];
  let primed = false;
  let globeRadius = 100;
  let lastCamera: { position: Vector3Like; matrixWorldInverse: unknown; projectionMatrix: unknown } | null = null;
  let visible = true;
  const color = new THREE.Color();
  const projected = new THREE.Vector3();
  const spherePoint = { x: 0, y: 0, z: 0 };

  let labelContainer: HTMLElement | null = null;
  /** Each label with the style values last written to it. */
  const labelElements = new Map<string, LabelRecord>();
  /** Markers that carry a label, in draw order. */
  let labelledMarkers: GlobeMarker[] = [];
  // Per-frame scratch, reused so placing labels allocates nothing.
  const seenLabels = new Set<string>();
  const sheenRestarts: Array<{ element: HTMLElement; delay: string }> = [];
  const labelPoint: ScreenPoint = { x: 0, y: 0, facing: 0 };
  const lastCameraMatrix = new Float64Array(16).fill(Number.NaN);
  const lastViewport = { x: 0, y: 0 };
  let lastMorph = Number.NaN;
  let lastShownHalfWidth = Number.NaN;
  let labelsDirty = true;
  /** Labels keep fading until then (seconds), so they update every frame. */
  let labelsAnimateUntil = 0;

  function removeAllLabels() {
    for (const label of labelElements.values()) label.element.remove();
    labelElements.clear();
  }

  function ensureCapacity(count: number) {
    if (count <= capacity) return;
    // three caches how many instances the attributes hold the first time it
    // draws them (_maxInstanceCount) and only forgets it when the geometry is
    // disposed; without this, a grown layer kept drawing its first 64
    // instances and the highest-priority markers, sorted last, vanished.
    // Disposing frees the old buffers; the geometry re-uploads on next draw.
    if (capacity > 0) geometry.dispose();
    capacity = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
    centers = new Float32Array(capacity * 3);
    colors = new Float32Array(capacity * 4);
    styles = new Float32Array(capacity * 4);
    timings = new Float32Array(capacity * 4);
    prevOpacities = new Float32Array(capacity);
    geometry.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 4));
    geometry.setAttribute('aStyle', new THREE.InstancedBufferAttribute(styles, 4));
    geometry.setAttribute('aTiming', new THREE.InstancedBufferAttribute(timings, 4));
    geometry.setAttribute('aPrevOpacity', new THREE.InstancedBufferAttribute(prevOpacities, 1));
  }

  /** Seconds on the shader clock for a `performance.now()` time, or -1 when absent or long past. */
  function toShaderTime(ms: number | undefined, nowSeconds: number, horizon: number): number {
    if (ms === undefined) return -1;
    const seconds = ms / 1000;
    return seconds > nowSeconds - horizon ? seconds : -1;
  }

  function writeInstances() {
    const nowSeconds = performance.now() / 1000;
    ghosts = ghosts.filter(ghost => nowSeconds - ghost.vanishAt < VANISH_SECONDS);
    const drawn = [
      ...markers.map(marker => ({ marker, vanishAt: -1 })),
      ...ghosts,
    ].sort((left, right) => left.marker.priority - right.marker.priority);
    ensureCapacity(drawn.length);
    const radius = globeRadius * (1 + MARKER_ALTITUDE);
    drawn.forEach(({ marker, vanishAt }, index) => {
      const state = states.get(marker.id);
      const position = toGlobePosition(marker.lat, marker.lng, radius);
      centers.set([position.x, position.y, position.z], index * 3);
      toShaderColor(marker.color, color);
      const opacity = Math.max(0, Math.min(1, marker.opacity));
      colors.set([color.r, color.g, color.b, opacity], index * 4);
      styles.set([
        SHAPE_IDS[marker.shape],
        marker.size,
        marker.hollow ? 1 : 0,
        toShaderTime(marker.popAt, nowSeconds, 1),
      ], index * 4);
      timings.set([
        state && nowSeconds - state.appearAt < 1 ? state.appearAt : -1,
        toShaderTime(marker.flashAt, nowSeconds, 1.5),
        vanishAt,
        state && nowSeconds - state.opacityChangeAt < 1 ? state.opacityChangeAt : -1,
      ], index * 4);
      prevOpacities[index] = state ? state.prevOpacity : opacity;
    });
    for (const name of ['aCenter', 'aColor', 'aStyle', 'aTiming', 'aPrevOpacity']) {
      const attribute = geometry.getAttribute(name);
      if (attribute) attribute.needsUpdate = true;
    }
    geometry.instanceCount = drawn.length;
    mesh.visible = drawn.length > 0 && visible;
  }

  /** Records appearances, opacity changes and removals before redrawing. */
  function trackChanges(next: readonly GlobeMarker[]) {
    const nowSeconds = performance.now() / 1000;
    const nextIds = new Set(next.map(marker => marker.id));
    for (const marker of markers) {
      if (!nextIds.has(marker.id)) {
        ghosts.push({ marker, vanishAt: nowSeconds });
        states.delete(marker.id);
      }
    }
    ghosts = ghosts.filter(ghost => !nextIds.has(ghost.marker.id));
    for (const marker of next) {
      const opacity = Math.max(0, Math.min(1, marker.opacity));
      const state = states.get(marker.id);
      if (!state) {
        // The first batch is drawn at once; later arrivals fade in.
        states.set(marker.id, { appearAt: primed ? nowSeconds : -Infinity, opacity, prevOpacity: opacity, opacityChangeAt: -Infinity });
      } else if (Math.abs(state.opacity - opacity) > 0.01) {
        const progress = Math.min(1, Math.max(0, (nowSeconds - state.opacityChangeAt) / OPACITY_EASE_SECONDS));
        state.prevOpacity = state.prevOpacity + (state.opacity - state.prevOpacity) * progress;
        state.opacity = opacity;
        state.opacityChangeAt = nowSeconds;
      }
    }
    if (next.length > 0) primed = true;
  }

  /** Screen position of a marker into `out`; false when it faces away. */
  function projectMarker(marker: GlobeMarker, width: number, height: number, out: ScreenPoint): boolean {
    if (!lastCamera) return false;
    const radius = globeRadius * (1 + MARKER_ALTITUDE);
    const phi = (90 - marker.lat) * Math.PI / 180;
    const theta = (90 - marker.lng) * Math.PI / 180;
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    const camera = lastCamera.position;
    const dx = camera.x - x;
    const dy = camera.y - y;
    const dz = camera.z - z;
    const length = Math.hypot(dx, dy, dz) || 1;
    const morph = projection.morph;
    let facing = (x * dx + y * dy + z * dz) / (radius * length);
    if (morph > 0) {
      // As the vertex shader does: unrolled, nothing is on the far side.
      const t = Math.min(1, Math.max(0, (facing - 0.03) / 0.17));
      const smooth = t * t * (3 - 2 * t);
      facing = 0.03 + 0.17 * (smooth + (1 - smooth) * morph);
    }
    if (facing <= 0.03) return false;
    spherePoint.x = x;
    spherePoint.y = y;
    spherePoint.z = z;
    if (!mapGlobePoint(spherePoint, camera, morph, projection.uniforms.globeMapRadius.value, projection.shownHalfWidth, projected)) return false;
    projected.project(lastCamera as never);
    out.x = (projected.x + 1) / 2 * width;
    out.y = (1 - projected.y) / 2 * height;
    out.facing = facing;
    return true;
  }

  function screenPosition(marker: GlobeMarker, width: number, height: number): ScreenPoint | null {
    const out = { x: 0, y: 0, facing: 0 };
    return projectMarker(marker, width, height, out) ? out : null;
  }

  /** Labels redrawn on the next frame even if the camera stands still. */
  function invalidateLabels() {
    labelsDirty = true;
  }

  /** Whether the camera moved since the labels were last placed. */
  function cameraMoved(): boolean {
    const elements = (lastCamera?.matrixWorldInverse as { elements?: ArrayLike<number> } | undefined)?.elements;
    if (!elements) return true;
    let moved = lastViewport.x !== viewport.x || lastViewport.y !== viewport.y
      || lastMorph !== projection.morph || lastShownHalfWidth !== projection.shownHalfWidth;
    lastMorph = projection.morph;
    lastShownHalfWidth = projection.shownHalfWidth;
    for (let index = 0; index < 16; index += 1) {
      if (lastCameraMatrix[index] !== elements[index]) {
        lastCameraMatrix[index] = elements[index];
        moved = true;
      }
    }
    lastViewport.x = viewport.x;
    lastViewport.y = viewport.y;
    return moved;
  }

  /**
   * Sweeps the label's highlight with its glyph's: restarted for each new
   * flash, and started part-way through when the label joins late. Returns
   * the sheen delay to start once layout is read, or null.
   */
  function prepareLabelSheen(element: HTMLElement, flashAt: number | undefined, nowSeconds: number): string | null {
    if (flashAt === undefined || element.dataset.flashAt === String(flashAt)) return null;
    element.dataset.flashAt = String(flashAt);
    const age = nowSeconds - flashAt / 1000;
    element.removeAttribute('data-sheen');
    if (age < 0 || age >= SHEEN_SECONDS) return null;
    return `${(-age).toFixed(3)}s`;
  }

  function placeLabel(marker: GlobeMarker, fade: number, nowSeconds: number) {
    if (!labelContainer || !marker.label || seenLabels.size >= MAX_LABELS || fade <= 0) return;
    if (!projectMarker(marker, viewport.x, viewport.y, labelPoint)) return;
    seenLabels.add(marker.id);
    let label = labelElements.get(marker.id);
    if (!label) {
      const element = document.createElement('div');
      element.className = 'globe-marker-label';
      labelContainer.appendChild(element);
      label = { element, color: '', opacity: '', transform: '' };
      labelElements.set(marker.id, label);
    }
    const { element } = label;
    if (element.textContent !== marker.label) {
      element.textContent = marker.label;
      element.dataset.text = marker.label;
    }
    const sheenDelay = prepareLabelSheen(element, marker.flashAt, nowSeconds);
    if (sheenDelay !== null) sheenRestarts.push({ element, delay: sheenDelay });
    // Only changed values are written: each style write invalidates layout.
    const opacity = (Math.min(1, (labelPoint.facing - 0.03) / 0.17) * marker.opacity * fade).toFixed(3);
    const transform = `translate(${Math.round(labelPoint.x + marker.size / 2 + 5)}px, ${Math.round(labelPoint.y)}px) translateY(-50%)`;
    if (label.color !== marker.color) element.style.color = label.color = marker.color;
    if (label.opacity !== opacity) element.style.opacity = label.opacity = opacity;
    if (label.transform !== transform) element.style.transform = label.transform = transform;
  }

  function updateLabels() {
    if (!labelContainer) return;
    const nowSeconds = performance.now() / 1000;
    // A still camera with nothing fading needs no work.
    const moved = cameraMoved();
    if (!moved && !labelsDirty && nowSeconds > labelsAnimateUntil) return;
    labelsDirty = false;
    seenLabels.clear();
    if (visible) {
      for (const marker of labelledMarkers) {
        const appearAt = states.get(marker.id)?.appearAt ?? -Infinity;
        placeLabel(marker, Math.min(1, Math.max(0, (nowSeconds - appearAt) / APPEAR_SECONDS)), nowSeconds);
      }
      for (const ghost of ghosts) {
        placeLabel(ghost.marker, Math.max(0, 1 - (nowSeconds - ghost.vanishAt) / VANISH_SECONDS), nowSeconds);
      }
    }
    if (sheenRestarts.length > 0) {
      // One layout read restarts every sheen of this frame together.
      void labelContainer.offsetWidth;
      for (const { element, delay } of sheenRestarts) {
        element.style.setProperty('--sheen-delay', delay);
        element.setAttribute('data-sheen', '');
      }
      sheenRestarts.length = 0;
    }
    for (const [id, label] of labelElements) {
      if (!seenLabels.has(id)) {
        label.element.remove();
        labelElements.delete(id);
      }
    }
  }

  mesh.onBeforeRender = (renderer: { getSize(target: unknown): unknown }, _scene: unknown, camera: typeof lastCamera) => {
    renderer.getSize(viewport);
    material.uniforms.uTime.value = performance.now() / 1000;
    lastCamera = camera;
    // Drop faded-out markers once they are gone from view.
    if (ghosts.some(ghost => material.uniforms.uTime.value - ghost.vanishAt >= VANISH_SECONDS)) {
      writeInstances();
      invalidateLabels();
    }
    updateLabels();
  };

  return {
    mesh: mesh as GlobeShellMesh,
    altitude: 0,
    setGlobeRadius(radius) {
      if (!(radius > 0) || Math.abs(radius - globeRadius) < 1e-6) return;
      globeRadius = radius;
      writeInstances();
    },
    setVisible(next) {
      visible = next;
      mesh.visible = (markers.length > 0 || ghosts.length > 0) && visible;
      invalidateLabels();
      if (!visible) updateLabels();
    },
    setMarkers(next) {
      trackChanges(next);
      markers = [...next].sort((left, right) => left.priority - right.priority);
      labelledMarkers = markers.filter(marker => marker.label);
      labelsAnimateUntil = performance.now() / 1000 + Math.max(APPEAR_SECONDS, VANISH_SECONDS);
      writeInstances();
      invalidateLabels();
      if (!visible || markers.length === 0) updateLabels();
    },
    pick(x, y) {
      if (!visible) return null;
      let best: GlobeMarker | null = null;
      let bestDistance = Infinity;
      for (const marker of markers) {
        if (marker.opacity <= 0.05) continue;
        const screen = screenPosition(marker, viewport.x, viewport.y);
        if (!screen) continue;
        const distance = Math.hypot(screen.x - x, screen.y - y) - marker.size / 2;
        if (distance > PICK_SLOP) continue;
        const better = !best
          || marker.priority > best.priority
          || (marker.priority === best.priority && distance < bestDistance);
        if (better) {
          best = marker;
          bestDistance = distance;
        }
      }
      return best;
    },
    setLabelContainer(container) {
      removeAllLabels();
      labelContainer = container;
      invalidateLabels();
    },
    dispose() {
      removeAllLabels();
      geometry.dispose();
      material.dispose();
    },
  };
}
