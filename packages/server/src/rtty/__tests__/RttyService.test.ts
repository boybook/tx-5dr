import { EventEmitter } from 'eventemitter3';
import { describe, expect, it } from 'vitest';
import { RttyDecoder, RttyEncoder } from 'rasterwave-node';
import { RttyConfigSchema, type RttyConfig, type RttyDecoderEvent, type RttyScanUpdate, type RttyTxStatus } from '@tx5dr/contracts';

import { RttyService } from '../RttyService.js';

const RATE = 12_000;

/**
 * Playback that consumes audio on a virtual clock: every `sleep(ms)` of the
 * service plays `ms` of the queue, so tests run fast and deterministically.
 */
class VirtualPlayback {
  preparation?: 'complete';
  readonly sampleRate = RATE;
  readonly frameSamples = 1_200;
  readonly played: Float32Array[] = [];
  private queue: Float32Array[] = [];
  private queuedSamples = 0;
  started = false;
  aborted = false;
  constructor(private readonly onChunk?: (samples: Float32Array, sampleRate: number) => void) {}
  get queuedAudioMs() { return this.queuedSamples / RATE * 1000; }
  async write(samples: Float32Array) {
    if (this.aborted) throw new Error('aborted');
    this.queue.push(new Float32Array(samples));
    this.queuedSamples += samples.length;
  }
  async start() { this.started = true; }
  consume(ms: number) {
    if (!this.started || this.aborted) return;
    let budget = Math.round(ms * RATE / 1000);
    while (budget > 0 && this.queue.length > 0) {
      const head = this.queue[0]!;
      const take = Math.min(budget, head.length);
      const chunk = head.subarray(0, take);
      this.played.push(chunk);
      this.onChunk?.(chunk, RATE);
      if (take === head.length) this.queue.shift(); else this.queue[0] = head.subarray(take);
      this.queuedSamples -= take;
      budget -= take;
    }
  }
  async end() { this.consume(Number.MAX_SAFE_INTEGER / RATE); }
  async abort() { this.aborted = true; this.queue = []; this.queuedSamples = 0; }
  pcm(): Float32Array {
    const total = this.played.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.played) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }
}

class FakeAudioStream extends EventEmitter<{ audioData: (samples: Float32Array, sampleRate: number) => void }> {
  playback: VirtualPlayback | null = null;
  completePreparation = false;
  readonly playbacks: VirtualPlayback[] = [];
  getInternalSampleRate() { return RATE; }
  openDeterministicPlayback(options: { onPlaybackChunk?: (samples: Float32Array, sampleRate: number) => void }) {
    this.playback = new VirtualPlayback(options.onPlaybackChunk);
    if (this.completePreparation) this.playback.preparation = 'complete';
    this.playbacks.push(this.playback);
    return this.playback;
  }
}

class FakePhysicalTx {
  leases = 0;
  released = 0;
  interrupted: string[] = [];
  interrupt: (() => Promise<void> | void) | null = null;
  async acquireLease(request: { interrupt?: () => Promise<void> | void; validateStart?: () => void }) {
    request.validateStart?.();
    this.interrupt = request.interrupt ?? null;
    this.leases += 1;
    return `lease-${this.leases}`;
  }
  markStreamingLeaseActive() {}
  markStreamingLeaseDraining() {}
  async releaseLease(leaseId: string) {
    this.released += 1;
    return { leaseId, success: true, physicalConfirmed: true, reason: 'ok', source: 'rtty' as const, operatorIds: [] };
  }
  async forceInterruptLease(_leaseId: string, reason: string) {
    this.interrupted.push(reason);
    return null;
  }
}

