import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import wav from 'wav';
import { Mp3Encoder } from 'lamejs';
import { RecordingSettingsSchema, type RecordingEntry, type RecordingSettings } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import type { AudioStreamManager, NativeAudioInputFrame } from './AudioStreamManager.js';
import { resampleLinear } from '../cw-decoder/resampler.js';
const DEFAULT_SETTINGS: RecordingSettings = { format: 'wav', sampleRate: 24000, bitDepth: 16, source: 'both', directory: 'recordings' };

export class RecordingService {
  private settings: RecordingSettings = DEFAULT_SETTINGS;
  private writer: wav.Writer | null = null;
  private pcmChunks: Buffer[] = [];
  private filePath: string | null = null;
  private current: { id: string; startedAt: number; source: RecordingSettings['source']; format: RecordingSettings['format']; samples: number } | null = null;
  private entries: RecordingEntry[] = [];
  private error: string | null = null;
  private rxPending: Float32Array | null = null;
  private txPending: Float32Array | null = null;

  constructor(private readonly audio: AudioStreamManager, private readonly dataDir: string) {
    try {
      const persisted = ConfigManager.getInstance().getConfig().recording;
      if (persisted) {
        const legacy = persisted as typeof persisted & { quality?: 'low' | 'medium' | 'high' };
        const sampleRate = legacy.sampleRate ?? (legacy.quality === 'low' ? 16000 : legacy.quality === 'high' ? 48000 : 24000);
        this.settings = RecordingSettingsSchema.parse({ ...legacy, sampleRate, bitDepth: legacy.bitDepth ?? 16 });
      }
    } catch {
      // Config may not be initialized in isolated service tests.
    }
    void this.loadIndex();
    audio.on('nativeAudioInputData', this.onRx);
    audio.on('txRecordingAudioData', this.onTx);
    audio.on('error', this.onAudioError);
  }

  dispose(): void { this.audio.off('nativeAudioInputData', this.onRx); this.audio.off('txRecordingAudioData', this.onTx); this.audio.off('error', this.onAudioError); void this.stop(); }
  getSettings(): RecordingSettings { return { ...this.settings }; }
  setSettings(input: RecordingSettings): RecordingSettings { this.settings = RecordingSettingsSchema.parse(input); try { void ConfigManager.getInstance().replaceConfigForMigration({ ...ConfigManager.getInstance().getConfig(), recording: this.settings }); } catch { /* persistence unavailable during isolated startup */ } return this.getSettings(); }
  getStatus() { return { recording: this.current !== null, entry: this.entries[0] ?? null, error: this.error }; }

