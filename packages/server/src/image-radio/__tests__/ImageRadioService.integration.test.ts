import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it } from 'vitest';
import { SstvEncoder } from 'rasterwave-node';

import { ImageArtifactStore } from '../ImageArtifactStore.js';
import { ImageRadioService } from '../ImageRadioService.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeAudioStream extends EventEmitter<{ audioData: (samples: Float32Array, sampleRate: number) => void }> {
  getInternalSampleRate() { return 12_000; }
}

describe('ImageRadioService native streaming integration', () => {
  it('emits Robot 36 rows before EOF and persists the completed image', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-service-'));
    dirs.push(dir);
    const audio = new FakeAudioStream();
    const store = new ImageArtifactStore(dir);
    const physicalTx = { getSnapshot: () => ({ phase: 'idle' }) };
    const service = new ImageRadioService(audio as never, store, physicalTx as never, () => 14_230_000, () => 'USB');
    const events: Array<{ type: string }> = [];
    let feedingComplete = false;
    let sawRowsBeforeEof = false;
    const completed = new Promise<void>((resolve) => {
      service.on('rxEvent', (event) => {
        events.push(event);
        if (event.type === 'rows' && !feedingComplete) sawRowsBeforeEof = true;
        if (event.type === 'captureSaved') resolve();
      });
    });
    await service.start('sstv');
    const pixels = new Uint8Array(320 * 240 * 3);
    for (let index = 0; index < pixels.length; index += 3) {
      pixels[index] = 32; pixels[index + 1] = 96; pixels[index + 2] = 160;
    }
    const encoder = new SstvEncoder(pixels, 'robot36', 12_000);
    while (!encoder.isFinished) {
      audio.emit('audioData', await encoder.readSamples(1_200), 12_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    for (let index = 0; index < 10; index += 1) {
      audio.emit('audioData', new Float32Array(1_200), 12_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    feedingComplete = true;
    await Promise.race([completed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`decode timeout: ${JSON.stringify({ events: events.map((event) => event.type), status: service.getStatus() })}`)), 10_000))]);
    expect(sawRowsBeforeEof).toBe(true);
    expect(events.some((event) => event.type === 'paperStarted')).toBe(true);
    expect(events.some((event) => event.type === 'boundary')).toBe(true);
    expect(store.list({ family: 'sstv', direction: 'rx' })).toHaveLength(1);
    await encoder.dispose();
    await service.stop();
  }, 15_000);

  it('starts fixed FAX reception immediately and emits a row without APT', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-service-'));
    dirs.push(dir);
    const audio = new FakeAudioStream();
    const store = new ImageArtifactStore(dir);
    const physicalTx = { getSnapshot: () => ({ phase: 'idle' }) };
    const service = new ImageRadioService(audio as never, store, physicalTx as never, () => 9_108_100, () => 'USB');
    const events: Array<{ type: string; detection?: string }> = [];
    const firstRows = new Promise<void>((resolve) => {
      service.on('rxEvent', (event) => {
        events.push(event);
        if (event.type === 'rows') resolve();
      });
    });

    await service.start('fax');
    for (let index = 0; index < 6; index += 1) {
      audio.emit('audioData', new Float32Array(1_200), 12_000);
    }
    await Promise.race([firstRows, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('FAX immediate decode timeout')), 5_000))]);

    expect(service.getStatus().receiveProfile).toEqual({ family: 'fax', strategy: 'auto' });
    expect(events[0]).toMatchObject({ type: 'paperStarted' });
    expect(events.some((event) => event.type === 'rows')).toBe(true);
    const revision = service.getStatus().currentSession!.revision;
    const saved = await service.saveCurrentPaper({ requestId: 'save-fax-1', operatorId: 'op', expectedRevision: revision });
    const repeated = await service.saveCurrentPaper({ requestId: 'save-fax-1', operatorId: 'op', expectedRevision: revision });
    expect(repeated).toEqual(saved);
    expect(store.list({ family: 'fax', direction: 'rx' })).toHaveLength(1);
    service.markSignalLost();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(store.list({ family: 'fax', direction: 'rx' })).toHaveLength(1);
    await service.stop();
  }, 10_000);

  it('switches SSTV from Auto to a forced mode that streams without VIS', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-service-'));
    dirs.push(dir);
    const audio = new FakeAudioStream();
    const store = new ImageArtifactStore(dir);
    const physicalTx = { getSnapshot: () => ({ phase: 'idle' }) };
    const service = new ImageRadioService(audio as never, store, physicalTx as never, () => 14_230_000, () => 'USB');
    const events: Array<{ type: string; detection?: string }> = [];
    const firstRows = new Promise<void>((resolve) => {
      service.on('rxEvent', (event) => {
        events.push(event);
        if (event.type === 'rows') resolve();
      });
    });

    await service.start('sstv');
    expect(service.getStatus().receiveProfile).toEqual({ family: 'sstv', strategy: 'auto' });
    await service.configureSstvReceive({ family: 'sstv', strategy: 'manual', mode: 'robot36' });
    for (let index = 0; index < 3; index += 1) {
      audio.emit('audioData', new Float32Array(1_200), 12_000);
    }
    await Promise.race([firstRows, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSTV immediate decode timeout')), 5_000))]);

    expect(service.getStatus().receiveProfile).toEqual({ family: 'sstv', strategy: 'manual', mode: 'robot36' });
    expect(events[0]).toMatchObject({ type: 'paperStarted' });
    expect(events.some((event) => event.type === 'rows')).toBe(true);
    await service.stop();
  }, 10_000);
});
