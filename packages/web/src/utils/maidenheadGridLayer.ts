import * as THREE from 'three';
import type { LogBookWorkedGridItem } from '@tx5dr/contracts';
import { GLOBE_RENDER_ORDER, toShaderColor, type GlobeShellMesh } from './globeShell';
import {
  GLOBE_MAP_FRAGMENT_PARS,
  GLOBE_MAP_NATIVE,
  GLOBE_MAP_VERTEX_PARS,
  createGlobeMapProjection,
  type GlobeMapProjection,
} from './globeMapProjection';

/**
 * Maidenhead grid overlay drawn entirely on the GPU.
 *
 * One transparent sphere shell carries the whole overlay: the fragment shader
 * derives each pixel's latitude and longitude, draws the field (2-character)
 * and square (4-character) grid lines, fills worked and confirmed cells from a
 * status texture and writes the grid labels from a glyph atlas. Panning and
 * zooming therefore cost no CPU work and no mesh rebuilds; the CPU only
 * rewrites the status texture when the worked grid data changes.
 */

/** Square columns: 18 fields of 10 squares, 2 degrees of longitude each. */
export const GRID_SQUARE_COLUMNS = 180;
/** Square rows: 18 fields of 10 squares, 1 degree of latitude each. */
export const GRID_SQUARE_ROWS = 180;
export const GRID_FIELD_COLUMNS = 18;
export const GRID_FIELD_ROWS = 18;

/** Camera altitude at which the overlay is half way between fields and squares. */
export const GRID_SQUARE_SWITCH_ALTITUDE = 0.62;
const GRID_SQUARE_SWITCH_SPAN = 0.1;
/** Above the land caps and the reception glow, below points, arcs and rings. */
export const GRID_SHELL_ALTITUDE = 0.0065;
export const GRID_SHELL_SEGMENTS = { width: 192, height: 96 } as const;

/** 'A'..'R' then '0'..'9'. */
const GLYPHS = 'ABCDEFGHIJKLMNOPQR0123456789';
const GLYPH_WIDTH = 32;
const GLYPH_HEIGHT = 56;

export interface GridCellStatus {
  count: number;
  confirmedCount: number;
}

export interface GridStatusData {
  /** RGBA per square: R worked, G confirmed, B count intensity. */
  squares: Uint8Array;
  /** RGBA per field, aggregated from its squares. */
  fields: Uint8Array;
  /** Status of each worked 4-character grid, for hover lookups. */
  byGrid: Map<string, GridCellStatus>;
}

function squareIndexOf(grid: string): { column: number; row: number } | null {
  const normalized = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}/.test(normalized)) return null;
  const fieldColumn = normalized.charCodeAt(0) - 65;
  const fieldRow = normalized.charCodeAt(1) - 65;
  return {
    column: fieldColumn * 10 + Number(normalized[2]),
    row: fieldRow * 10 + Number(normalized[3]),
  };
}

/** Brighter fill for squares with more QSOs, on a gentle log scale. */
function countIntensity(count: number): number {
  return Math.min(255, Math.round(96 + Math.log2(Math.max(1, count)) * 32));
}

