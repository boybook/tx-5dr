import { performance } from 'node:perf_hooks';
import type { RtAudioInstance } from '../audio/rtaudio-api.js';

/** External PCM device. Application buffering, conversion and drain remain real. */
export class VirtualAudioDevice implements RtAudioInstance {
  private opened = false;
  private running = false;
  private rate = 48_000;
  private frames = 1_024;
  private channels = 1;
  private format = 0x10;
  private output = false;
  private queue: Buffer[] = [];
  private timer?: NodeJS.Timeout;
  private input?: (data: Buffer) => void;
  private consumed?: () => void;
  private error?: (type: number, message: string) => void;
  private startedAt = 0;
  private startedUtc = 0;
  private cursor = 0;
  readonly faults = { stall: false, writeFailure: false, disconnected: false };

  constructor(private readonly receive: (startMs: number, sampleRate: number, count: number) => Float32Array, private readonly clock: () => number = () => performance.now()) {}

  getDevices(): ReturnType<RtAudioInstance['getDevices']> {
    return [{ id: 0, name: 'Station PCM device', inputChannels: 1, outputChannels: 2,
      duplexChannels: 1, isDefaultInput: 1, isDefaultOutput: 1,
      sampleRates: [12_000, 44_100, 48_000], preferredSampleRate: 48_000,
      nativeFormats: 0x12 }];
  }
  getDefaultInputDevice(): number { return 0; }
  getDefaultOutputDevice(): number { return 0; }
  getApi(): string { return 'Station PCM device'; }
  getStreamLatency(): number { return this.frames; }
  getStreamSampleRate(): number { return this.rate; }
  isStreamOpen(): boolean { return this.opened; }
  isStreamRunning(): boolean { return this.running; }

  openStream(...args: Parameters<RtAudioInstance['openStream']>): number {
    if (this.opened) throw new Error('PCM device stream already open');
    const [output, input, format, rate, frames, , onInput, onConsumed, , onError] = args;
    if (!output && !input) throw new Error('PCM device requires a stream direction');
    if (![0x2, 0x10].includes(format)) throw new Error('PCM device format unsupported');
    this.output = Boolean(output);
    this.channels = output?.nChannels ?? input?.nChannels ?? 1;
    this.format = format;
    this.rate = rate;
    this.frames = frames;
    this.input = onInput ?? undefined;
    this.consumed = onConsumed ?? undefined;
    this.error = onError ?? undefined;
    this.queue = [];
    this.opened = true;
    return frames;
  }
  start(): void {
    if (!this.opened) throw new Error('PCM device stream not open');
    if (this.running) return;
    this.running = true;
    this.startedAt = this.clock();
    this.startedUtc = Date.now();
    this.cursor = 0;
    this.timer = setInterval(() => this.pump(), Math.max(1, Math.min(5, this.frames / this.rate * 500)));
  }
  stop(): void { this.running = false; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  closeStream(): void { this.stop(); this.opened = false; this.queue = []; }
  clearOutputQueue(): void { this.queue = []; }
  write(data: Buffer): void {
    if (!this.running || !this.output || this.faults.disconnected) throw new Error('PCM device unavailable');
    if (this.faults.writeFailure) throw new Error('PCM device write failure');
    if (data.length !== this.frames * this.channels * (this.format === 0x2 ? 2 : 4)) throw new Error('PCM device frame size mismatch');
    if (this.queue.length >= Math.ceil(this.rate / this.frames)) throw new Error('PCM device FIFO full');
    this.queue.push(Buffer.from(data));
  }
  private pump(): void {
    if (!this.running) return;
    if (this.faults.disconnected) { this.stop(); this.error?.(4, 'PCM device disconnected'); return; }
    const due = Math.floor((this.clock() - this.startedAt) * this.rate / 1_000);
    if (due - this.cursor > this.rate * 2) { this.stop(); this.error?.(4, 'PCM device clock overrun'); return; }
    while (this.running && due - this.cursor >= this.frames) {
      if (this.output) {
        if (this.faults.stall) return;
        if (this.queue.shift()) this.consumed?.();
      } else {
        const pcm = this.receive(this.startedUtc + this.cursor / this.rate * 1_000, this.rate, this.frames);
        const bytes = Buffer.alloc(this.frames * this.channels * (this.format === 0x2 ? 2 : 4));
        for (let i = 0; i < this.frames; i++) for (let c = 0; c < this.channels; c++) {
          const offset = (i * this.channels + c) * (this.format === 0x2 ? 2 : 4);
          const sample = Math.max(-1, Math.min(1, pcm[i] ?? 0));
          if (this.format === 0x2) bytes.writeInt16LE(Math.round(sample * 32767), offset);
          else bytes.writeFloatLE(sample, offset);
        }
        this.input?.(bytes);
      }
      this.cursor += this.frames;
    }
  }
}
