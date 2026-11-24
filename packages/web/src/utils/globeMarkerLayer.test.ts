// @vitest-environment jsdom
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHEEN_SECONDS, createGlobeMarkerLayer, type GlobeMarker } from './globeMarkerLayer';

const WIDTH = 800;
const HEIGHT = 600;

function cameraOver(lat: number, lng: number, altitude: number) {
  const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 50000);
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  const r = 100 * (1 + altitude);
  camera.position.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

function marker(id: string, lat: number, lng: number, extra: Partial<GlobeMarker> = {}): GlobeMarker {
  return { id, lat, lng, shape: 'dot', size: 8, color: '#ffffff', opacity: 1, priority: 1, data: id, ...extra };
}

type BeforeRender = (renderer: unknown, scene: unknown, camera: unknown) => void;

/** Runs the per-frame hook the renderer would, so the layer knows the camera and viewport. */
function render(layer: ReturnType<typeof createGlobeMarkerLayer>, camera: unknown) {
  const mesh = layer.mesh as unknown as { onBeforeRender: BeforeRender };
  const renderer = { getSize: (target: { set(x: number, y: number): unknown }) => target.set(WIDTH, HEIGHT) };
  mesh.onBeforeRender(renderer, null, camera);
}

describe('globe marker layer picking', () => {
  it('picks the marker under the pointer, preferring the higher priority', () => {
    const layer = createGlobeMarkerLayer();
    layer.setGlobeRadius(100);
    layer.setMarkers([
      marker('history', 30, 120, { priority: 2 }),
      marker('live', 30, 120.05, { priority: 8 }),
      marker('elsewhere', 10, 100),
    ]);
    render(layer, cameraOver(30, 120, 1));

    // The camera looks straight down at (30, 120): the screen centre.
    expect(layer.pick(WIDTH / 2, HEIGHT / 2)?.id).toBe('live');
    expect(layer.pick(10, 10)).toBeNull();
  });

  it('never picks markers on the far side of the globe', () => {
    const layer = createGlobeMarkerLayer();
    layer.setGlobeRadius(100);
    layer.setMarkers([marker('antipode', -30, -60)]);
    render(layer, cameraOver(30, 120, 1));
    expect(layer.pick(WIDTH / 2, HEIGHT / 2)).toBeNull();
  });

  it('labels only facing markers that carry a label', () => {
    const layer = createGlobeMarkerLayer();
    const container = document.createElement('div');
    layer.setGlobeRadius(100);
    layer.setLabelContainer(container);
    layer.setMarkers([
      marker('needed', 30, 120, { label: 'JA1ABC' }),
      marker('plain', 31, 121),
      marker('hidden', -30, -60, { label: 'FAR' }),
    ]);
    render(layer, cameraOver(30, 120, 1));
    expect(Array.from(container.children).map(child => child.textContent)).toEqual(['JA1ABC']);

    layer.setVisible(false);
    expect(container.children).toHaveLength(0);
    expect(layer.pick(WIDTH / 2, HEIGHT / 2)).toBeNull();
  });

  // Labels are placed on every rendered frame; with the camera still and
  // nothing fading, that work (and its style writes) is skipped.
  it('leaves labels alone while the camera stands still', () => {
    let now = 10_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const layer = createGlobeMarkerLayer();
    const container = document.createElement('div');
    layer.setGlobeRadius(100);
    layer.setLabelContainer(container);
    layer.setMarkers([marker('needed', 30, 120, { label: 'JA1ABC' })]);
    const camera = cameraOver(30, 120, 1);
    render(layer, camera);
    const label = container.children[0] as HTMLElement;
    const placed = label.style.transform;
    expect(placed).not.toBe('');

    now += 2_000;
    render(layer, camera);
    label.style.transform = 'none';
    render(layer, camera);
    expect(label.style.transform).toBe('none');

    render(layer, cameraOver(31, 121, 1));
    expect(label.style.transform).not.toBe('none');
    clock.mockRestore();
  });
});

describe('globe marker label sheen', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sweeps a label with its glyph once per fresh decode, joining late part-way through', () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const layer = createGlobeMarkerLayer();
    const container = document.createElement('div');
    const camera = cameraOver(30, 120, 1);
    layer.setGlobeRadius(100);
    layer.setLabelContainer(container);
    const station = (flashAt?: number) => marker('needed', 30, 120, { label: 'JA1ABC', flashAt });

    layer.setMarkers([station()]);
    render(layer, camera);
    const label = container.firstElementChild as HTMLElement;
    expect(label.dataset.text).toBe('JA1ABC');
    expect(label.hasAttribute('data-sheen')).toBe(false);

    // A fresh decode at 10 s, drawn 0.1 s later: the sweep starts 0.1 s in.
    layer.setMarkers([station(10_000)]);
    now = 10_100;
    render(layer, camera);
    expect(label.hasAttribute('data-sheen')).toBe(true);
    expect(label.style.getPropertyValue('--sheen-delay')).toBe('-0.100s');

    // The same flash on later frames does not restart it.
    label.style.setProperty('--sheen-delay', 'kept');
    now = 10_200;
    render(layer, camera);
    expect(label.style.getPropertyValue('--sheen-delay')).toBe('kept');

    // A flash already over when first seen is not played.
    layer.setMarkers([station(now - SHEEN_SECONDS * 1000 - 50)]);
    render(layer, camera);
    expect(label.hasAttribute('data-sheen')).toBe(false);
  });
});

describe('globe marker layer capacity', () => {
  // Regression: three remembers the instance count of the first buffers it
  // drew; growing past 64 markers without disposing the geometry left every
  // marker beyond the first 64 (the highest priority ones) undrawn.
  it('lets three forget the old instance count when it grows', () => {
    const layer = createGlobeMarkerLayer();
    layer.setGlobeRadius(100);
    // `three` is untyped here; only the parts this test reads.
    type Geometry = {
      instanceCount: number;
      _maxInstanceCount?: number;
      addEventListener(type: string, listener: () => void): void;
      getAttribute(name: string): { count: number };
    };
    const geometry = (layer.mesh as unknown as { geometry: Geometry }).geometry;
    const onDispose = vi.fn();
    geometry.addEventListener('dispose', onDispose);

    layer.setMarkers(Array.from({ length: 40 }, (_, index) => marker(`a${index}`, 0, index)));
    expect(onDispose).not.toHaveBeenCalled();
    // What the renderer caches on first draw.
    geometry._maxInstanceCount = 64;

    layer.setMarkers(Array.from({ length: 90 }, (_, index) => marker(`b${index}`, 0, index)));
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(geometry.instanceCount).toBeGreaterThanOrEqual(90);
    expect(geometry.getAttribute('aCenter').count).toBeGreaterThanOrEqual(geometry.instanceCount);
  });
});