export function buildGridStatusData(items: readonly LogBookWorkedGridItem[]): GridStatusData {
  const squares = new Uint8Array(GRID_SQUARE_COLUMNS * GRID_SQUARE_ROWS * 4);
  const fields = new Uint8Array(GRID_FIELD_COLUMNS * GRID_FIELD_ROWS * 4);
  const fieldCounts = new Map<number, GridCellStatus>();
  const byGrid = new Map<string, GridCellStatus>();

  for (const item of items) {
    const index = squareIndexOf(item.grid);
    if (!index || item.count <= 0) continue;
    const confirmedCount = Math.min(item.count, item.confirmedCount ?? 0);
    const grid = item.grid.slice(0, 4).toUpperCase();
    byGrid.set(grid, { count: item.count, confirmedCount });

    const offset = (index.row * GRID_SQUARE_COLUMNS + index.column) * 4;
    squares[offset] = 255;
    squares[offset + 1] = confirmedCount > 0 ? 255 : 0;
    squares[offset + 2] = countIntensity(item.count);
    squares[offset + 3] = 255;

    const fieldIndex = Math.floor(index.row / 10) * GRID_FIELD_COLUMNS + Math.floor(index.column / 10);
    const field = fieldCounts.get(fieldIndex) ?? { count: 0, confirmedCount: 0 };
    field.count += item.count;
    field.confirmedCount += confirmedCount;
    fieldCounts.set(fieldIndex, field);
  }

  for (const [fieldIndex, field] of fieldCounts) {
    const offset = fieldIndex * 4;
    fields[offset] = 255;
    fields[offset + 1] = field.confirmedCount > 0 ? 255 : 0;
    fields[offset + 2] = countIntensity(field.count);
    fields[offset + 3] = 255;
  }

  return { squares, fields, byGrid };
}

/** The 4-character grid square containing a point. */
export function gridSquareAt(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const wrappedLng = ((((lng + 180) % 360) + 360) % 360);
  const clampedLat = Math.min(179.999999, Math.max(0, lat + 90));
  const column = Math.min(GRID_SQUARE_COLUMNS - 1, Math.floor(wrappedLng / 2));
  const row = Math.min(GRID_SQUARE_ROWS - 1, Math.floor(clampedLat));
  return String.fromCharCode(65 + Math.floor(column / 10))
    + String.fromCharCode(65 + Math.floor(row / 10))
    + String(column % 10)
    + String(row % 10);
}

/** 0 shows fields only, 1 shows squares only; blended around the switch altitude. */
export function getGridSquareBlend(cameraAltitude: number): number {
  const low = GRID_SQUARE_SWITCH_ALTITUDE - GRID_SQUARE_SWITCH_SPAN;
  const high = GRID_SQUARE_SWITCH_ALTITUDE + GRID_SQUARE_SWITCH_SPAN;
  const t = Math.min(1, Math.max(0, (cameraAltitude - low) / (high - low)));
  return 1 - t * t * (3 - 2 * t);
}

// The shell keeps shading the sphere; only its place on screen unrolls.
const vertexShader = /* glsl */ `
${GLOBE_MAP_VERTEX_PARS}
varying vec3 vPosition;
void main() {
  vPosition = position;
  gl_Position = globeMapClipPosition(position);
}
`;

