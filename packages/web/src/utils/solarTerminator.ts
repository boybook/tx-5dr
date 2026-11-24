import * as THREE from 'three';
import { GLOBE_RENDER_ORDER, toShaderColor, type GlobeShellMesh } from './globeShell';
import {
  GLOBE_MAP_FRAGMENT_PARS,
  GLOBE_MAP_NATIVE,
  GLOBE_MAP_VERTEX_PARS,
  createGlobeMapProjection,
  type GlobeMapProjection,
} from './globeMapProjection';

/**
 * Day/night shading and the grey line for the logbook globe.
 *
 * The CPU only computes the subsolar point (once a minute is plenty); a
 * transparent sphere shell shades every pixel from the sun's elevation there,
 * so moving the camera costs nothing.
 *
 * The whole globe keeps its night texture so the eye stays on the data. The
 * shade multiplies the ground below it (see GROUND_GAINS): it darkens the
 * night side through twilight, warms the ground along the grey line, lifts
 * the sunlit side a touch, and brightens the texture's city lights where it
 * is dark.
 */

const MS_PER_DAY = 86_400_000;
/** 2000-01-01T12:00:00Z, the J2000.0 epoch. */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/**
 * Clear of the land caps (0.0025) even in the middle of a facet, so the
 * shade never z-fights with them. Markers are kept out of it by draw order
 * (see GLOBE_RENDER_ORDER), not by altitude.
 */
export const TERMINATOR_SHELL_ALTITUDE = 0.0042;
export const TERMINATOR_SHELL_SEGMENTS = { width: 192, height: 96 } as const;

function normalizeDegrees(value: number, min: number): number {
  return ((((value - min) % 360) + 360) % 360) + min;
}

/**
 * Point on Earth where the sun is at the zenith, from the low-precision solar
 * coordinates of the Astronomical Almanac (better than 0.1 degree, far below
 * what a globe overview can show).
 */
export function getSubsolarPoint(date: Date): { lat: number; lng: number } {
  const days = (date.getTime() - J2000_MS) / MS_PER_DAY;
  const rad = Math.PI / 180;
  const meanAnomaly = normalizeDegrees(357.529 + 0.98560028 * days, 0) * rad;
  const meanLongitude = normalizeDegrees(280.459 + 0.98564736 * days, 0);
  const eclipticLongitude = (meanLongitude
    + 1.915 * Math.sin(meanAnomaly)
    + 0.02 * Math.sin(2 * meanAnomaly)) * rad;
  const obliquity = (23.439 - 0.00000036 * days) * rad;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  ) / rad;
  const greenwichSiderealDegrees = normalizeDegrees(280.46061837 + 360.98564736629 * days, 0);

  return {
    lat: declination / rad,
    lng: normalizeDegrees(rightAscension - greenwichSiderealDegrees, -180),
  };
}

/** Unit vector in the globe layer frame (three-globe's polar2Cartesian). */
export function latLngToGlobeDirection(lat: number, lng: number): { x: number; y: number; z: number } {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  return {
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta),
  };
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

/**
 * How sunlight shades the ground at each sun elevation, in degrees. Kept in
 * the shader and mirrored here for tests.
 */
export const DAYLIGHT_SHADING = {
  /** Night is fully dark below astronomical twilight. */
  nightBelowDeg: -18,
  /** Darkness begins just after sunset, at the sun's lower limb. */
  nightAboveDeg: -0.8,
  /** Share of the ground's light the full night takes away. */
  nightDimming: 0.5,
  /** City lights fade in through civil twilight. */
  lightsOnBelowDeg: 2,
  lightsFullBelowDeg: -9,
} as const;

