import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SstvTxStartCommand } from '@tx5dr/contracts';

import { ImageRadioService } from '../ImageRadioService.js';
import { PhysicalTxCoordinator } from '../../transmission/PhysicalTxCoordinator.js';

class FakeDecoder {
  queuedSamples = 0;
  pushF32() { return true; }
  async drain() {}
  async finish() {}
  async dispose() {}
}

class FakeEncoder {
  isFinished = false;
  progress = { estimatedTotalSamples: 4800, rasterEndSample: 4800, stage: 'raster', currentRow: 0 };
  private emitted = 0;
  async readSamples(count: number) {
    this.emitted += count;
    this.isFinished = this.emitted >= 4800;
    return new Float32Array(count).fill(0.5);
  }
  async dispose() {}
}

async function harness(local = true) {
  let localConfigured = local;
  let connected = false;
  const frequency = local ? null : 14_230_000;
  const artifact = { id: 'image', direction: 'tx', operatorId: 'op', width: 2, height: 2, frequency };
  const artifacts = {
    initialize: vi.fn(async () => undefined), get: () => artifact,
    readRgbPixels: vi.fn(async () => ({ artifact, pixels: new Uint8Array(12) })),
  };
  const history = { recordTransmitStarted: vi.fn(async () => undefined), finishTransmit: vi.fn(async () => undefined) };
  let observe: ((samples: Float32Array, rate: number) => void) | undefined;
  const chunks: Float32Array[] = [];
  let started = false;
  const playback = {
    sampleRate: 12_000, frameSamples: 1200, queuedAudioMs: 0,
    write: vi.fn(async (samples: Float32Array) => {
      if (started) observe?.(samples, 12_000);
      else { chunks.push(samples); playback.queuedAudioMs += samples.length / 12; }
    }),
    start: vi.fn(async () => { started = true; for (const chunk of chunks.splice(0)) observe?.(chunk, 12_000); }),
    end: vi.fn(async (): Promise<void> => undefined), abort: vi.fn(async (): Promise<void> => undefined),
  };
  const audio = Object.assign(new EventEmitter(), {
    getInternalSampleRate: () => 12_000,
    openDeterministicPlayback: vi.fn((options) => { observe = options.onPlaybackChunk; return playback; }),
  });
  const setPTT = vi.fn(async () => undefined);
  const coordinator = new PhysicalTxCoordinator({
    isRadioConnected: () => connected, setPTT,
    playAudio: vi.fn(async () => undefined), stopCurrentPlayback: vi.fn(async () => 0),
    prepareAudioPlayback: vi.fn(async () => ({ ready: true, waitedForDrain: false })),
  });
  const session = { sessionId: 'paper', receivedLines: 0, width: 2, revision: 0 };
  const paper = {
    initialize: vi.fn(async () => undefined), reset: vi.fn(async () => undefined),
    getSession: () => session, setGeneration: vi.fn(), addBoundary: vi.fn(),
  };
  const runtime = {
    getAvailability: () => ({ available: true }),
    load: () => ({ sstvModes: () => [{ mode: 'robot36', width: 2, height: 2 }], SstvEncoder: FakeEncoder, SstvDecoder: FakeDecoder }),
  };
  const service = new ImageRadioService(audio as never, artifacts as never, history as never, coordinator,
    () => frequency, () => undefined, () => undefined, runtime as never, paper as never, () => localConfigured);
  await service.start('sstv');
  const command: SstvTxStartCommand = {
    requestId: 'request', operatorId: 'op', artifactId: 'image', mode: 'robot36', expectedFrequency: frequency,
    envelope: { enhancedPreamble: false, stationIdMode: 'none' },
  };
  return { service, command, audio, playback, setPTT, history, coordinator, artifacts,
    setLocal: (value: boolean) => { localConfigured = value; }, setConnected: (value: boolean) => { connected = value; } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('SSTV local audio playback (mocked codec and output)', () => {
  it('rejects a local request on a configured but disconnected radio', async () => {
    const h = await harness(false);
    expect(h.service.getStatus().sstvTxTarget).toBe('radio');
    expect(await h.service.startSstvTx({ ...h.command, expectedFrequency: null })).toMatchObject({ accepted: false, errorCode: 'IMAGE_TX_TARGET_CHANGED' });
    expect(h.audio.openDeterministicPlayback).not.toHaveBeenCalled();
    expect(h.setPTT).not.toHaveBeenCalled();
  });

  it('does not downgrade a radio transmission when its connection is lost', async () => {
    const h = await harness(false);
    await h.service.startSstvTx(h.command);
    await vi.advanceTimersByTimeAsync(350);
    expect(h.service.getStatus().tx.phase).toBe('error');
    expect(h.playback.start).not.toHaveBeenCalled();
    expect(h.setPTT).not.toHaveBeenCalled();
  });

  it('rechecks configuration after output preparation before playback', async () => {
    const h = await harness();
    await h.service.startSstvTx(h.command);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getStatus().tx.phase).toBe('keying');
    h.setLocal(false);
    await vi.advanceTimersByTimeAsync(350);
    expect(h.service.getStatus().tx).toMatchObject({ phase: 'error', errorCode: 'IMAGE_TX_TARGET_CHANGED' });
    expect(h.playback.start).not.toHaveBeenCalled();
    expect(h.setPTT).not.toHaveBeenCalled();
  });

  it('rejects radio-frequency requests in local mode', async () => {
    const h = await harness();
    expect(await h.service.startSstvTx({ ...h.command, expectedFrequency: 14_230_000 })).toMatchObject({ accepted: false, errorCode: 'IMAGE_TX_TARGET_CHANGED' });
    expect(h.audio.openDeterministicPlayback).not.toHaveBeenCalled();
  });

  it('plays PCM and waits for drain before completing history without claiming PTT', async () => {
    const h = await harness();
    let drain!: () => void;
    h.playback.end.mockImplementation(() => new Promise<void>((resolve) => { drain = resolve; }));
    expect(h.service.getStatus().sstvTxTarget).toBe('local');
    expect(await h.service.startSstvTx(h.command)).toMatchObject({ accepted: true });
    expect(h.service.getStatus().tx.samplesEmitted).toBe(0);
    await vi.advanceTimersByTimeAsync(350);
    expect(h.service.getStatus().tx).toMatchObject({ phase: 'draining', target: 'local', samplesEmitted: 4800 });
    expect(h.coordinator.getSnapshot().pttConfirmed).toBe(false);
    expect(h.history.recordTransmitStarted).toHaveBeenCalledOnce();
    expect(h.history.finishTransmit).not.toHaveBeenCalled();
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getStatus().tx.phase).toBe('completed');
    expect(h.history.finishTransmit).toHaveBeenCalledWith(expect.any(String), 'completed');
    expect(h.coordinator.getSnapshot().phase).toBe('idle');
    expect(h.setPTT).not.toHaveBeenCalled();
  });

  it('cancels during preparation without later starting playback', async () => {
    const h = await harness();
    await h.service.startSstvTx(h.command);
    await vi.advanceTimersByTimeAsync(0);
    const tx = h.service.getStatus().tx;
    expect(await h.service.cancelSstvTx({ operatorId: 'op', sessionId: tx.sessionId!, expectedRevision: tx.revision })).toBe(true);
    await vi.advanceTimersByTimeAsync(350);
    expect(h.service.getStatus().tx.phase).toBe('cancelled');
    expect(h.playback.start).not.toHaveBeenCalled();
    expect(h.playback.abort).toHaveBeenCalled();
    expect(h.setPTT).not.toHaveBeenCalled();
  });

  it('rejects unavailable output with an actionable command result', async () => {
    const h = await harness();
    h.audio.openDeterministicPlayback.mockImplementation(() => { throw new Error('audio output stream not started'); });
    expect(await h.service.startSstvTx(h.command)).toMatchObject({ accepted: false, errorCode: 'IMAGE_TX_PLAYBACK_FAILED' });
    expect(h.setPTT).not.toHaveBeenCalled();
    expect(h.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('reports output failure and releases the audio lease', async () => {
    const h = await harness();
    h.playback.start.mockRejectedValue(new Error('output route lost'));
    await h.service.startSstvTx(h.command);
    await vi.advanceTimersByTimeAsync(350);
    expect(h.service.getStatus().tx).toMatchObject({ phase: 'error', errorCode: 'IMAGE_TX_PLAYBACK_FAILED' });
    expect(h.coordinator.getSnapshot().phase).toBe('idle');
    expect(h.setPTT).not.toHaveBeenCalled();
    expect(h.history.recordTransmitStarted).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'output failure'])('interrupts active playback and history on %s', async (action) => {
    const h = await harness();
    let failDrain!: (error: Error) => void;
    h.playback.end.mockImplementation(() => new Promise<void>((_, reject) => { failDrain = reject; }));
    await h.service.startSstvTx(h.command);
    await vi.advanceTimersByTimeAsync(350);
    expect(h.service.getStatus().tx.phase).toBe('draining');
    if (action === 'cancel') {
      h.playback.abort.mockImplementation(async () => { failDrain(new Error('cancelled')); });
      const tx = h.service.getStatus().tx;
      await h.service.cancelSstvTx({ operatorId: 'op', sessionId: tx.sessionId!, expectedRevision: tx.revision });
    } else failDrain(new Error('output disconnected'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getStatus().tx.phase).toBe(action === 'cancel' ? 'cancelled' : 'error');
    expect(h.history.finishTransmit).toHaveBeenCalledWith(expect.any(String), 'interrupted', expect.any(String));
    expect(h.coordinator.getSnapshot().phase).toBe('idle');
    expect(h.setPTT).not.toHaveBeenCalled();
  });

  it('preserves PTT and frequency protection for real-radio requests', async () => {
    const h = await harness(false);
    h.setConnected(true);
    await h.service.startSstvTx(h.command);
    await vi.advanceTimersByTimeAsync(350);
    expect(h.service.getStatus().tx).toMatchObject({ phase: 'completed', target: 'radio' });
    expect(h.setPTT.mock.calls).toEqual([[true], [false]]);
  });
});