const fragmentShader = /* glsl */ `
${GLOBE_MAP_FRAGMENT_PARS}
uniform sampler2D uSquares;
uniform sampler2D uFields;
uniform sampler2D uGlyphs;
uniform float uHasGlyphs;
uniform float uSquareBlend;
/** Rendered pixels per natural pixel (below 1 while resolution is lowered). */
uniform float uPixelScale;
uniform vec3 uLineColor;
uniform vec3 uWorkedColor;
uniform vec3 uConfirmedColor;
uniform vec3 uLabelColor;
varying vec3 vPosition;

const float GLYPH_COUNT = ${GLYPHS.length}.0;
const float GLYPH_ASPECT = ${(GLYPH_WIDTH / GLYPH_HEIGHT).toFixed(4)};

// Premultiplied "over": layer a on top of b.
vec4 over(vec4 a, vec4 b) {
  return a + b * (1.0 - a.a);
}

float glyphAt(float slot, vec2 cell, float squares) {
  if (squares < 0.5) {
    return slot < 0.5 ? cell.x : cell.y;
  }
  if (slot < 0.5) return floor(cell.x / 10.0);
  if (slot < 1.5) return floor(cell.y / 10.0);
  if (slot < 2.5) return 18.0 + mod(cell.x, 10.0);
  return 18.0 + mod(cell.y, 10.0);
}

// lngLat: degrees shifted to [0, 360) x [0, 180).
vec4 drawLevel(
  vec2 lngLat, vec2 cellSize, vec2 cells, sampler2D status, float squares,
  float baseLineAlpha, float fillAlpha, float labelHeight, float charCount
) {
  vec2 g = lngLat / cellSize;
  // Sizes are in natural pixels, so lines and labels look the same when the
  // rendering resolution is lowered.
  vec2 w = max(fwidth(g) * uPixelScale, vec2(1e-6));
  vec2 cell = clamp(floor(g), vec2(0.0), cells - 1.0);
  vec4 s = texture2D(status, (cell + 0.5) / cells);
  float worked = step(0.5, s.r);
  float confirmed = step(0.5, s.g);
  vec3 cellColor = mix(uWorkedColor, uConfirmedColor, confirmed);

  // Grid lines: about one pixel wide, faded out where cells get too small to read.
  vec2 edge = abs(fract(g - 0.5) - 0.5) / w;
  vec2 lineAxis = 1.0 - smoothstep(0.35, 1.25, edge);
  vec2 axisFade = smoothstep(vec2(3.0), vec2(10.0), 1.0 / w);
  float line = max(lineAxis.x * axisFade.x, lineAxis.y * axisFade.y);
  float lineAlpha = line * mix(baseLineAlpha, 0.34, worked);
  vec3 lineColor = mix(uLineColor, cellColor, worked);

  float fill = worked * fillAlpha * mix(0.75, 1.15, s.b) * mix(1.0, 1.2, confirmed);
  vec4 color = vec4(cellColor * fill, fill);
  color = over(vec4(lineColor * lineAlpha, lineAlpha), color);

  if (uHasGlyphs > 0.5) {
    vec2 center = (cell + 0.5) * cellSize;
    // Labels keep their shape: narrowed with the meridians on the globe, not on the map.
    float cosLat = mix(max(cos(radians(center.y - 90.0)), 0.05), 1.0, globeMapMorph);
    float degreesPerPixel = w.y * cellSize.y;
    // Fit the label in its cell, and keep it at a readable size on screen.
    float height = min(labelHeight, 0.78 * cellSize.x * cosLat / (charCount * GLYPH_ASPECT));
    height = min(height, 22.0 * degreesPerPixel);
    float glyphPixels = height / degreesPerPixel;
    float glyphWidth = height * GLYPH_ASPECT;
    vec2 q = vec2((lngLat.x - center.x) * cosLat, lngLat.y - center.y);
    float tx = (q.x + glyphWidth * charCount * 0.5) / glyphWidth;
    float ty = (q.y + height * 0.5) / height;
    float inside = step(0.0, tx) * step(tx, charCount) * step(0.0, ty) * step(ty, 1.0);
    float slot = clamp(floor(tx), 0.0, charCount - 1.0);
    float glyph = glyphAt(slot, cell, squares);
    vec2 uv = vec2((glyph + fract(tx)) / GLYPH_COUNT, ty);
    float ink = textureGrad(
      uGlyphs, uv,
      vec2(dFdx(tx) / GLYPH_COUNT, dFdx(ty)),
      vec2(dFdy(tx) / GLYPH_COUNT, dFdy(ty))
    ).a;
    float labelAlpha = ink * inside * smoothstep(7.0, 11.0, glyphPixels) * mix(0.3, 0.9, worked);
    color = over(vec4(uLabelColor * labelAlpha, labelAlpha), color);
  }

  return color;
}

void main() {
  if (globeMapClipped()) discard;
  vec3 n = normalize(vPosition);
  float lat = degrees(asin(clamp(n.y, -1.0, 1.0)));
  float lng = degrees(atan(n.x, n.z));
  vec2 lngLat = vec2(lng + 180.0, lat + 90.0);

  vec4 color = vec4(0.0);
  if (uSquareBlend < 0.999) {
    color += (1.0 - uSquareBlend) * drawLevel(
      lngLat, vec2(20.0, 10.0), vec2(${GRID_FIELD_COLUMNS}.0, ${GRID_FIELD_ROWS}.0), uFields, 0.0,
      0.13, 0.12, 2.6, 2.0
    );
  }
  if (uSquareBlend > 0.001) {
    color += uSquareBlend * drawLevel(
      lngLat, vec2(2.0, 1.0), vec2(${GRID_SQUARE_COLUMNS}.0, ${GRID_SQUARE_ROWS}.0), uSquares, 1.0,
      0.1, 0.18, 0.26, 4.0
    );
  }
  if (color.a < 0.002) discard;
  gl_FragColor = color;
}
`;