  async start(): Promise<ReturnType<RecordingService['getStatus']>> {
    if (this.current) throw new Error('Recording already active');
    const root = this.resolveRoot();
    await fs.mkdir(root, { recursive: true });
    const id = randomUUID();
    const extension = this.settings.format === 'mp3' ? 'mp3' : 'wav';
    this.filePath = path.join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.${extension}`);
    const tempPath = `${this.filePath}.part`;
    if (this.settings.format === 'wav') {
      this.writer = new wav.Writer({ channels: 1, sampleRate: this.settings.sampleRate, bitDepth: this.settings.bitDepth });
      const output = (await import('node:fs')).createWriteStream(tempPath);
      this.writer.pipe(output);
    } else {
      this.writer = null;
      this.pcmChunks = [];
    }
    this.current = { id, startedAt: Date.now(), source: this.settings.source, format: this.settings.format, samples: 0 };
    this.rxPending = null; this.txPending = null;
    this.error = null;
    return this.getStatus();
  }

  async stop(): Promise<ReturnType<RecordingService['getStatus']>> {
    const current = this.current;
    if (!current || !this.filePath) return this.getStatus();
    if (current.format === 'wav' && !this.writer) return this.getStatus();
    const writer = this.writer;
    if (current.source === 'both') {
      const rx = this.rxPending;
      const tx = this.txPending;
      const count = Math.max(rx?.length ?? 0, tx?.length ?? 0);
      if (count > 0) {
        const tail = new Float32Array(count);
        for (let i = 0; i < count; i += 1) tail[i] = ((rx?.[i] ?? 0) + (tx?.[i] ?? 0)) * 0.5;
        this.write(tail);
      }
    }
    this.rxPending = null; this.txPending = null;
    this.current = null; this.writer = null;
    const tempPath = `${this.filePath}.part`;
    const output = new Promise<void>((resolve, reject) => {
      if (!writer) { resolve(); return; }
      const onError = (error: Error) => reject(error);
      writer.once('error', onError);
      const stream = writer as unknown as NodeJS.ReadWriteStream;
      stream.once('end', () => undefined);
      writer.end();
      stream.once('close', resolve);
    });
    if (writer) await output;
    if (current.format === 'mp3') await this.writeMp3(tempPath);
    await fs.rename(tempPath, this.filePath);
    const stat = await fs.stat(this.filePath);
    this.entries.unshift({ id: current.id, fileName: path.basename(this.filePath), format: current.format, source: current.source, startedAt: current.startedAt, endedAt: Date.now(), durationMs: Date.now() - current.startedAt, sizeBytes: stat.size });
    await this.saveIndex();
    return this.getStatus();
  }

  async list(): Promise<RecordingEntry[]> { await this.loadIndex(); return [...this.entries]; }
  async download(id: string): Promise<{ path: string; entry: RecordingEntry }> { const entry = this.entries.find(item => item.id === id); if (!entry) throw new Error('Recording not found'); const root = this.resolveRoot(); const filePath = path.resolve(root, entry.fileName); if (path.dirname(filePath) !== root) throw new Error('Invalid recording path'); return { path: filePath, entry }; }
  async delete(id: string): Promise<void> { const index = this.entries.findIndex(item => item.id === id); if (index < 0) throw new Error('Recording not found'); const entry = this.entries[index]; const root = this.resolveRoot(); const filePath = path.resolve(root, entry.fileName); if (path.dirname(filePath) !== root) throw new Error('Invalid recording path'); await fs.rm(filePath, { force: true }); this.entries.splice(index, 1); await this.saveIndex(); }

  private resolveRoot(): string { return path.isAbsolute(this.settings.directory) ? path.resolve(this.settings.directory) : path.resolve(this.dataDir, this.settings.directory); }
  private indexPath(): string { return path.join(this.resolveRoot(), '.index.json'); }
  private async loadIndex(): Promise<void> { try { const raw = await fs.readFile(this.indexPath(), 'utf8'); this.entries = JSON.parse(raw) as RecordingEntry[]; } catch { /* first run or stale index */ } }
  private async saveIndex(): Promise<void> { await fs.mkdir(this.resolveRoot(), { recursive: true }); const temp = `${this.indexPath()}.part`; await fs.writeFile(temp, JSON.stringify(this.entries), 'utf8'); await fs.rename(temp, this.indexPath()); }

  private write(samples: Float32Array): void { if (!this.current) return; const bytes = this.settings.bitDepth === 16 ? 2 : this.settings.bitDepth === 24 ? 3 : 4; if (this.writer) { const pcm = Buffer.alloc(samples.length * bytes); for (let i = 0; i < samples.length; i += 1) { const value = Math.max(-1, Math.min(1, samples[i]!)); if (bytes === 2) pcm.writeInt16LE(Math.round(value * 0x7fff), i * 2); else if (bytes === 4) pcm.writeInt32LE(Math.round(value * 0x7fffffff), i * 4); else { const n = Math.round(value * 0x7fffff); const o = i * 3; pcm[o] = n & 255; pcm[o + 1] = (n >> 8) & 255; pcm[o + 2] = (n >> 16) & 255; } } this.writer.write(pcm); } else { const pcm = Buffer.alloc(samples.length * 2); for (let i = 0; i < samples.length; i += 1) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff), i * 2); this.pcmChunks.push(pcm); } this.current.samples += samples.length; }
  private async writeMp3(tempPath: string): Promise<void> { const bitrate = this.settings.sampleRate >= 44100 ? 192 : this.settings.sampleRate >= 24000 ? 128 : 64; const encoder = new Mp3Encoder(1, this.settings.sampleRate, bitrate); const output: Buffer[] = []; const pcm = Buffer.concat(this.pcmChunks); for (let offset = 0; offset < pcm.length; offset += 2304) { const samples = new Int16Array(Math.min(1152, (pcm.length - offset) / 2)); for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(offset + i * 2); const encoded = encoder.encodeBuffer(samples); if (encoded.length) output.push(Buffer.from(encoded)); } const end = encoder.flush(); if (end.length) output.push(Buffer.from(end)); await fs.writeFile(tempPath, Buffer.concat(output)); this.pcmChunks = []; }
  private prepare(samples: Float32Array, sampleRate: number): Float32Array { return sampleRate === this.settings.sampleRate ? new Float32Array(samples) : resampleLinear(samples, sampleRate, this.settings.sampleRate); }
  private onRx = (frame: NativeAudioInputFrame): void => { if (!this.current) return; const samples = this.prepare(frame.samples, frame.sampleRate); if (this.current.source === 'rx') this.write(samples); else if (this.current.source === 'both') { this.rxPending = this.rxPending ? this.concat(this.rxPending, samples) : samples; this.flushMixed(); } };
  private onTx = ({ samples, sampleRate }: { samples: Float32Array; sampleRate: number }): void => { if (!this.current) return; const prepared = this.prepare(samples, sampleRate); if (this.current.source === 'tx') this.write(prepared); else if (this.current.source === 'both') { this.txPending = this.txPending ? this.concat(this.txPending, prepared) : prepared; this.flushMixed(); } };
  private onAudioError = (error: Error): void => { if (!this.current) return; this.error = error.message; void this.stop().catch((stopError: unknown) => { this.error = stopError instanceof Error ? stopError.message : 'Recording finalization failed'; }); };
  private concat(a: Float32Array, b: Float32Array): Float32Array { const out = new Float32Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
  private flushMixed(): void { if (!this.rxPending || !this.txPending) return; const count = Math.min(this.rxPending.length, this.txPending.length); const mixed = new Float32Array(count); for (let i = 0; i < count; i += 1) mixed[i] = (this.rxPending[i] + this.txPending[i]) * 0.5; this.write(mixed); this.rxPending = this.rxPending.slice(count); this.txPending = this.txPending.slice(count); }
}
