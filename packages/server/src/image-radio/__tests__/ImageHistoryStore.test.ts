import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImageArtifactStore } from '../ImageArtifactStore.js';
import { ImageHistoryStore } from '../ImageHistoryStore.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ImageHistoryStore', () => {
  it('backfills received artifacts without treating transmit drafts as sent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-history-'));
    dirs.push(dir);
    const artifacts = new ImageArtifactStore(dir);
    const received = await artifacts.save({
      family: 'sstv', direction: 'rx', codecMode: 'robot36', pixelFormat: 'rgb8',
      width: 1, height: 1, pixels: new Uint8Array(3), frequency: 14_230_000,
      complete: true, saveReason: 'protocolEnd',
    });
    await artifacts.save({
      family: 'sstv', direction: 'tx', operatorId: 'op', codecMode: 'robot36', pixelFormat: 'rgb8',
      width: 1, height: 1, pixels: new Uint8Array(3), frequency: 14_230_000, complete: true,
    });
    const history = new ImageHistoryStore(dir);

    await history.reconcileReceivedArtifacts(artifacts.listAll());

    const page = history.list({ direction: 'all', includeAllTx: true });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ artifactId: received.id, direction: 'rx', saveReason: 'protocolEnd' });
  });

  it('records actual on-air transmissions and persists their terminal outcome', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-history-'));
    dirs.push(dir);
    const artifacts = new ImageArtifactStore(dir);
    const artifact = await artifacts.save({
      family: 'sstv', direction: 'tx', operatorId: 'op', codecMode: 'robot36', pixelFormat: 'rgb8',
      width: 1, height: 1, pixels: new Uint8Array(3), frequency: 14_230_000, complete: true,
    });
    const history = new ImageHistoryStore(dir);
    const started = await history.recordTransmitStarted({ artifact, operatorId: 'op', sessionId: 'session', startedAt: 100 });
    await history.finishTransmit(started.id, 'completed');

    const restored = new ImageHistoryStore(dir);
    await restored.initialize();
    expect(restored.get(started.id)).toMatchObject({ direction: 'tx', outcome: 'completed', startedAt: 100 });
    expect(restored.list({ direction: 'tx', txOperatorId: 'other' }).records).toHaveLength(0);
    expect(restored.list({ direction: 'tx', txOperatorId: 'op' }).records).toHaveLength(1);
  });

  it('uses a stable cursor across mixed receive and transmit records', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-history-'));
    dirs.push(dir);
    const artifacts = new ImageArtifactStore(dir);
    const history = new ImageHistoryStore(dir);
    for (let index = 0; index < 3; index += 1) {
      const artifact = await artifacts.save({
        family: 'sstv', direction: 'tx', operatorId: 'op', codecMode: 'robot36', pixelFormat: 'rgb8',
        width: 1, height: 1, pixels: new Uint8Array(3), frequency: 14_230_000, complete: true,
      });
      await history.recordTransmitStarted({ artifact, operatorId: 'op', sessionId: `session-${index}`, startedAt: 100 + index });
    }

    const first = history.list({ direction: 'all', txOperatorId: 'op', limit: 2 });
    const second = history.list({ direction: 'all', txOperatorId: 'op', limit: 2, cursor: first.nextCursor });

    expect(first.records.map((record) => record.occurredAt)).toEqual([102, 101]);
    expect(second.records.map((record) => record.occurredAt)).toEqual([100]);
  });
});