function createStatusTexture(data: Uint8Array, width: number, height: number) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** White glyphs on transparent; null where no 2D canvas exists (tests, old WebViews). */
function createGlyphAtlas() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_WIDTH * GLYPHS.length;
  canvas.height = GLYPH_HEIGHT;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    context = null;
  }
  if (!context) return null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `600 ${Math.round(GLYPH_HEIGHT * 0.78)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  for (let index = 0; index < GLYPHS.length; index += 1) {
    context.fillText(GLYPHS[index], GLYPH_WIDTH * (index + 0.5), GLYPH_HEIGHT * 0.54);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface MaidenheadGridLayer {
  /** Unit sphere; scale it to the globe radius when adding it to the scene. */
  readonly mesh: GlobeShellMesh;
  /** Relative altitude of the shell above the globe surface. */
  readonly altitude: number;
  setStatus(data: GridStatusData): void;
  /** Rendered pixel ratio over the display's own (see adaptivePixelRatio). */
  setPixelScale(scale: number): void;
  dispose(): void;
}

export function createMaidenheadGridLayer(projection: GlobeMapProjection = createGlobeMapProjection()): MaidenheadGridLayer {
  const empty = buildGridStatusData([]);
  const squares = createStatusTexture(empty.squares, GRID_SQUARE_COLUMNS, GRID_SQUARE_ROWS);
  const fields = createStatusTexture(empty.fields, GRID_FIELD_COLUMNS, GRID_FIELD_ROWS);
  const glyphs = createGlyphAtlas();

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uSquares: { value: squares },
      uFields: { value: fields },
      uGlyphs: { value: glyphs },
      uHasGlyphs: { value: glyphs ? 1 : 0 },
      uSquareBlend: { value: getGridSquareBlend(1) },
      uPixelScale: { value: 1 },
      uLineColor: { value: toShaderColor('rgb(248, 113, 113)') },
      uWorkedColor: { value: toShaderColor('rgb(239, 68, 68)') },
      uConfirmedColor: { value: toShaderColor('rgb(52, 211, 153)') },
      uLabelColor: { value: toShaderColor('rgb(254, 226, 226)') },
      ...projection.uniforms,
    },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const geometry = new THREE.SphereGeometry(1, GRID_SHELL_SEGMENTS.width, GRID_SHELL_SEGMENTS.height);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = GLOBE_RENDER_ORDER.gridOverlay;
  mesh.name = 'maidenhead-grid';
  mesh.userData[GLOBE_MAP_NATIVE] = true;
  // The shell covers the globe; hover picking must reach the points and arcs below it.
  mesh.raycast = () => {};
  // Follow the camera without any React or CPU-side view tracking.
  mesh.onBeforeRender = (_renderer: unknown, _scene: unknown, camera: { position: { length(): number } }) => {
    const globeRadius = mesh.scale.x / (1 + GRID_SHELL_ALTITUDE);
    if (globeRadius > 0) {
      material.uniforms.uSquareBlend.value = getGridSquareBlend(camera.position.length() / globeRadius - 1);
    }
  };

  return {
    mesh,
    altitude: GRID_SHELL_ALTITUDE,
    setPixelScale(scale) {
      material.uniforms.uPixelScale.value = scale > 0 ? scale : 1;
    },
    setStatus(data) {
      squares.image.data = data.squares;
      squares.needsUpdate = true;
      fields.image.data = data.fields;
      fields.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      squares.dispose();
      fields.dispose();
      glyphs?.dispose();
    },
  };
}
