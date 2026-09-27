import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { ImagePersistenceCoordinator } from '../ImagePersistenceCoordinator.js';
import { ImageArtifactStore } from '../ImageArtifactStore.js';
import { ImageRecordStore } from '../ImageRecordStore.js';
import { PersistedArtifactSchema } from '../ImagePersistenceSchema.js';
import { SafeFileWriter } from '../../utils/persistence/SafeFileWriter.js';

const dirs: string[] = [];
async function directory() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'image-persistence-'));
  dirs.push(dir);
  return dir;
}
const artifact = (id = 'good') => ({
  id, family: 'sstv' as const, direction: 'rx' as const, codecMode: 'robot36', pixelFormat: 'rgb8' as const,
  width: 2, height: 2, frequency: 14230000, complete: true, pinned: false, truncated: false,
  contentHash: 'hash', createdAt: 1, imageUrl: '/image',
});
const filenames = ['index.json', 'history.json', 'templates.json', 'composer-backgrounds.json', 'sstv-tx-preferences.json'];
const keys = ['artifacts', 'records', 'templates', 'backgrounds', 'preferences'];
function records(dir: string) {
  return new ImageRecordStore(path.join(dir, 'index.json'), 'artifacts', 'artifacts', PersistedArtifactSchema, item => item.id);
}
async function assertArchived(dir: string, file: string, raw: string) {
  const digest = createHash('sha256').update(raw).digest('hex');
  expect(await fs.readFile(path.join(dir, 'recovery', file, `${digest}.original`), 'utf8')).toBe(raw);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('image disk compatibility and recovery', () => {
  it.each(['', '{"artifacts":', 'null', '[]', '{}', '{"artifacts":{}}', '{"schemaVersion":null,"artifacts":[]}'])('archives and rebuilds malformed data: %s', async raw => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, 'index.json'), raw);
    const store = records(dir);
    await store.initialize();
    expect(store.getStatus()).toMatchObject({ state: 'recovered', reason: 'rebuilt' });
    expect(store.values.size).toBe(0);
    await assertArchived(dir, 'index.json', raw);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'))).toEqual({ schemaVersion: 1, artifacts: [] });
  });

  it('salvages valid records, rejects conflicting identities, and leaves image files untouched', async () => {
    const dir = await directory();
    const raw = JSON.stringify({ artifacts: [artifact(), { ...artifact('bad'), frequency: 0 }, artifact('duplicate'), artifact('duplicate')] });
    await fs.writeFile(path.join(dir, 'index.json'), raw);
    await fs.mkdir(path.join(dir, 'images'));
    await fs.writeFile(path.join(dir, 'images', 'orphan.png'), 'original');
    const store = new ImageArtifactStore(dir, 0);
    await Promise.all([store.initialize(), store.initialize()]);
    expect(store.listAll().map(item => item.id)).toEqual(['good']);
    expect(store.persistence.getStatus()).toMatchObject({ reason: 'salvaged', retainedRecords: 1, rejectedRecords: 3 });
    await assertArchived(dir, 'index.json', raw);
    expect(await fs.readFile(path.join(dir, 'images', 'orphan.png'), 'utf8')).toBe('original');
    const archives = await fs.readdir(path.join(dir, 'recovery', 'index.json'));
    await new ImageArtifactStore(dir, 0).initialize();
    expect(await fs.readdir(path.join(dir, 'recovery', 'index.json'))).toEqual(archives);
  });

  it.each(['index.json.bak.1', 'index.json.tmp-interrupted'])('restores a missing main file from %s', async source => {
    const dir = await directory();
    const raw = JSON.stringify({ artifacts: [artifact()] });
    await fs.writeFile(path.join(dir, source), raw);
    const store = records(dir);
    await store.initialize();
    expect(store.values.size).toBe(1);
    expect(store.getStatus().reason).toBe('backup_restored');
    await assertArchived(dir, 'index.json', raw);
  });

  it('prefers a complete backup before partial salvage, using the newest valid candidate', async () => {
    const dir = await directory();
    const main = JSON.stringify({ artifacts: [artifact('main'), { invalid: true }] });
    await fs.writeFile(path.join(dir, 'index.json'), main);
    await fs.writeFile(path.join(dir, 'index.json.bak.1'), JSON.stringify({ artifacts: [artifact('old')] }));
    await fs.utimes(path.join(dir, 'index.json.bak.1'), new Date(0), new Date(0));
    await fs.writeFile(path.join(dir, 'index.json.tmp-new'), JSON.stringify({ artifacts: [artifact('new')] }));
    await fs.writeFile(path.join(dir, 'index.json.bak.2'), 'broken');
    const store = records(dir);
    await store.initialize();
    expect([...store.values.keys()]).toEqual(['new']);
    await assertArchived(dir, 'index.json', main);
  });

  it('does not merge backup records back into a partially valid main file', async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ artifacts: [artifact('main'), {}] }));
    await fs.writeFile(path.join(dir, 'index.json.bak.1'), JSON.stringify({ artifacts: [artifact('deleted'), {}] }));
    const store = records(dir);
    await store.initialize();
    expect([...store.values.keys()]).toEqual(['main']);
  });

  it.each(filenames)('isolates unrecoverable future version in %s without overwriting it', async file => {
    const dir = await directory();
    const raw = JSON.stringify({ schemaVersion: 99, [keys[filenames.indexOf(file)]]: [] });
    await fs.writeFile(path.join(dir, file), raw);
    await fs.writeFile(path.join(dir, `${file}.bak.1`), JSON.stringify({ [keys[filenames.indexOf(file)]]: [] }));
    const coordinator = new ImagePersistenceCoordinator(dir);
    await expect(coordinator.initialize()).resolves.toBeUndefined();
    expect(coordinator.getStatus().available).toBe(false);
    expect(coordinator.getStatus().stores.filter(store => store.state === 'unavailable')).toMatchObject([{ reason: 'future_version' }]);
    expect(await fs.readFile(path.join(dir, file), 'utf8')).toBe(raw);
  });

  it.each(filenames)('recovers %s and completes optional module initialization', async file => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, file), 'broken');
    const coordinator = new ImagePersistenceCoordinator(dir);
    await coordinator.initialize();
    expect(coordinator.getStatus().available).toBe(true);
    expect(coordinator.getStatus().stores.filter(store => store.state === 'recovered')).toHaveLength(1);
    await assertArchived(dir, file, 'broken');
  });

  it('preserves a history record whose identity collides with a reconciliation id', async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ artifacts: [artifact()] }));
    const old = { id: 'rx-good', artifactId: 'different', direction: 'rx', family: 'sstv', occurredAt: 1, saveReason: 'manual', complete: true };
    await fs.writeFile(path.join(dir, 'history.json'), JSON.stringify({ records: [old] }));
    const coordinator = new ImagePersistenceCoordinator(dir);
    await coordinator.initialize();
    expect(coordinator.getStatus().available).toBe(true);
    expect(coordinator.history.get('rx-good')?.artifactId).toBe('different');
    expect(coordinator.history.list().records.map(record => record.artifactId).sort()).toEqual(['different', 'good']);
  });

  it('round-trips all five stores and migrates legacy template/background records', async () => {
    const dir = await directory();
    const legacyTemplate = { id: 'old-template', operatorId: 'op', name: 'Old', layers: [], createdAt: 1, updatedAt: 1, backgroundArtifactId: 'old' };
    await fs.writeFile(path.join(dir, 'templates.json'), JSON.stringify({ templates: [legacyTemplate] }));
    await fs.writeFile(path.join(dir, 'composer-backgrounds.json'), JSON.stringify({ backgrounds: [{ operatorId: 'old', width: 2, height: 2, updatedAt: 1, imageUrl: '/old' }] }));
    const first = new ImagePersistenceCoordinator(dir);
    await first.initialize();
    expect(first.getStatus().available).toBe(true);
    const saved = await first.artifacts.save({ family: 'sstv', direction: 'rx', codecMode: 'robot36', pixelFormat: 'rgb8', width: 2, height: 2, pixels: new Uint8Array(12), frequency: null, complete: true });
    await first.history.recordReceived(saved);
    await first.templates.save('op', { id: 'template', name: 'New', layers: [] });
    await first.backgrounds.save('op', PNG.sync.write(new PNG({ width: 2, height: 2 })));
    await first.preferences.save('op', { enhancedPreamble: false, stationIdMode: 'cw' });
    const second = new ImagePersistenceCoordinator(dir);
    await second.initialize();
    expect(second.getStatus().available).toBe(true);
    expect(second.artifacts.get(saved.id)).toEqual(saved);
    expect(second.history.list().records).toHaveLength(1);
    expect(second.templates.list('op').some(item => item.id === 'old-template')).toBe(true);
    expect(second.templates.list('op').some(item => item.id === 'template')).toBe(true);
    expect(second.backgrounds.get('old')?.assetId).toBeUndefined();
    expect(second.backgrounds.get('op')?.assetId).toMatch(/^[a-f0-9]{64}$/);
    expect(second.preferences.get('op').stationIdMode).toBe('cw');
    for (const file of filenames) expect(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')).schemaVersion).toBe(1);
  });
});

