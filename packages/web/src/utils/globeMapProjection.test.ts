import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FLAT_MAP_MAX_LATITUDE,
  SINGLE_PASS_HALF_WIDTH,
  classifyGlobeMapMaterial,
  createGlobeMapProjection,
  createGlobeMapSceneSync,
  getFlatMapViewLimits,
  getPassCullMargin,
  MULTI_PASS_HALF_WIDTH,
  installGlobeMapPasses,
  intersectFlatMap,
  mapGlobePoint,
  needsSidePasses,
  patchShaderForGlobeMap,
  wrapAngle,
} from './globeMapProjection';

const RADIUS = 100;

/** A point at a latitude, longitude and radius, in three-globe axes. */
function polar(lat: number, lng: number, radius = RADIUS) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function cameraOver(lat: number, lng: number, altitude: number) {
  const camera = new THREE.PerspectiveCamera(50, 2, 1, 10_000);
  camera.position.copy(polar(lat, lng, RADIUS * (1 + altitude)));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

function screenOf(lat: number, lng: number, camera: ReturnType<typeof cameraOver>, morph = 1) {
  const out = new THREE.Vector3();
  const shown = mapGlobePoint(polar(lat, lng), camera.position, morph, RADIUS, Math.PI, out);
  return { shown, ndc: out.project(camera) };
}

describe('unrolling the globe into a flat map', () => {
  it('leaves the globe untouched before unrolling', () => {
    const out = new THREE.Vector3();
    const point = polar(30, 60);
    expect(mapGlobePoint(point, new THREE.Vector3(0, 0, 300), 0, RADIUS, Math.PI, out)).toBe(true);
    expect(out.distanceTo(point)).toBe(0);
  });

  it('keeps the point under the camera at the centre of the view', () => {
    const camera = cameraOver(39.5, 117, 1);
    const { ndc } = screenOf(39.5, 117, camera);
    expect(Math.abs(ndc.x)).toBeLessThan(1e-9);
    expect(Math.abs(ndc.y)).toBeLessThan(1e-9);
    // Half-way through, it still has not moved.
    const half = screenOf(39.5, 117, camera, 0.5).ndc;
    expect(Math.abs(half.x) + Math.abs(half.y)).toBeLessThan(1e-9);
  });

  it('lays meridians and parallels out as a grid, north up and east right', () => {
    const camera = cameraOver(20, 100, 2);
    const east = screenOf(20, 130, camera).ndc;
    const north = screenOf(50, 100, camera).ndc;
    const northEast = screenOf(50, 130, camera).ndc;
    expect(east.x).toBeGreaterThan(0);
    expect(Math.abs(east.y)).toBeLessThan(1e-9);
    expect(north.y).toBeGreaterThan(0);
    expect(Math.abs(north.x)).toBeLessThan(1e-9);
    // Equirectangular: a degree is as wide at 50N as on the parallel below.
    expect(northEast.x).toBeCloseTo(east.x, 9);
  });

  it('cuts the map behind the view, so the far side of the world lies at both edges', () => {
    const camera = cameraOver(0, 120, 2);
    expect(screenOf(0, -61, camera).ndc.x).toBeGreaterThan(0);
    expect(screenOf(0, -59, camera).ndc.x).toBeLessThan(0);
  });

  it('clips past the map latitude and beyond the shown longitude', () => {
    const camera = cameraOver(0, 0, 1);
    const out = new THREE.Vector3();
    expect(mapGlobePoint(polar(FLAT_MAP_MAX_LATITUDE + 1, 0), camera.position, 1, RADIUS, Math.PI, out)).toBe(false);
    expect(mapGlobePoint(polar(0, 150), camera.position, 1, RADIUS, SINGLE_PASS_HALF_WIDTH, out)).toBe(false);
    expect(mapGlobePoint(polar(0, 130), camera.position, 1, RADIUS, SINGLE_PASS_HALF_WIDTH, out)).toBe(true);
  });

  it('flattens raised layers almost onto the map', () => {
    const camera = cameraOver(0, 0, 1);
    const ground = new THREE.Vector3();
    const raised = new THREE.Vector3();
    mapGlobePoint(polar(10, 10), camera.position, 1, RADIUS, Math.PI, ground);
    mapGlobePoint(polar(10, 10, RADIUS * 1.4), camera.position, 1, RADIUS, Math.PI, raised);
    expect(raised.distanceTo(ground)).toBeLessThan(RADIUS * 0.4 * 0.06);
  });

  it('picks the latitude and longitude under a ray, as drawn', () => {
    const camera = cameraOver(35, 140, 1.5);
    const drawn = new THREE.Vector3();
    mapGlobePoint(polar(12, 171), camera.position, 1, RADIUS, Math.PI, drawn);
    const hit = intersectFlatMap(camera.position, drawn.clone().sub(camera.position), RADIUS);
    expect(hit?.lat).toBeCloseTo(12, 6);
    expect(hit?.lng).toBeCloseTo(171, 6);
    // Across the cut, longitudes wrap.
    mapGlobePoint(polar(-5, -170), camera.position, 1, RADIUS, Math.PI, drawn);
    expect(intersectFlatMap(camera.position, drawn.clone().sub(camera.position), RADIUS)?.lng).toBeCloseTo(-170, 6);
    // Looking away from the map misses it.
    expect(intersectFlatMap(camera.position, camera.position.clone(), RADIUS)).toBeNull();
  });

  it('wraps angles into [-PI, PI)', () => {
    expect(wrapAngle(Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapAngle(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12);
    expect(wrapAngle(-Math.PI / 4)).toBeCloseTo(-Math.PI / 4, 12);
  });
});

describe('flat map view limits', () => {
  it('never zooms out past the top and bottom of the map', () => {
    const tanHalf = Math.tan((25 * Math.PI) / 180);
    for (const aspect of [0.6, 1, 1.7, 3]) {
      const { maxAltitude } = getFlatMapViewLimits(1, 50, aspect);
      expect(maxAltitude * tanHalf).toBeLessThanOrEqual((FLAT_MAP_MAX_LATITUDE * Math.PI) / 180 + 1e-9);
      // The highest centre allowed there still keeps the map's edge out of view.
      const top = getFlatMapViewLimits(maxAltitude, 50, aspect).maxCenterLatitude + (maxAltitude * tanHalf * 180) / Math.PI;
      expect(top).toBeLessThanOrEqual(FLAT_MAP_MAX_LATITUDE + 1e-9);
    }
  });

  it('lets the centre go further north the closer the view', () => {
    expect(getFlatMapViewLimits(0.3, 50, 2).maxCenterLatitude).toBeGreaterThan(getFlatMapViewLimits(1, 50, 2).maxCenterLatitude);
  });

  it('draws the side passes only on a finished map whose edge is in view', () => {
    expect(needsSidePasses(1, Math.PI)).toBe(true);
    expect(needsSidePasses(0.99, Math.PI)).toBe(false);
    expect(needsSidePasses(1, Math.PI / 2)).toBe(false);
  });
});

describe('patching materials', () => {
  const projection = createGlobeMapProjection();

  it('unrolls three built-in materials and evens out their lighting', () => {
    const shader = {
      vertexShader: 'void main() {\n#include <project_vertex>\n}',
      fragmentShader: '#include <lights_phong_pars_fragment>\nvoid main() {\n#include <normal_fragment_maps>\n#include <lights_phong_fragment>\n#include <lights_fragment_begin>\n#include <lights_fragment_end>\nvec3 outgoingLight = vec3(0.0);\n#include <opaque_fragment>\n}',
      uniforms: {},
    };
    expect(patchShaderForGlobeMap(shader, projection.uniforms)).toBe(true);
    expect(shader.vertexShader).toContain('globeMapPosition( ( modelMatrix * mvPosition ).xyz )');
    expect(shader.vertexShader).not.toContain('#include <project_vertex>');
    expect(shader.vertexShader.trimEnd()).toMatch(/gl_Position = globeMapCull\(gl_Position\);\n\}$/);
    expect(shader.fragmentShader).toContain('if (globeMapClipped()) discard;');
    expect(shader.fragmentShader).toContain('globeMapIrradiance');
    // Only the lighting inside main(), never the declarations before it.
    expect(shader.fragmentShader).toMatch(/\n#include <lights_phong_pars_fragment>\nvoid main/);
    expect(shader.fragmentShader).toMatch(/if \(globeMapMorph < 1\.0\) \{\n#include <lights_phong_fragment>[\s\S]*#include <lights_fragment_end>\n\}/);
    expect(shader.uniforms).toMatchObject({ globeMapMorph: projection.uniforms.globeMapMorph });
  });

  it('unrolls shaders that project the position directly, like the heatmap and the arcs', () => {
    const shader = {
      vertexShader: 'void main() {\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);\n}',
      fragmentShader: 'void main() {\n  gl_FragColor = vec4(1.0);\n}',
      uniforms: {},
    };
    expect(patchShaderForGlobeMap(shader, projection.uniforms)).toBe(true);
    expect(shader.vertexShader).toContain('globeMapPosition((modelMatrix * vec4(pos, 1.0)).xyz)');
    expect(shader.fragmentShader).not.toContain('globeMapIrradiance');
  });

  it('leaves shaders of unknown shape alone, to be hidden instead', () => {
    const shader = { vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }', fragmentShader: 'void main() {}', uniforms: {} };
    expect(patchShaderForGlobeMap(shader, projection.uniforms)).toBe(false);
    expect(classifyGlobeMapMaterial({ isShaderMaterial: true, vertexShader: shader.vertexShader })).toBe('hide');
    expect(classifyGlobeMapMaterial({ isShaderMaterial: true, uniforms: { coefficient: {}, power: {}, hollowRadius: {} } })).toBe('fade');
    expect(classifyGlobeMapMaterial({})).toBe('map');
  });

  it('patches each material once, before it compiles, with its own program key', () => {
    const sync = createGlobeMapSceneSync(createGlobeMapProjection());
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    const root = new THREE.Group();
    root.add(mesh);
    const key = material.customProgramCacheKey();
    sync.sync(root as never);
    const patched = material.onBeforeCompile;
    sync.sync(root as never);
    expect(material.onBeforeCompile).toBe(patched);
    expect(material.customProgramCacheKey()).not.toBe(key);
  });

  it('stops frustum culling while unrolled, and restores it on the globe', () => {
    const local = createGlobeMapProjection();
    const sync = createGlobeMapSceneSync(local);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    local.setMorph(0.5);
    sync.sync(mesh as never);
    expect(mesh.frustumCulled).toBe(false);
    local.setMorph(0);
    sync.sync(mesh as never);
    expect(mesh.frustumCulled).toBe(true);
  });

  it('hides the horizon haze only on the finished map', () => {
    const local = createGlobeMapProjection();
    const sync = createGlobeMapSceneSync(local);
    const haze = new THREE.Mesh();
    haze.userData = { globeMapNative: true, globeMapHiddenFlat: true };
    local.setMorph(0.9);
    sync.sync(haze as never);
    expect(haze.visible).toBe(true);
    local.setMorph(1);
    sync.sync(haze as never);
    expect(haze.visible).toBe(false);
    local.setMorph(0.2);
    sync.sync(haze as never);
    expect(haze.visible).toBe(true);
  });
});

describe('pass margins', () => {
  it('stays tight where triangles are small and widens towards the poles', () => {
    expect(getPassCullMargin(0, MULTI_PASS_HALF_WIDTH)).toBeCloseTo((12 * Math.PI) / 180, 9);
    expect(getPassCullMargin((80 * Math.PI) / 180, MULTI_PASS_HALF_WIDTH)).toBeGreaterThan((52 * Math.PI) / 180);
  });

  it('never reaches the cut, so triangles across it are still dropped', () => {
    for (const band of [MULTI_PASS_HALF_WIDTH, SINGLE_PASS_HALF_WIDTH]) {
      expect(band + getPassCullMargin((89 * Math.PI) / 180, band)).toBeLessThan(Math.PI - (1 * Math.PI) / 180);
    }
  });
});

describe('render passes', () => {
  it('keeps the starry sky on the globe and drops it behind the finished map', () => {
    const projection = createGlobeMapProjection();
    const sky = { isMesh: true, visible: true, material: { side: THREE.BackSide } };
    const seen: boolean[] = [];
    const pass = { render: () => seen.push(sky.visible) };
    installGlobeMapPasses({
      composer: { passes: [pass as never] },
      scene: { background: null, children: [sky] } as never,
      camera: {},
      projection,
      beforeFrame: () => false,
    });
    pass.render();
    projection.setMorph(1);
    pass.render();
    expect(seen).toEqual([true, false]);
    expect(sky.visible).toBe(true);
  });

  it('adds the two side passes without clearing or the sky, and restores the pass', () => {
    const projection = createGlobeMapProjection();
    projection.setMorph(1);
    const sky = { isMesh: true, visible: true, material: { side: THREE.BackSide } };
    const scene = { background: 'stars', children: [sky] };
    const centers: Array<{ center: number; sky: boolean; autoClear: boolean }> = [];
    const renderer = {
      autoClear: true,
      render: () => centers.push({ center: projection.uniforms.globeMapPassCenter.value, sky: sky.visible, autoClear: renderer.autoClear }),
    };
    const pass = { render: (r: typeof renderer) => r.render() };
    const original = pass.render;
    let sides = false;
    const uninstall = installGlobeMapPasses({
      composer: { passes: [pass as never] },
      scene: scene as never,
      camera: {},
      projection,
      beforeFrame: () => sides,
    });

    pass.render(renderer as never);
    expect(centers).toHaveLength(1);
    expect(projection.shownHalfWidth).toBe(SINGLE_PASS_HALF_WIDTH);

    sides = true;
    centers.length = 0;
    pass.render(renderer as never);
    expect(centers.map(entry => entry.center)).toEqual([0, Math.PI, -Math.PI]);
    expect(centers.every(entry => !entry.sky)).toBe(true);
    expect(centers.slice(1).every(entry => !entry.autoClear)).toBe(true);
    expect(sky.visible).toBe(true);
    expect(scene.background).toBe('stars');
    expect(renderer.autoClear).toBe(true);
    expect(projection.shownHalfWidth).toBe(Math.PI);

    uninstall();
    expect(pass.render).toBe(original);
  });
});
