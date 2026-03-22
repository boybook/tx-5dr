/**
 * OpusMonitorDecoder - Decodes Opus audio frames using WebCodecs AudioDecoder.
 *
 * Used in the audio monitor pipeline to decode Opus-encoded frames
 * received from the server before passing PCM data to the AudioWorklet.
 *
 * Compatibility: Chrome 94+, Edge 94+, Safari 16.4+, Firefox 130+
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('OpusMonitorDecoder');

/**
 * Build an OpusHead identification header (RFC 7845, Section 5.1).
 * Required by WebCodecs AudioDecoder.configure() for Opus codec.
 *
 * Structure (19 bytes for mono):
 *   [0..7]  'OpusHead' magic signature
 *   [8]     Version (1)
 *   [9]     Channel count
 *   [10..11] Pre-skip (little-endian, typically 0 for raw decode)
 *   [12..15] Input sample rate (little-endian)
 *   [16..17] Output gain (little-endian, 0)
 *   [18]    Channel mapping family (0 = mono/stereo)
 */
function buildOpusHead(sampleRate: number, channels: number): Uint8Array {
  const header = new Uint8Array(19);
  const view = new DataView(header.buffer);

  // Magic signature: 'OpusHead'
  header.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);
  // Version
  header[8] = 1;
  // Channel count
  header[9] = channels;
  // Pre-skip (little-endian) - 0 for raw decoding
  view.setUint16(10, 0, true);
  // Input sample rate (little-endian)
  view.setUint32(12, sampleRate, true);
  // Output gain (little-endian) - 0 dB
  view.setInt16(16, 0, true);
  // Channel mapping family (0 = mono/stereo, no mapping table needed)
  header[18] = 0;

  return header;
}

/**
 * Check if the browser supports WebCodecs AudioDecoder for Opus.
 */
export function canDecodeOpus(): boolean {
  return typeof AudioDecoder !== 'undefined';
}

/**
 * Opus monitor decoder using WebCodecs AudioDecoder.
 * Decodes Opus binary frames to Float32 PCM on the main thread.
 */
export class OpusMonitorDecoder {
  private decoder: AudioDecoder | null = null;
  private pendingResolves: Array<(pcm: Float32Array) => void> = [];
  private isInitialized = false;
  private sampleRate: number;
  private channels: number;
  private timestampCounter = 0;
  private configError = false;

  constructor(sampleRate = 48000, channels = 1) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  async init(): Promise<void> {
    if (this.isInitialized) return;

    if (!canDecodeOpus()) {
      throw new Error('WebCodecs AudioDecoder not available');
    }

    // Check if opus decoding is supported
    const support = await AudioDecoder.isConfigSupported({
      codec: 'opus',
      sampleRate: this.sampleRate,
      numberOfChannels: this.channels,
      description: buildOpusHead(this.sampleRate, this.channels),
    });

    if (!support.supported) {
      throw new Error('Opus AudioDecoder configuration not supported');
    }

    this.decoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        this.handleDecodedData(audioData);
      },
      error: (error: DOMException) => {
        logger.error('AudioDecoder error:', error.message);
        this.configError = true;
        // Reject any pending promises
        while (this.pendingResolves.length > 0) {
          const resolve = this.pendingResolves.shift()!;
          resolve(new Float32Array(0));
        }
      },
    });

    this.decoder.configure({
      codec: 'opus',
      sampleRate: this.sampleRate,
      numberOfChannels: this.channels,
      description: buildOpusHead(this.sampleRate, this.channels),
    });

    // Give decoder a moment to validate config
    await new Promise(resolve => setTimeout(resolve, 50));

    if (this.configError) {
      this.destroy();
      throw new Error('AudioDecoder configure failed');
    }

    this.isInitialized = true;
    logger.info('OpusMonitorDecoder initialized', {
      sampleRate: this.sampleRate,
      channels: this.channels,
      state: this.decoder.state,
    });
  }

  /**
   * Decode an Opus frame to PCM Float32.
   * Returns a promise that resolves with the decoded PCM data.
   */
  decode(opusData: ArrayBuffer): Promise<Float32Array> {
    if (!this.decoder || this.decoder.state !== 'configured' || this.configError) {
      return Promise.resolve(new Float32Array(0));
    }

    // Avoid queue buildup: Chrome has a max decode queue of 1.
    if (this.decoder.decodeQueueSize > 2) {
      return Promise.resolve(new Float32Array(0));
    }

    return new Promise<Float32Array>((resolve) => {
      let resolved = false;
      const wrappedResolve = (pcm: Float32Array) => {
        if (resolved) return;
        resolved = true;
        resolve(pcm);
      };

      this.pendingResolves.push(wrappedResolve);

      // Safety timeout: if decoder never calls back, don't leak the promise
      setTimeout(() => {
        if (!resolved) {
          const idx = this.pendingResolves.indexOf(wrappedResolve);
          if (idx !== -1) this.pendingResolves.splice(idx, 1);
          wrappedResolve(new Float32Array(0));
        }
      }, 500);

      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: this.timestampCounter++ * 20000, // 20ms per frame in microseconds
        data: opusData,
      });

      try {
        this.decoder!.decode(chunk);
      } catch (err) {
        logger.debug('Opus decode error', err);
        const idx = this.pendingResolves.indexOf(wrappedResolve);
        if (idx !== -1) this.pendingResolves.splice(idx, 1);
        wrappedResolve(new Float32Array(0));
      }
    });
  }

  private handleDecodedData(audioData: AudioData): void {
    const resolve = this.pendingResolves.shift();
    if (!resolve) {
      audioData.close();
      return;
    }

    try {
      const pcm = new Float32Array(audioData.numberOfFrames * audioData.numberOfChannels);
      audioData.copyTo(pcm, { planeIndex: 0 });
      resolve(pcm);
    } catch (err) {
      logger.debug('Failed to copy decoded audio data', err);
      resolve(new Float32Array(0));
    } finally {
      audioData.close();
    }
  }

  destroy(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        // ignore
      }
    }
    this.decoder = null;
    this.isInitialized = false;
    this.configError = false;
    this.pendingResolves = [];
  }
}