function harness(overrides: Partial<RttyConfig> = {}) {
  const audio = new FakeAudioStream();
  const physicalTx = new FakePhysicalTx();
  let config = RttyConfigSchema.parse(overrides);
  let frequency: number | null = 14_080_000;
  let clock = 0;
  const statuses: RttyTxStatus[] = [];
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  const service = new RttyService({
    schedule: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    audioStream: audio,
    physicalTx,
    getConfig: () => config,
    getFrequency: () => frequency,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      audio.playback?.consume(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  service.on('txStatus', (status) => statuses.push(status));
  return {
    audio,
    physicalTx,
    service,
    statuses,
    setConfig: (next: Partial<RttyConfig>) => { config = RttyConfigSchema.parse({ ...config, ...next }); },
    setFrequency: (next: number | null) => { frequency = next; },
    advance: (ms: number) => { clock += ms; },
    /** Runs due repeat timers (all pending ones). */
    fireTimers: () => {
      const due = timers.splice(0).filter((timer) => !timer.cancelled);
      for (const timer of due) timer.callback();
      return due.length;
    },
  };
}

async function settle(service: RttyService): Promise<void> {
  for (let i = 0; i < 2_000 && service.getTxStatus().active; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function decodePcm(pcm: Float32Array): Promise<string> {
  const characters: string[] = [];
  const decoder = new RttyDecoder(RATE, null, (event) => {
    if (event.type === 'character') characters.push(event.ch);
  });
  const padded = new Float32Array(pcm.length + RATE);
  padded.set(pcm, RATE / 2);
  for (let offset = 0; offset < padded.length; offset += 1_200) {
    while (!decoder.pushF32(padded.subarray(offset, offset + 1_200))) await decoder.drain();
  }
  await decoder.finish();
  await decoder.dispose();
  return characters.join('').replace(/\r/g, '');
}

describe('RttyService transmit', () => {
  it('streams typed text, reports sent progress and releases the lease after finishing', async () => {
    const { service, audio, physicalTx, statuses } = harness();
    service.start();
    service.append('c1', 'Operator', 'cq cq de bg5drb');
    service.append('c1', 'Operator', ' k', { finishAfter: true });
    await settle(service);

    const finalStatus = service.getTxStatus();
    expect(finalStatus.active).toBe(false);
    expect(finalStatus.phase).toBe('idle');
    expect(finalStatus.error).toBeNull();
    expect(finalStatus.lastText).toBe('CQ CQ DE BG5DRB K');
    expect(physicalTx.released).toBe(1);
    expect(statuses.some((status) => status.phase === 'on_air' && status.sentText.length > 0
      && status.sentText.length < 'CQ CQ DE BG5DRB K'.length)).toBe(true);
    expect((await decodePcm(audio.playback!.pcm())).trim()).toBe('CQ CQ DE BG5DRB K');
    await service.stop('test');
  });

  it('retracts text that has not been committed to audio', async () => {
    const { service, audio } = harness();
    service.start();
    service.append('c1', 'Operator', 'DE BG5DRB TEST MESSAGE ABCDEF');
    expect(service.retract(7)).toBe(7);
    service.finish();
    await settle(service);
    expect((await decodePcm(audio.playback!.pcm())).trim()).toBe('DE BG5DRB TEST MESSAGE');
    await service.stop('test');
  });

  it('{RX} ends the transmission after the text', async () => {
    const { service } = harness();
    service.start();
    service.append('c1', 'Operator', 'TU 73 {RX}');
    await settle(service);
    expect(service.getTxStatus().lastText).toBe('TU 73');
    await service.stop('test');
  });

  it('stops immediately when the owning client disconnects', async () => {
    const { service, physicalTx, audio } = harness();
    service.start();
    service.append('c1', 'Operator', 'CQ CQ CQ CQ CQ CQ CQ CQ CQ CQ');
    for (let i = 0; i < 50 && service.getTxStatus().phase !== 'on_air'; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await service.handleClientDisconnect('other-client');
    expect(service.getTxStatus().active).toBe(true);
    await service.handleClientDisconnect('c1');
    await settle(service);
    expect(service.getTxStatus().active).toBe(false);
    expect(service.getTxStatus().error).toBeNull();
    expect(physicalTx.interrupted).toHaveLength(1);
    expect(audio.playback!.aborted).toBe(true);
    await service.stop('test');
  });

  it('fails closed when the radio frequency changes during transmission', async () => {
    const { service, physicalTx, setFrequency } = harness();
    service.start();
    service.append('c1', 'Operator', 'RYRYRYRYRYRYRYRYRYRYRYRY');
    for (let i = 0; i < 50 && service.getTxStatus().phase !== 'on_air'; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    setFrequency(14_081_000);
    await service.handleOperatingStateChanged('frequency changed');
    await settle(service);
    expect(service.getTxStatus().error).toBe('RTTY_FREQUENCY_CHANGED');
    expect(physicalTx.interrupted).toHaveLength(1);
    await service.stop('test');
  });

  it('enforces the maximum transmission time', async () => {
    const { service, physicalTx } = harness({ maxTransmitSeconds: 10 });
    service.start();
    service.append('c1', 'Operator', 'CQ');
    await settle(service);
    expect(service.getTxStatus().error).toBe('RTTY_MAX_DURATION');
    expect(physicalTx.interrupted).toHaveLength(1);
    await service.stop('test');
  });

  it('queues text typed during a prepared (non-streaming) transmission as the next one', async () => {
    const { service, audio, physicalTx } = harness();
    audio.completePreparation = true;
    service.start();
    service.append('c1', 'Operator', 'FIRST {RX}');
    service.append('c1', 'Operator', 'SECOND');
    for (let i = 0; i < 4_000 && (service.getTxStatus().active || physicalTx.released < 2); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(audio.playbacks).toHaveLength(2);
    expect((await decodePcm(audio.playbacks[0]!.pcm())).trim()).toBe('FIRST');
    expect((await decodePcm(audio.playbacks[1]!.pcm())).trim()).toBe('SECOND');
    await service.stop('test');
  });

  it('refuses to transmit outside RTTY mode', () => {
    const { service } = harness();
    expect(() => service.append('c1', 'Operator', 'CQ')).toThrow(/RTTY mode is not active/);
  });
});

describe('RttyService fail-closed edges', () => {
  async function onAir(service: RttyService) {
    for (let i = 0; i < 200 && service.getTxStatus().phase !== 'on_air'; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it('a stray key (start: false) never queues text for a new transmission while the current one is ending', async () => {
    const { service, physicalTx } = harness();
    service.start();
    service.append('c1', 'Op', 'CQ DE N0CALL K', { finishAfter: true });
    await onAir(service);
    expect(() => service.append('c1', 'Op', 'E', { start: false })).toThrow('RTTY_TX_ENDING');
    await settle(service);
    expect(physicalTx.leases).toBe(1);
    expect(service.getTxStatus().active).toBe(false);
  });

  it('queues text typed after {RX} for the next transmission instead of failing', async () => {
    const { service, audio } = harness();
    service.start();
    service.append('c1', 'Operator', 'FIRST {RX}');
    await onAir(service);
    expect(() => service.append('c1', 'Operator', 'SECOND')).not.toThrow();
    for (let i = 0; i < 4_000 && audio.playbacks.length < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await settle(service);
    expect(audio.playbacks).toHaveLength(2);
    expect((await decodePcm(audio.playbacks[1]!.pcm())).trim()).toBe('SECOND');
    await service.stop('test');
  });

  it('drops queued text when a transmission fails', async () => {
    const { service, audio, setFrequency } = harness();
    audio.completePreparation = true;
    service.start();
    service.append('c1', 'Operator', 'RYRYRYRYRYRY {RX}');
    await onAir(service);
    service.append('c1', 'Operator', 'QUEUED');
    setFrequency(7_040_000);
    await service.handleOperatingStateChanged('frequency changed');
    await settle(service);
    expect(service.getTxStatus().pendingText).toBe('');
    setFrequency(14_080_000);
    service.append('c2', 'Other', 'NEW {RX}');
    await settle(service);
    for (let i = 0; i < 200; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const texts = await Promise.all(audio.playbacks.map(async (playback) => (await decodePcm(playback.pcm())).trim()));
    // The interrupted transmission's queued text never reaches the air.
    expect(texts.join(' ')).not.toContain('QUEUED');
    expect(texts[texts.length - 1]).toBe('NEW');
    await service.stop('test');
  });

  it('refuses prepared transmissions longer than the maximum duration', async () => {
    const { service, audio } = harness({ maxTransmitSeconds: 10 });
    audio.completePreparation = true;
    service.start();
    service.append('c1', 'Operator', 'RY'.repeat(200));
    await settle(service);
    expect(service.getTxStatus().error).toBe('RTTY_MAX_DURATION');
    expect(audio.playback!.started).toBe(false);
    await service.stop('test');
  });

  it('stops producing audio when the transmission coordinator interrupts', async () => {
    const { service, physicalTx, audio } = harness();
    service.start();
    service.append('c1', 'Operator', 'CQ CQ CQ CQ CQ CQ');
    await onAir(service);
    await physicalTx.interrupt?.();
    await settle(service);
    expect(service.getTxStatus().error).toBe('RTTY_TX_INTERRUPTED');
    expect(audio.playback!.aborted).toBe(true);
    await service.stop('test');
  });

  it('lets only the owning client edit the buffer, and hands ownership to the latest typist', async () => {
    const { service } = harness();
    service.start();
    service.append('c1', 'Operator', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(service.retract(2, 'c2')).toBe(0);
    expect(service.retract(2, 'c1')).toBe(2);
    service.append('c2', 'Other', 'XY');
    expect(service.isOwner('c2')).toBe(true);
    await service.handleClientDisconnect('c1');
    expect(service.getTxStatus().active).toBe(true);
    await service.handleClientDisconnect('c2');
    await settle(service);
    expect(service.getTxStatus().active).toBe(false);
    await service.stop('test');
  });

  it('records the operator on the physical lease', async () => {
    const { service, physicalTx } = harness();
    const requests: Array<{ operatorIds?: string[] }> = [];
    const original = physicalTx.acquireLease.bind(physicalTx);
    physicalTx.acquireLease = async (request) => { requests.push(request as { operatorIds?: string[] }); return original(request); };
    service.start();
    service.append('c1', 'Operator', 'TEST {RX}', { operatorId: 'op-1' });
    await settle(service);
    expect(requests[0]?.operatorIds).toEqual(['op-1']);
    await service.stop('test');
  });
});

/** Text of the latest transcript session as a client would show it. */
function sessionText(events: RttyDecoderEvent[]): string {
  let sessionId: string | null = null;
  let text = '';
  for (const event of events) {
    if (event.kind === 'reset') { sessionId = event.sessionId; text = ''; continue; }
    if (sessionId !== null && event.sessionId !== sessionId) continue;
    text += event.characters.map((character) => character.ch).join('');
  }
  return text;
}

async function feed(audio: FakeAudioStream, samples: Float32Array, advance: (ms: number) => void) {
  audio.emit('audioData', samples, RATE);
  advance(100);
  await new Promise((resolve) => setTimeout(resolve, 1));
}

describe('RttyService receive', () => {
  it('decodes received audio into character batches with wall-clock times', async () => {
    const { service, audio, advance } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    let lockedSeen = false;
    service.on('decoderStatus', (status) => { lockedSeen ||= status.signal?.locked === true; });
    service.start();
    const encoder = new RttyEncoder(RATE);
    encoder.pushText('CQ CQ DE N0CALL K\n');
    encoder.finish();
    const silence = new Float32Array(RATE / 2);
    audio.emit('audioData', silence, RATE);
    // Deliver audio at a paced rate, as a sound card would.
    while (!encoder.isFinished) {
      audio.emit('audioData', encoder.readSamples(1_200).samples, RATE);
      advance(100);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    for (let i = 0; i < 20; i += 1) {
      audio.emit('audioData', new Float32Array(1_200), RATE);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const text = events
      .filter((event): event is Extract<RttyDecoderEvent, { kind: 'characters' }> => event.kind === 'characters')
      .flatMap((event) => event.characters.map((character) => character.ch))
      .join('');
    expect(text.trim()).toBe('CQ CQ DE N0CALL K');
    expect(service.getDecoderStatus().state).toBe('listening');
    expect(lockedSeen).toBe(true);
    await service.stop('test');
  });
  it('re-decodes the recent audio after retuning and keeps only newer live text', async () => {
    const { service, audio, advance, setConfig } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    // The signal sits at 1500 Hz while the receiver listens at 2210 Hz.
    const encoder = new RttyEncoder(RATE, { markHz: 1_415, spaceHz: 1_585 });
    encoder.pushText('RYRY DE N0CALL QTH TEST K\n');
    encoder.finish();
    audio.emit('audioData', new Float32Array(RATE / 2), RATE);
    while (!encoder.isFinished) {
      audio.emit('audioData', encoder.readSamples(1_200).samples, RATE);
      advance(100);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    for (let i = 0; i < 10; i += 1) {
      audio.emit('audioData', new Float32Array(1_200), RATE);
      advance(100);
    }
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const before = events.length;

    const previous = RttyConfigSchema.parse({});
    setConfig({ centerHz: 1_500 });
    await service.applyConfig(RttyConfigSchema.parse({ centerHz: 1_500 }), previous);

    const after = events.slice(before);
    // The original text stays: no new transcript, the replay is an extra block.
    expect(after.some((event) => event.kind === 'reset')).toBe(false);
    const replay = after.find((event): event is Extract<RttyDecoderEvent, { kind: 'characters' }> => event.kind === 'characters' && event.replay === true);
    expect(replay?.replayFrom).toBeLessThan(1_000);
    const text = replay!.characters.map((character) => character.ch).join('');
    expect(text).toContain('DE N0CALL QTH TEST K');
    // Replayed characters keep the wall-clock time of the original audio.
    expect(replay!.characters[0]!.at).toBeLessThan(5_000);
    expect(service.getTelemetry().rx.replays).toBe(1);
    expect(service.getTelemetry().rx.historySeconds).toBeGreaterThan(4);
    await service.stop('test');
  });

  it('does not replay when nothing affecting decoding changed', async () => {
    const { service, audio } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    audio.emit('audioData', new Float32Array(RATE), RATE);
    const previous = RttyConfigSchema.parse({});
    await service.applyConfig(RttyConfigSchema.parse({ afc: !previous.afc }), previous);
    expect(events.some((event) => event.kind === 'reset')).toBe(false);
    await service.stop('test');
  });
  it('hands over to the replay decoder without losing or repeating text while audio keeps arriving', async () => {
    const message = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789 K';
    for (const switchAt of [25, 37]) {
      const { service, audio, advance, setConfig } = harness();
      const events: RttyDecoderEvent[] = [];
      service.on('decoderEvent', (event) => events.push(event));
      service.start();
      const encoder = new RttyEncoder(RATE, { markHz: 1_415, spaceHz: 1_585 });
      encoder.pushText(`${message}\n`);
      encoder.finish();
      await feed(audio, new Float32Array(RATE / 2), advance);
      let chunks = 0;
      let applying: Promise<void> | null = null;
      while (!encoder.isFinished) {
        if (chunks === switchAt) {
          const previous = RttyConfigSchema.parse({});
          setConfig({ centerHz: 1_500 });
          applying = service.applyConfig(RttyConfigSchema.parse({ centerHz: 1_500 }), previous);
        }
        await feed(audio, encoder.readSamples(1_200).samples, advance);
        chunks += 1;
      }
      await applying;
      for (let i = 0; i < 15; i += 1) await feed(audio, new Float32Array(1_200), advance);
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      // Replay block + live text after it read as one continuous message.
      const replayIndex = events.findIndex((event) => event.kind === 'characters' && event.replay === true);
      expect(replayIndex).toBeGreaterThanOrEqual(0);
      expect(sessionText(events.slice(replayIndex)).trim()).toBe(message);
      await service.stop('test');
    }
  });

  it('does not bring cleared text back on a later re-decode', async () => {
    const { service, audio, advance } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    const encoder = new RttyEncoder(RATE);
    encoder.pushText('SECRET OLD TEXT K\n');
    encoder.finish();
    while (!encoder.isFinished) await feed(audio, encoder.readSamples(1_200).samples, advance);
    for (let i = 0; i < 10; i += 1) await feed(audio, new Float32Array(1_200), advance);
    service.clearTranscript();
    const previous = RttyConfigSchema.parse({});
    await service.applyConfig(RttyConfigSchema.parse({ squelch: 0.1 }), previous);
    expect(sessionText(events)).not.toContain('SECRET');
    await service.stop('test');
  });

  it('does not re-decode for a sideband change', async () => {
    const { service, audio } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    audio.emit('audioData', new Float32Array(RATE), RATE);
    const previous = RttyConfigSchema.parse({});
    await service.applyConfig(RttyConfigSchema.parse({ sideband: 'usb' }), previous);
    expect(events.some((event) => event.kind === 'characters' && event.replay === true)).toBe(false);
    await service.stop('test');
  });

  it('rebuilds the decoder from the history when the baud rate changes', async () => {
    const { service, audio, advance, setConfig } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    const encoder = new RttyEncoder(RATE, { baud: 50 });
    encoder.pushText('FIFTY BAUD TEXT K\n');
    encoder.finish();
    while (!encoder.isFinished) await feed(audio, encoder.readSamples(1_200).samples, advance);
    for (let i = 0; i < 10; i += 1) await feed(audio, new Float32Array(1_200), advance);
    const previous = RttyConfigSchema.parse({});
    setConfig({ baud: 50 });
    await service.applyConfig(RttyConfigSchema.parse({ baud: 50 }), previous);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sessionText(events)).toContain('FIFTY BAUD TEXT K');
    await service.stop('test');
  });
  it('lists RTTY signals across the passband with a decoded preview', async () => {
    const { service, audio, advance } = harness();
    const updates: RttyScanUpdate[] = [];
    service.on('scanUpdate', (update) => updates.push(update));
    service.start();
    const a = new RttyEncoder(RATE, { markHz: 915, spaceHz: 1_085 });
    const b = new RttyEncoder(RATE, { markHz: 2_125, spaceHz: 2_295 });
    a.pushText('CQ CQ DE JA1AAA JA1AAA K CQ CQ DE JA1AAA K\n');
    b.pushText('CQ TEST DE W1AW W1AW TEST CQ TEST DE W1AW K\n');
    a.finish();
    b.finish();
    while (!a.isFinished || !b.isFinished) {
      const sa = a.isFinished ? new Float32Array(1_200) : a.readSamples(1_200).samples;
      const sb = b.isFinished ? new Float32Array(1_200) : b.readSamples(1_200).samples;
      const mixed = new Float32Array(1_200);
      for (let i = 0; i < mixed.length; i += 1) mixed[i] = 0.5 * ((sa[i] ?? 0) + (sb[i] ?? 0));
      audio.emit('audioData', mixed, RATE);
      advance(100);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const withBoth = [...updates].reverse().find((update) => update.channels.length >= 2);
    expect(withBoth?.enabled).toBe(true);
    const centres = withBoth!.channels.map((channel) => channel.centerHz);
    expect(centres.some((hz) => Math.abs(hz - 1_000) < 15)).toBe(true);
    expect(centres.some((hz) => Math.abs(hz - 2_210) < 15)).toBe(true);
    const previews = service.getScanUpdate().channels.map((channel) => channel.preview).join(' | ');
    expect(previews).toMatch(/JA1AAA/);
    expect(previews).toMatch(/W1AW/);

    const previous = RttyConfigSchema.parse({});
    await service.applyConfig(RttyConfigSchema.parse({ scanner: false }), previous);
    expect(service.getScanUpdate()).toMatchObject({ enabled: false, channels: [] });
    await service.stop('test');
  });
  it('does not report lock on a strong mistuned signal and keeps SNR in range', async () => {
    const { service, audio, advance } = harness({ centerHz: 2_300 });
    service.start();
    // Strong signal 90 Hz below the receiver: AFC runs to its limit, text is garbage.
    const encoder = new RttyEncoder(RATE);
    encoder.pushText('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG K\n');
    encoder.finish();
    while (!encoder.isFinished) {
      audio.emit('audioData', encoder.readSamples(1_200).samples, RATE);
      advance(100);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const signal = service.getDecoderStatus().signal;
    expect(signal).not.toBeNull();
    // A strong signal is present (calibrated SNR), but the tones are not on it.
    expect(signal!.locked).toBe(false);
    expect(signal!.snrDb).toBeGreaterThan(-30);
    expect(signal!.snrDb).toBeLessThanOrEqual(60);
    await service.stop('test');
  });
});

describe('RttyService repeat and late joiners', () => {
  async function untilIdle(service: RttyService) {
    for (let i = 0; i < 4_000 && service.getTxStatus().active; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  it('repeats a message after each transmission until the operator sends something else', async () => {
    const { service, physicalTx, fireTimers } = harness();
    service.start();
    service.startRepeat({ clientId: 'c1', label: 'Op', messageId: 'cq', intervalSec: 8, text: 'CQ DE N0CALL K' });
    expect(service.getTxStatus().repeat).toMatchObject({ messageId: 'cq', nextRunAt: null });
    await untilIdle(service);
    expect(service.getTxStatus().repeat?.nextRunAt).not.toBeNull();
    expect(fireTimers()).toBe(1);
    expect(service.getTxStatus().active).toBe(true);
    await untilIdle(service);
    expect(physicalTx.leases).toBe(2);
    // Typing anything ends the loop.
    service.append('c1', 'Op', 'HELLO\n', { finishAfter: true });
    expect(service.getTxStatus().repeat).toBeNull();
    await untilIdle(service);
    expect(fireTimers()).toBe(0);
    await service.stop('test');
  });

  it('ends a waiting repeat when the radio frequency changes', async () => {
    const { service, setFrequency, fireTimers } = harness();
    service.start();
    service.startRepeat({ clientId: 'c1', label: 'Op', messageId: 'cq', intervalSec: 8, text: 'CQ DE N0CALL K' });
    await untilIdle(service);
    expect(service.getTxStatus().repeat?.nextRunAt).not.toBeNull();
    setFrequency(7_080_000);
    await service.handleOperatingStateChanged('frequency changed');
    expect(service.getTxStatus().repeat).toBeNull();
    fireTimers();
    expect(service.getTxStatus().active).toBe(false);
    await service.stop('test');
  });

  it('refuses to repeat an empty message', () => {
    const { service } = harness();
    service.start();
    expect(() => service.startRepeat({ clientId: 'c1', label: 'Op', messageId: 'rx', intervalSec: 5, text: '  ' })).toThrow();
    expect(service.getTxStatus().active).toBe(false);
  });

  it('stops repeating when a station answers', async () => {
    const { service, audio, advance, fireTimers } = harness();
    service.start();
    service.startRepeat({ clientId: 'c1', label: 'Op', messageId: 'cq', intervalSec: 8, text: 'CQ DE N0CALL K' });
    await untilIdle(service);
    const answer = new RttyEncoder(RATE);
    answer.pushText('N0CALL DE JA1AAA JA1AAA K\n');
    answer.finish();
    while (!answer.isFinished) {
      audio.emit('audioData', answer.readSamples(1_200).samples, RATE);
      advance(100);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    fireTimers();
    expect(service.getTxStatus().active).toBe(false);
    expect(service.getTxStatus().repeat).toBeNull();
    await service.stop('test');
  });

  it('gives a late client the received text of the current transcript', async () => {
    const { service, audio, advance } = harness();
    service.start();
    expect(service.getTranscriptSnapshot()).toBeNull();
    const encoder = new RttyEncoder(RATE);
    encoder.pushText('CQ DE JA1AAA K\n');
    encoder.finish();
    while (!encoder.isFinished) {
      audio.emit('audioData', encoder.readSamples(1_200).samples, RATE);
      advance(100);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const snapshot = service.getTranscriptSnapshot();
    expect(snapshot?.snapshot).toBe(true);
    expect(snapshot?.characters.map((character) => character.ch).join('')).toContain('CQ DE JA1AAA K');
    service.clearTranscript();
    expect(service.getTranscriptSnapshot()).toBeNull();
    await service.stop('test');
  });
  it('does not show a replay that only repeats what was already read correctly', async () => {
    const { service, audio, advance } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    const encoder = new RttyEncoder(RATE);
    encoder.pushText('TU 73 DE JA1AAA SK\n');
    encoder.finish();
    while (!encoder.isFinished) await feed(audio, encoder.readSamples(1_200).samples, advance);
    for (let i = 0; i < 10; i += 1) await feed(audio, new Float32Array(1_200), advance);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const previous = RttyConfigSchema.parse({});
    // Squelch tweak: same tones, same text.
    await service.applyConfig(RttyConfigSchema.parse({ squelch: 0.2 }), previous);
    expect(events.some((event) => event.kind === 'characters' && event.replay === true)).toBe(false);
    expect(sessionText(events)).toContain('TU 73 DE JA1AAA SK');
    await service.stop('test');
  });

  it('does not show a replay decoded off the signal (mistuned garbage)', async () => {
    const { service, audio, advance, setConfig } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    const encoder = new RttyEncoder(RATE);
    encoder.pushText('BG5DRB DE JA1AAA JA1AAA K\n');
    encoder.finish();
    while (!encoder.isFinished) await feed(audio, encoder.readSamples(1_200).samples, advance);
    for (let i = 0; i < 10; i += 1) await feed(audio, new Float32Array(1_200), advance);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const previous = RttyConfigSchema.parse({});
    setConfig({ centerHz: 2_290 });
    await service.applyConfig(RttyConfigSchema.parse({ centerHz: 2_290 }), previous);
    expect(events.some((event) => event.kind === 'characters' && event.replay === true)).toBe(false);
    expect(sessionText(events)).toContain('BG5DRB DE JA1AAA JA1AAA K');
    await service.stop('test');
  });
  it('keeps live text complete when a settings change mid-message produces no replay block', async () => {
    const message = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789 K';
    for (const switchAt of [12, 25, 37]) {
      const { service, audio, advance, setConfig } = harness();
      const events: RttyDecoderEvent[] = [];
      service.on('decoderEvent', (event) => events.push(event));
      service.start();
      const encoder = new RttyEncoder(RATE);
      encoder.pushText(`${message}\n`);
      encoder.finish();
      await feed(audio, new Float32Array(RATE / 2), advance);
      let chunks = 0;
      let applying: Promise<void> | null = null;
      while (!encoder.isFinished) {
        if (chunks === switchAt) {
          const previous = RttyConfigSchema.parse({});
          setConfig({ squelch: 0.2 });
          applying = service.applyConfig(RttyConfigSchema.parse({ squelch: 0.2 }), previous);
        }
        await feed(audio, encoder.readSamples(1_200).samples, advance);
        chunks += 1;
      }
      await applying;
      for (let i = 0; i < 15; i += 1) await feed(audio, new Float32Array(1_200), advance);
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(events.some((event) => event.kind === 'characters' && event.replay === true)).toBe(false);
      expect(sessionText(events).trim()).toBe(message);
      await service.stop('test');
    }
  });

  it('shows a corrected replay once, not again on the next settings change', async () => {
    const { service, audio, advance, setConfig } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    const encoder = new RttyEncoder(RATE, { markHz: 1_415, spaceHz: 1_585 });
    encoder.pushText('RYRY DE N0CALL QTH TEST K\n');
    encoder.finish();
    while (!encoder.isFinished) await feed(audio, encoder.readSamples(1_200).samples, advance);
    for (let i = 0; i < 10; i += 1) await feed(audio, new Float32Array(1_200), advance);
    let previous = RttyConfigSchema.parse({});
    setConfig({ centerHz: 1_500 });
    await service.applyConfig(RttyConfigSchema.parse({ centerHz: 1_500 }), previous);
    previous = RttyConfigSchema.parse({ centerHz: 1_500 });
    setConfig({ centerHz: 1_500, squelch: 0.2 });
    await service.applyConfig(RttyConfigSchema.parse({ centerHz: 1_500, squelch: 0.2 }), previous);
    const replays = events.filter((event) => event.kind === 'characters' && event.replay === true);
    expect(replays).toHaveLength(1);
    // A client joining now gets the corrected text.
    expect(service.getTranscriptSnapshot()?.characters.map((character) => character.ch).join('')).toContain('DE N0CALL QTH TEST K');
    await service.stop('test');
  });
  it('does not get stuck when the re-decode decoder cannot be created', async () => {
    const { service, audio, advance, setConfig } = harness();
    const events: RttyDecoderEvent[] = [];
    service.on('decoderEvent', (event) => events.push(event));
    service.start();
    for (let i = 0; i < 5; i += 1) await feed(audio, new Float32Array(1_200), advance);
    const previous = RttyConfigSchema.parse({});
    // Tones below 100 Hz are rejected by the modem (the engine refuses to save these).
    const invalid = RttyConfigSchema.parse({ centerHz: 400, shiftHz: 850, baud: 50 });
    setConfig({ centerHz: 400, shiftHz: 850, baud: 50 });
    await service.applyConfig(invalid, previous);
    // The failure is visible instead of the receiver silently dropping text.
    expect(service.getDecoderStatus().state).toBe('error');
    // A valid configuration afterwards decodes again.
    setConfig({ centerHz: 2_210, shiftHz: 170, baud: 45.45 });
    await service.applyConfig(previous, invalid);
    const encoder = new RttyEncoder(RATE);
    encoder.pushText('CQ DE JA1AAA K\n');
    encoder.finish();
    while (!encoder.isFinished) await feed(audio, encoder.readSamples(1_200).samples, advance);
    for (let i = 0; i < 10; i += 1) await feed(audio, new Float32Array(1_200), advance);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sessionText(events)).toContain('CQ DE JA1AAA K');
    await service.stop('test');
  });
  it('a refused stray key does not cancel a running CQ loop', async () => {
    const { service } = harness();
    service.start();
    service.startRepeat({ clientId: 'c1', label: 'Op', messageId: 'cq', intervalSec: 8, text: 'CQ DE N0CALL K' });
    expect(() => service.append('c1', 'Op', 'E', { start: false })).toThrow('RTTY_TX_ENDING');
    expect(service.getTxStatus().repeat?.messageId).toBe('cq');
    await service.stop('test');
  });
});
