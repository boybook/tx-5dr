import { createLogger } from '../utils/logger.js';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';

const logger = createLogger('VoiceAudioReceiver');

/**
 * Receives Opus-encoded audio frames from browser clients,
 * decodes them to PCM, and streams to AudioStreamManager for playback.
 *
 * Uses a simple jitter buffer to smooth network timing variations.
 */
export class VoiceAudioReceiver {
  private audioStreamManager: AudioStreamManager;
  private isReceiving = false;
  private opusDecoder: OpusDecoderWrapper | null = null;
  private readonly sampleRate = 48000;
  private readonly channels = 1;
  private frameCount = 0;

  // Jitter buffer
  private jitterBuffer: Float32Array[] = [];
  private readonly JITTER_BUFFER_TARGET_FRAMES = 2; // ~40ms at 20ms/frame
  private drainTimer: NodeJS.Timeout | null = null;
  private readonly DRAIN_INTERVAL_MS = 20; // Drain one frame every 20ms

  constructor(audioStreamManager: AudioStreamManager) {
    this.audioStreamManager = audioStreamManager;
  }

  /**
   * Initialize the Opus decoder.
   * Call this once during VoiceSessionManager setup.
   */
  async initialize(): Promise<void> {
    this.opusDecoder = await createOpusDecoder(this.sampleRate, this.channels);
    logger.info('Opus decoder initialized', { sampleRate: this.sampleRate, channels: this.channels });
  }

  /**
   * Start receiving and playing audio frames.
   */
  start(): void {
    if (this.isReceiving) return;
    this.isReceiving = true;
    this.frameCount = 0;
    this.jitterBuffer = [];

    // Start drain timer
    this.drainTimer = setInterval(() => {
      this.drainOneFrame();
    }, this.DRAIN_INTERVAL_MS);

    logger.info('Voice audio receiver started');
  }

  /**
   * Stop receiving audio.
   */
  stop(): void {
    if (!this.isReceiving) return;
    this.isReceiving = false;

    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }

    // Drain remaining frames
    while (this.jitterBuffer.length > 0) {
      this.drainOneFrame();
    }

    logger.info('Voice audio receiver stopped', { totalFrames: this.frameCount });
  }

  /**
   * Handle an incoming Opus-encoded audio frame.
   * @param opusData Raw Opus packet (Buffer)
   */
  handleOpusFrame(opusData: Buffer): void {
    if (!this.isReceiving || !this.opusDecoder) return;

    try {
      const pcmFloat32 = this.opusDecoder.decode(opusData);
      if (pcmFloat32 && pcmFloat32.length > 0) {
        this.jitterBuffer.push(pcmFloat32);
        this.frameCount++;
      }
    } catch (err) {
      logger.debug('Opus decode error, skipping frame', err);
    }
  }

  /**
   * Drain one frame from the jitter buffer and send to AudioStreamManager.
   */
  private drainOneFrame(): void {
    if (this.jitterBuffer.length === 0) return;

    // Wait until buffer has enough frames before starting playback
    if (this.frameCount <= this.JITTER_BUFFER_TARGET_FRAMES && this.jitterBuffer.length < this.JITTER_BUFFER_TARGET_FRAMES) {
      return;
    }

    const frame = this.jitterBuffer.shift();
    if (frame) {
      this.audioStreamManager.playVoiceAudio(frame, this.sampleRate);
    }
  }

  getIsReceiving(): boolean {
    return this.isReceiving;
  }

  destroy(): void {
    this.stop();
    if (this.opusDecoder) {
      this.opusDecoder.destroy();
      this.opusDecoder = null;
    }
  }
}

/**
 * Opus decoder wrapper - abstracts the underlying Opus library.
 * Supports @discordjs/opus (native) or opusscript (WASM) as fallback.
 */
interface OpusDecoderWrapper {
  decode(opusData: Buffer): Float32Array;
  destroy(): void;
}

async function createOpusDecoder(sampleRate: number, channels: number): Promise<OpusDecoderWrapper> {
  // Try @discordjs/opus first (native, best performance)
  try {
    const opusModule = await import('@discordjs/opus');
    // Handle both ESM default export and CJS named export
    const OpusEncoder = opusModule.OpusEncoder || opusModule.default?.OpusEncoder;
    if (!OpusEncoder) throw new Error('OpusEncoder not found in module');
    const encoder = new OpusEncoder(sampleRate, channels);
    logger.info('Using @discordjs/opus (native)');
    return {
      decode(opusData: Buffer): Float32Array {
        // @discordjs/opus decode returns Buffer with Int16LE samples
        const int16Buf = encoder.decode(opusData);
        const int16 = new Int16Array(int16Buf.buffer, int16Buf.byteOffset, int16Buf.byteLength / 2);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }
        return float32;
      },
      destroy() {
        // OpusEncoder doesn't need explicit cleanup
      },
    };
  } catch {
    logger.debug('@discordjs/opus not available, trying opusscript');
  }

  // Fallback to opusscript (WASM)
  try {
    const opusScriptModule = await import('opusscript');
    const OpusScript = opusScriptModule.default || opusScriptModule;
    const decoder = new OpusScript(sampleRate, channels, OpusScript.Application.AUDIO);
    logger.info('Using opusscript (WASM)');
    return {
      decode(opusData: Buffer): Float32Array {
        const int16Buf = decoder.decode(opusData);
        const int16 = new Int16Array(int16Buf.buffer, int16Buf.byteOffset, int16Buf.byteLength / 2);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }
        return float32;
      },
      destroy() {
        decoder.delete();
      },
    };
  } catch {
    logger.warn('opusscript not available either');
  }

  // Last resort: pass-through (no decoding, for testing)
  logger.error('No Opus decoder available! Voice audio will not work.');
  return {
    decode(_opusData: Buffer): Float32Array {
      return new Float32Array(0);
    },
    destroy() {},
  };
}