/** Share of the ground's light the night takes away at a sun elevation (0 to nightDimming). */
export function getNightDimming(elevationDeg: number): number {
  const { nightBelowDeg, nightAboveDeg, nightDimming } = DAYLIGHT_SHADING;
  const t = Math.min(1, Math.max(0, (nightAboveDeg - elevationDeg) / (nightAboveDeg - nightBelowDeg)));
  // Smootherstep: no visible edge where the dusk starts or where night ends.
  return nightDimming * t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Per-channel gains the shade applies to the ground (1 leaves it as it is).
 * The shade is blended as a modulate-2x: it multiplies the colour below it,
 * so twilight tints the ground and keeps every detail of the texture instead
 * of laying a coloured film over it.
 */
export const GROUND_GAINS = {
  /** Full night: darker, keeping a little more blue as moonlit ground does. */
  night: [1 - DAYLIGHT_SHADING.nightDimming, 0.53, 0.64],
  /** Low sun: warm light, less blue. */
  dusk: [1.24, 1.05, 0.84],
  /** Below the dusk: a faint violet afterglow. */
  afterglow: [1.05, 0.95, 1.07],
  /** The sun high overhead lifts the ground a little. */
  sunlit: [1.12, 1.14, 1.16],
} as const;

/** The largest gain a modulate-2x blend can apply. */
export const MAX_GROUND_GAIN = 2;

/**
 * Terrain relief: a shaded relief map (Natural Earth "Shaded Relief Basic",
 * lit from the north-west) whose flat ground and seas are this neutral grey.
 * Brighter than it, a slope faces the light; darker, it is in shade.
 */
export const RELIEF_NEUTRAL = 206 / 255;
/** How far the relief lightens and darkens the ground (0 none, 1 the map's full range). */
export const RELIEF_STRENGTH = 0.65;

/** Ground gain of a relief map value: 1 on flat ground and at sea. */
export function getReliefGain(shade: number, strength: number = RELIEF_STRENGTH): number {
  return 1 + (shade / RELIEF_NEUTRAL - 1) * strength;
}

const commonShader = /* glsl */ `
uniform vec3 uSunDirection;
uniform float uNightBelow;
uniform float uNightAbove;
uniform float uLightsOnBelow;
uniform float uLightsFullBelow;
uniform sampler2D uEarth;
varying vec3 vPosition;

const float PI = 3.141592653589793;

float smootherstep01(float t) {
  t = clamp(t, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float sunElevation(vec3 n) {
  return degrees(asin(clamp(dot(n, uSunDirection), -1.0, 1.0)));
}

// Texture coordinates of the night texture at this point, with their
// screen-space derivatives for filtering. Longitude wraps at the
// antimeridian; picking the smaller of two derivatives keeps the jump there
// from selecting the blurriest mip level (a visible seam).
void earthCoords(vec3 n, out vec2 uv, out vec2 dx, out vec2 dy) {
  float u = atan(n.x, n.z) / (2.0 * PI) + 0.5;
  float v = asin(clamp(n.y, -1.0, 1.0)) / PI + 0.5;
  float uWrapped = fract(u + 0.5);
  float dxA = dFdx(u), dxB = dFdx(uWrapped);
  float dyA = dFdy(u), dyB = dFdy(uWrapped);
  uv = vec2(u, v);
  dx = vec2(abs(dxA) < abs(dxB) ? dxA : dxB, dFdx(v));
  dy = vec2(abs(dyA) < abs(dyB) ? dyA : dyB, dFdy(v));
}

// The globe's texture is sampled linear (it is marked sRGB); the light
// thresholds below are in its stored sRGB values.
vec3 encodeSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// City lights of the night texture: warm points brighter than the blue
// terrain and seas around them. JPEG keeps colour only in coarse blocks, so
// colour alone would cut the lights into squares; their shape comes from the
// full-resolution brightness, and warmth, read from a blurred sample, only
// weights it. Every step is a soft ramp, so no edge is drawn.
// Returns the lights and a soft halo around them.
vec2 cityLights(vec3 n) {
  vec2 uv, dx, dy;
  earthCoords(n, uv, dx, dy);
  vec3 sharp = encodeSrgb(textureGrad(uEarth, uv, dx, dy).rgb);
  vec3 wide = encodeSrgb(textureGrad(uEarth, uv, dx * 5.0, dy * 5.0).rgb);
  float warmth = smoothstep(-0.07, 0.06, wide.r - wide.b * 0.85);
  float points = smoothstep(0.17, 0.5, dot(sharp, LUMA));
  float halo = smoothstep(0.15, 0.36, dot(wide, LUMA));
  return vec2(points, halo) * warmth;
}
`;

/**
 * Sunlight on the ground: multiplies what is below (modulate-2x), so it
 * darkens and tints the ground without covering any of it.
 */
const groundShader = /* glsl */ `
${GLOBE_MAP_FRAGMENT_PARS}
${commonShader}
uniform vec3 uNightGain;
uniform vec3 uDuskGain;
uniform vec3 uAfterglowGain;
uniform vec3 uSunlitGain;
uniform float uDaylight;
uniform sampler2D uRelief;
uniform float uReliefStrength;
const float MAX_GAIN = ${MAX_GROUND_GAIN.toFixed(1)};
const float RELIEF_NEUTRAL = ${RELIEF_NEUTRAL.toFixed(6)};

void main() {
  if (globeMapClipped()) discard;
  vec3 n = normalize(vPosition);
  vec3 gain = vec3(1.0);

  if (uDaylight > 0.5) {
    float elevation = sunElevation(n);

    // Darkness deepens smoothly from sunset to the end of astronomical twilight.
    float night = smootherstep01((uNightAbove - elevation) / (uNightAbove - uNightBelow));
    gain = mix(vec3(1.0), uNightGain, night);

    // Twilight: warm light along the terminator, a violet afterglow beyond it.
    // The two overlap so the colours run into each other, as at real dusk.
    float dusk = exp(-pow((elevation + 1.5) / 3.0, 2.0));
    float afterglow = exp(-pow((elevation + 6.5) / 5.5, 2.0));
    gain *= mix(vec3(1.0), uDuskGain, dusk);
    gain *= mix(vec3(1.0), uAfterglowGain, afterglow);

    // The sunlit side is lifted a little, most where the sun stands high.
    gain *= mix(vec3(1.0), uSunlitGain, smoothstep(-1.0, 40.0, elevation));
  }

  // Terrain relief shades the ground itself: slopes facing the light lift
  // it and slopes in shade darken it, over the land tint as well, so the
  // tint never flattens the mountains. Flat ground and seas stay as they are.
  if (uReliefStrength > 0.0) {
    vec2 uv, dx, dy;
    earthCoords(n, uv, dx, dy);
    float shade = textureGrad(uRelief, uv, dx, dy).r;
    gain *= 1.0 + (shade / RELIEF_NEUTRAL - 1.0) * uReliefStrength;
  }

  gain = min(gain, vec3(MAX_GAIN));
  vec3 change = abs(gain - 1.0);
  if (max(change.r, max(change.g, change.b)) < 0.004) discard;
  // Modulate-2x blend: result = 2 * output * ground.
  gl_FragColor = vec4(gain / MAX_GAIN, 1.0);
}
`;

/**
 * City lights: they shine rather than being lit, so they are added on top of
 * the darkened ground, coming on through twilight.
 */
const lightsShader = /* glsl */ `
${GLOBE_MAP_FRAGMENT_PARS}
${commonShader}
uniform vec3 uCityLightColor;

void main() {
  if (globeMapClipped()) discard;
  vec3 n = normalize(vPosition);
  float lightsOn = smootherstep01((uLightsOnBelow - sunElevation(n)) / (uLightsOnBelow - uLightsFullBelow));
  if (lightsOn <= 0.0) discard;
  vec2 lights = cityLights(n);
  vec3 color = uCityLightColor * (lights.x * 0.6 + lights.y * 0.12) * lightsOn;
  if (max(color.r, max(color.g, color.b)) < 0.002) discard;
  gl_FragColor = vec4(color, 0.0);
}
`;

function toVector(direction: { x: number; y: number; z: number }) {
  return new THREE.Vector3(direction.x, direction.y, direction.z);
}

export interface SolarTerminatorLayer {
  /** Unit sphere; scale it to the globe radius when adding it to the scene. */
  readonly mesh: GlobeShellMesh;
  readonly altitude: number;
  setTime(date: Date): void;
  /**
   * The globe's own night texture (equirectangular, owned by the globe):
   * its city lights are lifted on the night side. Until it is set the shade
   * only darkens.
   */
  setEarthTexture(texture: unknown): void;
  /**
   * A shaded relief map (single channel, equirectangular, see
   * RELIEF_NEUTRAL); null leaves the ground flat. The layer does not own it.
   */
  setReliefTexture(texture: unknown): void;
  /** Day, night and the city lights; the relief stays when they are hidden. */
  setDaylightVisible(visible: boolean): void;
  dispose(): void;
}

export function createSolarTerminatorLayer(
  date: Date = new Date(),
  projection: GlobeMapProjection = createGlobeMapProjection(),
): SolarTerminatorLayer {
  const sun = getSubsolarPoint(date);
  const sharedUniforms = {
    uSunDirection: { value: toVector(latLngToGlobeDirection(sun.lat, sun.lng)) },
    uNightBelow: { value: DAYLIGHT_SHADING.nightBelowDeg },
    uNightAbove: { value: DAYLIGHT_SHADING.nightAboveDeg },
    uLightsOnBelow: { value: DAYLIGHT_SHADING.lightsOnBelowDeg },
    uLightsFullBelow: { value: DAYLIGHT_SHADING.lightsFullBelowDeg },
    uEarth: { value: null as unknown },
    ...projection.uniforms,
  };
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: groundShader,
    uniforms: {
      ...sharedUniforms,
      uNightGain: { value: new THREE.Vector3(...GROUND_GAINS.night) },
      uDuskGain: { value: new THREE.Vector3(...GROUND_GAINS.dusk) },
      uAfterglowGain: { value: new THREE.Vector3(...GROUND_GAINS.afterglow) },
      uSunlitGain: { value: new THREE.Vector3(...GROUND_GAINS.sunlit) },
      uDaylight: { value: 1 },
      uRelief: { value: null as unknown },
      uReliefStrength: { value: 0 },
    },
    transparent: true,
    // An enclosing shell: drawn by GLOBE_RENDER_ORDER, never hidden by the ground.
    depthTest: false,
    depthWrite: false,
    side: THREE.FrontSide,
    // Modulate-2x: ground * output + output * ground. The colour channels
    // scale the ground by 0 to 2; its alpha is left as it is.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const lightsMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: lightsShader,
    uniforms: {
      ...sharedUniforms,
      uCityLightColor: { value: toShaderColor('rgb(255, 190, 112)') },
    },
    transparent: true,
    // An enclosing shell: drawn by GLOBE_RENDER_ORDER, never hidden by the ground.
    depthTest: false,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const geometry = new THREE.SphereGeometry(1, TERMINATOR_SHELL_SEGMENTS.width, TERMINATOR_SHELL_SEGMENTS.height);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = GLOBE_RENDER_ORDER.nightShade;
  mesh.name = 'solar-terminator';
  mesh.userData[GLOBE_MAP_NATIVE] = true;
  // Never intercept hover picking of the layers above it.
  mesh.raycast = () => {};
  // A child shares the shade's scale; it is drawn only once the texture has
  // loaded, and while day and night are shown.
  const lightsMesh = new THREE.Mesh(geometry, lightsMaterial);
  lightsMesh.renderOrder = GLOBE_RENDER_ORDER.cityLights;
  lightsMesh.name = 'city-lights';
  lightsMesh.userData[GLOBE_MAP_NATIVE] = true;
  lightsMesh.raycast = () => {};
  lightsMesh.visible = false;
  mesh.add(lightsMesh);
  let daylight = true;
  // With neither day and night nor relief to draw, the shell is skipped.
  const syncVisibility = () => {
    mesh.visible = daylight || !!material.uniforms.uRelief.value;
    lightsMesh.visible = daylight && !!sharedUniforms.uEarth.value;
  };

  return {
    mesh,
    altitude: TERMINATOR_SHELL_ALTITUDE,
    setTime(next) {
      const point = getSubsolarPoint(next);
      const direction = latLngToGlobeDirection(point.lat, point.lng);
      material.uniforms.uSunDirection.value.set(direction.x, direction.y, direction.z);
    },
    setEarthTexture(texture) {
      // The materials share this uniform object.
      sharedUniforms.uEarth.value = texture ?? null;
      syncVisibility();
    },
    setReliefTexture(texture) {
      material.uniforms.uRelief.value = texture ?? null;
      material.uniforms.uReliefStrength.value = texture ? RELIEF_STRENGTH : 0;
      syncVisibility();
    },
    setDaylightVisible(visible) {
      daylight = visible;
      material.uniforms.uDaylight.value = visible ? 1 : 0;
      syncVisibility();
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      lightsMaterial.dispose();
    },
  };
}