describe('image persistence failure safety', () => {
  it.each(['EACCES', 'EBUSY', 'EIO'])('does not interpret %s as missing data', async code => {
    const dir = await directory();
    const file = path.join(dir, 'index.json');
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(((target: string, ...args: unknown[]) => {
      if (target === file) return Promise.reject(Object.assign(new Error('blocked'), { code }));
      return (read as (...args: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.readFile);
    const writer = vi.spyOn(SafeFileWriter.prototype, 'writeFile');
    const store = records(dir);
    await expect(store.initialize()).rejects.toMatchObject({ code });
    expect(writer).not.toHaveBeenCalled();
    expect(store.getStatus().state).toBe('unavailable');
  });

  it.each(['archive', 'report', 'replace'])('preserves the main file when %s fails', async stage => {
    const dir = await directory();
    const file = path.join(dir, 'index.json');
    await fs.writeFile(file, 'broken');
    const write = SafeFileWriter.prototype.writeFile;
    vi.spyOn(SafeFileWriter.prototype, 'writeFile').mockImplementation(function (this: SafeFileWriter, target, ...args) {
      if (stage === 'archive' && target.endsWith('.original') || stage === 'report' && target.endsWith('.report.json') || stage === 'replace' && target === file) {
        return Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' }));
      }
      return write.call(this, target, ...args);
    });
    const store = records(dir);
    await expect(store.initialize()).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await fs.readFile(file, 'utf8')).toBe('broken');
    expect(store.getStatus().state).toBe('unavailable');
  });

  it('publishes only committed mutations and serializes concurrent updates', async () => {
    const dir = await directory();
    const store = records(dir);
    await store.initialize();
    const write = vi.spyOn(SafeFileWriter.prototype, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.transaction(next => next.set('lost', artifact('lost')))).rejects.toThrow('disk full');
    expect(store.values.size).toBe(0);
    write.mockRestore();
    await Promise.all(['one', 'two'].map(id => store.transaction(next => next.set(id, artifact(id)))));
    expect([...store.values.keys()]).toEqual(['one', 'two']);
    await expect(store.transaction(next => next.set('bad', { ...artifact('bad'), frequency: 0 }))).rejects.toThrow('INVALID_WRITE');
    const restored = records(dir);
    await restored.initialize();
    expect([...restored.values.keys()]).toEqual(['one', 'two']);
  });

  it('keeps the PNG and metadata when deletion cannot commit', async () => {
    const dir = await directory();
    const store = new ImageArtifactStore(dir);
    const saved = await store.save({ family: 'sstv', direction: 'rx', codecMode: 'robot36', pixelFormat: 'rgb8', width: 2, height: 2, pixels: new Uint8Array(12), frequency: null, complete: true });
    vi.spyOn(SafeFileWriter.prototype, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.delete(saved.id)).rejects.toThrow('disk full');
    expect(store.get(saved.id)).toEqual(saved);
    expect((await store.readImage(saved.id)).length).toBeGreaterThan(0);
  });
});
