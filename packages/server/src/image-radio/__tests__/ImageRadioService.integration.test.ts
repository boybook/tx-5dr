import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it } from 'vitest';
import { SstvEncoder } from 'rasterwave-node';

import { ImageArtifactStore } from '../ImageArtifactStore.js';
import { ImageHistoryStore } from '../ImageHistoryStore.js';
import { ImageRadioService } from '../ImageRadioService.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeAudioStream extends EventEmitter<{ audioData: (samples: Float32Array, sampleRate: number) => void }> {
  readonly playback = new FakePlayback();
  getInternalSampleRate() { return 12_000; }
  openDeterministicPlayback(options?: { onPlaybackChunk?: (samples: Float32Array, sampleRate: number) => void }) {
    this.playback.configure(options);
    return this.playback;
  }
}

class FakePlayback {
  readonly sampleRate = 12_000;
  readonly frameSamples = 1_200;
  queuedAudioMs = 0;
  private started = false;
  private chunks: Float32Array[] = [];
  private options?: { onPlaybackChunk?: (samples: Float32Array, sampleRate: number) => void };
  configure(options?: { onPlaybackChunk?: (samples: Float32Array, sampleRate: number) => void }) { this.options = options; }
  async write(samples: Float32Array) {
    const chunk = new Float32Array(samples);
    if (!this.started) {
      this.chunks.push(chunk);
      this.queuedAudioMs += chunk.length / this.sampleRate * 1_000;
      return;
    }
    this.options?.onPlaybackChunk?.(chunk, this.sampleRate);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  async start() {
    this.started = true;
    for (const chunk of this.chunks.splice(0)) this.options?.onPlaybackChunk?.(chunk, this.sampleRate);
    this.queuedAudioMs = 0;
  }
  async end() { this.queuedAudioMs = 0; this.started = false; }
  async abort() { this.queuedAudioMs = 0; this.started = false; this.chunks = []; }
}

class FakePhysicalTx {
  private phase = 'idle';
  private leaseId: string | undefined;
  getSnapshot() { return { phase: this.phase, leaseId: this.leaseId }; }
  async acquireLease() { this.phase = 'keying'; this.leaseId = 'lease'; return this.leaseId; }
  markStreamingLeaseActive() { this.phase = 'active'; }
  markStreamingLeaseDraining() { this.phase = 'draining'; }
  async releaseLease() { this.phase = 'idle'; this.leaseId = undefined; return { success: true, physicalConfirmed: true }; }
  async forceInterrupt() { this.phase = 'idle'; this.leaseId = undefined; }
}

describe('ImageRadioService native streaming integration', () => {
  it('emits Robot 36 rows before EOF and persists the completed image', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-service-'));
    dirs.push(dir);
    const audio = new FakeAudioStream();
    const store = new ImageArtifactStore(dir);
    const history = new ImageHistoryStore(dir);
    const physicalTx = { getSnapshot: () => ({ phase: 'idle' }) };
    const service = new ImageRadioService(audio as never, store, history, physicalTx as never, () => 14_230_000, () => 'USB');
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
    expect(history.list({ family: 'sstv', direction: 'rx' }).records).toHaveLength(1);
    await encoder.dispose();
    await service.stop();
  }, 15_000);

  it('starts fixed FAX reception immediately and emits a row without APT', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-service-'));
    dirs.push(dir);
    const audio = new FakeAudioStream();
    const store = new ImageArtifactStore(dir);
    const history = new ImageHistoryStore(dir);
    const physicalTx = { getSnapshot: () => ({ phase: 'idle' }) };
    const service = new ImageRadioService(audio as never, store, history, physicalTx as never, () => 9_108_100, () => 'USB');
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
    expect(history.list({ family: 'fax', direction: 'rx' }).records).toHaveLength(1);
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
    const history = new ImageHistoryStore(dir);
    const physicalTx = { getSnapshot: () => ({ phase: 'idle' }) };
    const service = new ImageRadioService(audio as never, store, history, physicalTx as never, () => 14_230_000, () => 'USB');
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

  it('adds a transmit history record only after SSTV reaches on-air and completes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-service-'));
    dirs.push(dir);
    const audio = new FakeAudioStream();
    const store = new ImageArtifactStore(dir);
    const history = new ImageHistoryStore(dir);
    const physicalTx = new FakePhysicalTx();
    const service = new ImageRadioService(audio as never, store, history, physicalTx as never, () => 14_230_000, () => 'USB');
    const paperStarted = new Promise<void>((resolve) => {
      service.on('rxEvent', (event) => { if (event.type === 'paperStarted') resolve(); });
    });
    await service.start('sstv');
    for (let index = 0; index < 3; index += 1) audio.emit('audioData', new Float32Array(1_200), 12_000);
    await Promise.race([paperStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('provisional paper timeout')), 5_000))]);
    expect(service.getStatus()).toMatchObject({ rxState: 'receiving', rxCaptureActive: false });
    await service.configureSstvReceive({ family: 'sstv', strategy: 'manual', mode: 'robot36' });
    const artifact = await store.save({
      family: 'sstv', direction: 'tx', operatorId: 'op', codecMode: 'robot8Bw', pixelFormat: 'rgb8',
      width: 160, height: 120, pixels: new Uint8Array(160 * 120 * 3),
      frequency: 14_230_000, radioMode: 'USB', complete: true,
    });
    const completed = new Promise<void>((resolve) => {
      service.on('txStatus', (status) => { if (status.phase === 'completed') resolve(); });
    });
    const rxEvents: Array<{ type: string; boundary?: { kind: string; source?: string; lineIndex: number }; rows?: Array<{ rowIndex: number }> }> = [];
    service.on('rxEvent', (event) => rxEvents.push(event));

    const rejected = await service.startSstvTx({
      requestId: 'tx-rejected', operatorId: 'op', artifactId: artifact.id,
      mode: 'robot8Bw', expectedFrequency: 14_231_000,
    });
    expect(rejected.accepted).toBe(false);
    expect(history.list({ direction: 'tx', txOperatorId: 'op' }).records).toHaveLength(0);

    const result = await service.startSstvTx({
      requestId: 'tx-1', operatorId: 'op', artifactId: artifact.id,
      mode: 'robot8Bw', expectedFrequency: 14_230_000,
    });
    expect(result.accepted).toBe(true);
    await Promise.race([completed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSTV TX timeout')), 5_000))]);

    expect(history.list({ direction: 'tx', txOperatorId: 'op' }).records).toHaveLength(1);
    expect(history.list({ direction: 'tx', txOperatorId: 'op' }).records[0]).toMatchObject({
      artifactId: artifact.id, direction: 'tx', outcome: 'completed', operatorId: 'op',
    });
    const txStart = rxEvents.find((event) => event.type === 'boundary' && event.boundary?.kind === 'localTxStart')?.boundary;
    const txEnd = rxEvents.find((event) => event.type === 'boundary' && event.boundary?.kind === 'localTxEnd')?.boundary;
    expect(txStart).toMatchObject({ source: 'localTx', codecMode: 'robot8Bw' });
    expect(txEnd).toMatchObject({ source: 'rx', codecMode: 'robot36' });
    expect(txEnd!.lineIndex).toBeGreaterThan(txStart!.lineIndex);
    expect(rxEvents.some((event) => event.type === 'rows' && event.rows?.some((row) => row.rowIndex >= txStart!.lineIndex && row.rowIndex < txEnd!.lineIndex))).toBe(true);
    expect(service.getStatus().receiveProfile).toEqual({ family: 'sstv', strategy: 'manual', mode: 'robot36' });
    expect(store.list({ family: 'sstv', direction: 'rx' })).toHaveLength(0);
    await service.stop();
  }, 10_000);

  it('requires confirmation to interrupt a trusted receive capture before transmitting', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-service-'));
    dirs.push(dir);
    const audio = new FakeAudioStream();
    const store = new ImageArtifactStore(dir);
    const history = new ImageHistoryStore(dir);
    const physicalTx = new FakePhysicalTx();
    const service = new ImageRadioService(audio as never, store, history, physicalTx as never, () => 14_230_000, () => 'USB');
    await service.start('sstv');
    const transmitArtifact = await store.save({
      family: 'sstv', direction: 'tx', operatorId: 'op', codecMode: 'robot8Bw', pixelFormat: 'rgb8',
      width: 160, height: 120, pixels: new Uint8Array(160 * 120 * 3),
      frequency: 14_230_000, radioMode: 'USB', complete: true,
    });
    let trustedBoundarySeen = false;
    let resolveDiscontinuity!: () => void;
    const discontinuityAfterTx = new Promise<void>((resolve) => { resolveDiscontinuity = resolve; });
    service.on('rxEvent', (event) => {
      if (event.type === 'boundary' && event.boundary.trusted) trustedBoundarySeen = true;
      if (event.type === 'boundary' && event.boundary.kind === 'discontinuity') resolveDiscontinuity();
    });
    const incoming = new SstvEncoder(new Uint8Array(160 * 120 * 3), 'robot8Bw', 12_000);
    while (!incoming.isFinished && !trustedBoundarySeen) {
      audio.emit('audioData', await incoming.readSamples(1_200), 12_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect(trustedBoundarySeen).toBe(true);
    expect(service.getStatus().rxCaptureActive).toBe(true);

    const rejected = await service.startSstvTx({
      requestId: 'tx-confirm-required', operatorId: 'op', artifactId: transmitArtifact.id,
      mode: 'robot8Bw', expectedFrequency: 14_230_000,
    });
    expect(rejected).toMatchObject({ accepted: false, errorCode: 'IMAGE_RX_CAPTURE_CONFIRM_REQUIRED' });

    const completed = new Promise<void>((resolve) => {
      service.on('txStatus', (status) => { if (status.phase === 'completed') resolve(); });
    });
    const accepted = await service.startSstvTx({
      requestId: 'tx-confirmed', operatorId: 'op', artifactId: transmitArtifact.id,
      mode: 'robot8Bw', expectedFrequency: 14_230_000, interruptActiveCapture: true,
    });
    expect(accepted.accepted).toBe(true);
    expect(service.getStatus().rxCaptureActive).toBe(false);
    await Promise.race([completed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('confirmed SSTV TX timeout')), 5_000))]);
    for (let index = 0; index < 3; index += 1) audio.emit('audioData', new Float32Array(1_200), 12_000);
    await Promise.race([discontinuityAfterTx, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('post-TX discontinuity timeout')), 5_000))]);
    expect(service.getStatus().receiveProfile).toEqual({ family: 'sstv', strategy: 'auto' });

    await incoming.dispose();
    await service.stop();
  }, 15_000);
});
