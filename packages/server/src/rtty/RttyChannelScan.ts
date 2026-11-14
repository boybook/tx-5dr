import { EventEmitter } from 'eventemitter3';
import type { RttyConfig, RttyScanChannel, RttyScanUpdate } from '@tx5dr/contracts';
import type { RttyScanEvent, RttyScanner } from 'rasterwave-node';
import { createLogger } from '../utils/logger.js';
import type { RttyCodecRuntime } from './RttyCodecRuntime.js';

const logger = createLogger('RttyChannelScan');

/** Characters of decoded preview kept per signal. */
const PREVIEW_LIMIT = 96;
const NATIVE_QUEUE_SECONDS = 2;

/** Scanner parameters that require a new native scanner when they change. */
function scannerKey(config: RttyConfig, sampleRate: number): string | null {
  if (!config.scanner) return null;
  return [sampleRate, config.baud, config.shiftHz, config.stopBits, config.scannerChannels].join('|');
}

export interface RttyChannelScanEvents {
  update: (update: RttyScanUpdate) => void;
}

/**
 * Signal browser: runs the native wideband scanner on the received audio and
 * keeps, per detected RTTY signal, its parameters and a short decoded preview.
 * Input is best-effort: chunks are dropped while the native queue is full.
 */
export class RttyChannelScan extends EventEmitter<RttyChannelScanEvents> {
  private scanner: RttyScanner | null = null;
  private key: string | null = null;
  private generation = 0;
  private channels = new Map<number, RttyScanChannel>();
  private droppedChunks = 0;
  private lastSignature = '';

  constructor(
    private readonly codec: Pick<RttyCodecRuntime, 'load'>,
    private readonly now: () => number,
  ) {
    super();
  }

  /** Starts, rebuilds or stops the scanner to match `config`. */
  configure(config: RttyConfig, sampleRate: number): void {
    const key = scannerKey(config, sampleRate);
    if (key === this.key) return;
    this.stop();
    this.key = key;
    if (!key) {
      this.emitUpdate();
      return;
    }
    let codec;
    try {
      codec = this.codec.load();
    } catch {
      return;
    }
    if (typeof codec.RttyScanner !== 'function') {
      logger.warn('rasterwave-node does not provide the RTTY channel scanner');
      return;
    }
    const generation = ++this.generation;
    try {
      this.scanner = new codec.RttyScanner(sampleRate, {
        shiftsHz: [config.shiftHz],
        baud: config.baud,
        shiftHz: config.shiftHz,
        stopBits: config.stopBits,
        maxChannels: config.scannerChannels,
        queueCapacitySamples: sampleRate * NATIVE_QUEUE_SECONDS,
      }, (event) => this.handleEvent(generation, event));
    } catch (error) {
      logger.warn('Failed to create the RTTY channel scanner', { error: error instanceof Error ? error.message : String(error) });
      this.scanner = null;
    }
    this.emitUpdate();
  }

  push(chunk: Float32Array): void {
    if (!this.scanner) return;
    if (!this.scanner.pushF32(chunk)) this.droppedChunks += 1;
  }

  stop(): void {
    const scanner = this.scanner;
    this.scanner = null;
    this.key = null;
    this.generation += 1;
    this.channels.clear();
    if (scanner) void scanner.dispose().catch(() => undefined);
  }

  getUpdate(): RttyScanUpdate {
    return {
      enabled: this.scanner !== null,
      channels: [...this.channels.values()].sort((a, b) => a.centerHz - b.centerHz),
      updatedAt: this.now(),
    };
  }

  getDroppedChunks(): number {
    return this.droppedChunks;
  }

  private handleEvent(generation: number, event: RttyScanEvent): void {
    if (generation !== this.generation) return;
    switch (event.type) {
      case 'channels': {
        const next = new Map<number, RttyScanChannel>();
        for (const channel of event.channels) {
          const previous = this.channels.get(channel.id);
          next.set(channel.id, {
            id: channel.id,
            centerHz: Math.round(channel.centerHz * 10) / 10,
            shiftHz: Math.round(channel.shiftHz),
            score: Math.max(0, Math.min(1, channel.score)),
            snrDb: Math.round(channel.snrDb * 10) / 10,
            reversed: channel.reversed,
            locked: channel.locked,
            preview: previous?.preview ?? '',
            lastHeardAt: previous?.lastHeardAt ?? this.now(),
          });
        }
        this.channels = next;
        this.emitUpdate(true);
        return;
      }
      case 'text': {
        const channel = this.channels.get(event.channelId);
        if (!channel) return;
        const text = event.characters.map((character) => (character.ch === '\r' || character.ch === '\n' ? ' ' : character.ch)).join('');
        channel.preview = `${channel.preview}${text}`.replace(/ {2,}/g, ' ').slice(-PREVIEW_LIMIT);
        channel.lastHeardAt = this.now();
        return;
      }
      case 'removed':
        if (this.channels.delete(event.channelId)) this.emitUpdate();
        return;
      case 'error':
        logger.warn('RTTY channel scanner failed', { reason: event.reason });
        this.stop();
        this.emitUpdate();
        return;
      default:
    }
  }

  /** `dedupe`: skip periodic lists that did not change what clients show. */
  private emitUpdate(dedupe = false): void {
    const update = this.getUpdate();
    const signature = JSON.stringify(update.channels.map((channel) => [
      channel.id, Math.round(channel.centerHz), Math.round(channel.snrDb), channel.locked, channel.reversed, channel.preview,
    ]));
    if (dedupe && signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.emit('update', update);
  }
}
