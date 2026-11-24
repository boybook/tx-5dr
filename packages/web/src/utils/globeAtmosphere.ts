import * as THREE from 'three';
import { GLOBE_RENDER_ORDER, toShaderColor, type GlobeShellMesh } from './globeShell';
import {
  GLOBE_MAP_FRAGMENT_PARS,
  GLOBE_MAP_HIDDEN_FLAT,
  GLOBE_MAP_NATIVE,
  GLOBE_MAP_VERTEX_PARS,
  createGlobeMapProjection,
  type GlobeMapProjection,
} from './globeMapProjection';

/**
 * Aerial haze over the ground of the logbook globe.
 *
 * Looking straight down, the eye crosses little air; towards the horizon the
 * path through the atmosphere grows long and the ground fades into a pale
 * sky-blue veil. globe.gl's own atmosphere is only a halo outside the disc, so
 * without this the surface stays crisp right up to the edge and the globe
 * reads as a cut-out.
 *
 * The haze veils the ground only (texture, land, night shade, reception
 * glow): it is drawn below every data layer (see GLOBE_RENDER_ORDER), so
 * markers, arcs and grid squares stay as legible at the horizon as anywhere.
 * It stays clear over most of the disc and rises only in the outer rim.
 */

/**
 * Clear of the land caps (see GLOBE_SHELL_MIN_CAP_CLEARANCE). Its draw order,
 * not its altitude, keeps it above the night shade and below the data.
 */
export const HAZE_SHELL_ALTITUDE = 0.0052;
export const HAZE_SHELL_SEGMENTS = { width: 192, height: 96 } as const;

/** Opacity of the haze where the line of sight grazes the ground. */
export const HAZE_MAX_OPACITY = 0.52;
/** How sharply the haze gathers at the horizon; higher keeps more of the disc clear. */
export const HAZE_FALLOFF = 1.9;
/** Haze left on the night side, where no sunlight scatters in the air. */
export const HAZE_NIGHT_LEVEL = 0.45;

/**
 * Haze opacity at a point whose surface faces the camera by `facing`
 * (cosine of the angle between the surface normal and the line of sight: 1
 * at the disc centre, 0 at the horizon), before day and night.
 */
export function getHazeOpacity(facing: number): number {
  const grazing = 1 - Math.min(1, Math.max(0, facing));
  return HAZE_MAX_OPACITY * grazing ** HAZE_FALLOFF;
}

// The fresnel term reads the sphere; the haze fades out as the globe unrolls.
const vertexShader = /* glsl */ `
${GLOBE_MAP_VERTEX_PARS}
varying vec3 vPosition;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  vPosition = position;
  vViewNormal = normalize(normalMatrix * normal);
  vViewPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
  gl_Position = globeMapClipPosition(position);
}
`;

const fragmentShader = /* glsl */ `
${GLOBE_MAP_FRAGMENT_PARS}
uniform vec3 uSunDirection;
uniform float uSunWeight;
uniform float uMaxOpacity;
uniform float uFalloff;
uniform float uNightLevel;
uniform vec3 uDeepColor;
uniform vec3 uRimColor;
uniform vec3 uTwilightColor;
varying vec3 vPosition;
varying vec3 vViewNormal;
varying vec3 vViewPosition;

void main() {
  float facing = clamp(dot(normalize(vViewNormal), normalize(-vViewPosition)), 0.0, 1.0);
  float grazing = 1.0 - facing;
  float fade = 1.0 - globeMapMorph;
  float haze = uMaxOpacity * pow(grazing, uFalloff) * fade * fade;
  if (haze < 0.002 || globeMapClipped()) discard;

  // Deeper blue inside, paler where the line of sight skims the ground.
  vec3 color = mix(uDeepColor, uRimColor, pow(grazing, 3.0));

  // Sunlit air glows; air over the night side barely does. A warm tint
  // follows the grey line.
  float sunDot = dot(normalize(vPosition), uSunDirection);
  float daylight = smoothstep(-0.22, 0.18, sunDot);
  float twilight = exp(-pow((sunDot + 0.03) / 0.11, 2.0));
  haze *= mix(1.0, mix(uNightLevel, 1.0, daylight), uSunWeight);
  color = mix(color, uTwilightColor, 0.4 * twilight * uSunWeight);

  gl_FragColor = vec4(color * haze, haze);
}
`;

export interface GlobeHazeLayer {
  /** Unit sphere; scale it to the globe radius when adding it to the scene. */
  readonly mesh: GlobeShellMesh;
  readonly altitude: number;
  /** Lights the haze from the sun at this direction; null shades it evenly. */
  setSunDirection(direction: { x: number; y: number; z: number } | null): void;
  dispose(): void;
}

export function createGlobeHazeLayer(projection: GlobeMapProjection = createGlobeMapProjection()): GlobeHazeLayer {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(0, 0, 1) },
      uSunWeight: { value: 0 },
      uMaxOpacity: { value: HAZE_MAX_OPACITY },
      uFalloff: { value: HAZE_FALLOFF },
      uNightLevel: { value: HAZE_NIGHT_LEVEL },
      uDeepColor: { value: toShaderColor('rgb(52, 120, 180)') },
      uRimColor: { value: toShaderColor('rgb(150, 214, 250)') },
      uTwilightColor: { value: toShaderColor('rgb(253, 186, 116)') },
      ...projection.uniforms,
    },
    transparent: true,
    premultipliedAlpha: true,
    // An enclosing shell: drawn by GLOBE_RENDER_ORDER, never hidden by the ground.
    depthTest: false,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const geometry = new THREE.SphereGeometry(1, HAZE_SHELL_SEGMENTS.width, HAZE_SHELL_SEGMENTS.height);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = GLOBE_RENDER_ORDER.haze;
  mesh.name = 'globe-haze';
  mesh.userData[GLOBE_MAP_NATIVE] = true;
  // Nothing to veil on the flat map: skipped once it is fully unrolled.
  mesh.userData[GLOBE_MAP_HIDDEN_FLAT] = true;
  // Never intercept hover picking of the layers above it.
  mesh.raycast = () => {};

  return {
    mesh,
    altitude: HAZE_SHELL_ALTITUDE,
    setSunDirection(direction) {
      if (direction) {
        material.uniforms.uSunDirection.value.set(direction.x, direction.y, direction.z);
      }
      material.uniforms.uSunWeight.value = direction ? 1 : 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
