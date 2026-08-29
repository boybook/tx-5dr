import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

import { ImageArtifactStore } from '../ImageArtifactStore.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ImageArtifactStore', () => {
  it('persists canonical PNG metadata and restores the index', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-store-'));
    dirs.push(dir);
    const store = new ImageArtifactStore(dir);
    await store.initialize();
    const artifact = await store.save({
      family: 'sstv', direction: 'rx', codecMode: 'robot36', pixelFormat: 'rgb8',
      width: 2, height: 2, pixels: new Uint8Array(12).fill(127), frequency: 14_230_000,
      radioMode: 'USB', complete: true,
    });
    const decoded = PNG.sync.read(await store.readImage(artifact.id));
    expect([decoded.width, decoded.height]).toEqual([2, 2]);
    const restored = new ImageArtifactStore(dir);
    await restored.initialize();
    expect(restored.get(artifact.id)?.contentHash).toBe(artifact.contentHash);
  });

  it('migrates persisted deadSector fax calibration sources', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-store-'));
    dirs.push(dir);
    const indexPath = path.join(dir, 'index.json');
    await writeFile(indexPath, JSON.stringify({
      artifacts: [{
        id: 'legacy-fax', family: 'fax', direction: 'rx', codecMode: 'ioc576/120/fm', pixelFormat: 'gray8',
        width: 2, height: 2, frequency: 9_108_100, complete: true, pinned: false,
        contentHash: 'legacy', createdAt: 1, imageUrl: '/api/image-radio/artifacts/legacy-fax/image',
        faxCalibration: {
          boundaryId: 'boundary-1', revision: 1, autoEnabled: true,
          autoPoints: [{
            revision: 1, referenceLine: 0, phasePixels: 0, clockPpm: 0,
            confidence: 0.9, source: 'deadSector', status: 'locked',
          }],
          manualPhasePixels: 0, manualClockPpm: 0, updatedAt: 1,
        },
      }],
    }));

    const store = new ImageArtifactStore(dir);
    await store.initialize();

    expect(store.get('legacy-fax')?.faxCalibration?.autoPoints[0].source).toBe('imageContent');
    const persisted = await readFile(indexPath, 'utf8');
    expect(persisted).toContain('"source": "imageContent"');
    expect(persisted).not.toContain('deadSector');
  });

  it('rejects mismatched normalized SSTV dimensions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-store-'));
    dirs.push(dir);
    const store = new ImageArtifactStore(dir);
    await store.initialize();
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    await expect(store.importNormalizedSstvPng({ png, mode: 'robot36', width: 320, height: 240, operatorId: 'op', frequency: 14_230_000 })).rejects.toThrow('IMAGE_UPLOAD_DIMENSION_MISMATCH');
  });

  it('rejects hostile IHDR dimensions before PNG decompression', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-store-'));
    dirs.push(dir);
    const store = new ImageArtifactStore(dir);
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    png.writeUInt32BE(100_000, 16);
    await expect(store.importNormalizedSstvPng({
      png, mode: 'robot36', width: 2, height: 2, operatorId: 'op', frequency: 14_230_000,
    })).rejects.toThrow('IMAGE_UPLOAD_DIMENSION_MISMATCH');
  });

  it('deletes both the immutable PNG and its persisted index entry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-store-'));
    dirs.push(dir);
    const store = new ImageArtifactStore(dir);
    const artifact = await store.save({
      family: 'fax', direction: 'rx', codecMode: 'ioc576/120/fm', pixelFormat: 'gray8',
      width: 2, height: 2, pixels: new Uint8Array(4), frequency: 9_108_100, complete: true,
    });

    await store.delete(artifact.id);

    await expect(store.readImage(artifact.id)).rejects.toThrow('IMAGE_ARTIFACT_NOT_FOUND');
    const restored = new ImageArtifactStore(dir);
    await restored.initialize();
    expect(restored.get(artifact.id)).toBeNull();
  });
});
