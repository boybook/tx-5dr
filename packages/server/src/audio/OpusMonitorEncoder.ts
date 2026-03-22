import { createLogger } from '../utils/logger.js';

const logger = createLogger('OpusMonitorEncoder');

const OPUS_BITRATE = 24000; // 24 kbps - good quality for monitoring
const OPUS_FRAME_SIZE = 960; // 20ms at 48kHz

/**
 * Opus encoder wrapper for audio monitor streaming.
 * Encodes Float32 PCM to Opus frames for bandwidth-efficient transmission.
 */
export interface OpusMonitorEncoder {
  /**
   * Encode Float32 PCM data to Opus.
   * Input MUST be exactly 960 samples (20ms at 48kHz).
   * Returns Opus-encoded Buffer, or null on error/wrong size.
   */
  encode(pcmFloat32: Float32Array): Buffer | null;
  destroy(): void;
}

/**
 * Convert Float32 PCM to Int16LE Buffer (owned copy).
 */
function float32ToInt16Buffer(pcmFloat32: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(pcmFloat32.length * 2);
  for (let i = 0; i < pcmFloat32.length; i++) {
    const s = pcmFloat32[i];
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, val | 0)), i * 2);
  }
  return buf;
}

/**
 * Create an Opus encoder for audio monitoring.
 *
 * IMPORTANT: Uses opusscript (WASM) first, NOT @discordjs/opus native.
 *
 * @discordjs/opus v0.10.0 prebuilt binary (darwin-arm64) has a SIGSEGV bug
 * when encoding non-silence audio at bitrate < 64000 bps. The crash happens
 * inside the native OpusEncoder::Encode() and cannot be caught by try/catch
 * (NAPI fatal error kills the process). Tested: bitrate <= 48000 always
 * crashes, >= 64000 works. This affects ENCODING only; decoding via the
 * same library works fine (VoiceAudioReceiver uses it without issues).
 *
 * opusscript (WASM) is safe and fast enough for ~50 encodes/second
 * monitoring use. Falls back to @discordjs/opus only if opusscript is
 * unavailable, using a safe bitrate (>= 64000).
 */
export async function createOpusMonitorEncoder(
  sampleRate: number,
  channels: number,
): Promise<OpusMonitorEncoder | null> {
  // 1. Try opusscript (WASM) first — safe, no NAPI crash risk
  try {
    const opusScriptModule = await import('opusscript');
    const OpusScript = opusScriptModule.default || opusScriptModule;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encoder = new OpusScript(sampleRate as any, channels, OpusScript.Application.AUDIO) as any;
    if (typeof encoder.setBitrate === 'function') {
      encoder.setBitrate(OPUS_BITRATE);
    }

    logger.info('Opus monitor encoder initialized (opusscript WASM)', {
      sampleRate,
      channels,
      bitrate: OPUS_BITRATE,
    });

    return {
      encode(pcmFloat32: Float32Array): Buffer | null {
        if (pcmFloat32.length !== OPUS_FRAME_SIZE * channels) {
          return null;
        }
        try {
          const int16Buffer = float32ToInt16Buffer(pcmFloat32);
          const encoded = encoder.encode(int16Buffer, OPUS_FRAME_SIZE);
          return Buffer.from(encoded);
        } catch (err) {
          logger.debug('Opus encode error (opusscript)', err);
          return null;
        }
      },
      destroy() {
        try {
          encoder.delete();
        } catch {
          // ignore
        }
      },
    };
  } catch {
    logger.debug('opusscript not available for encoding, trying @discordjs/opus');
  }

  // 2. Fallback to @discordjs/opus (native)
  // WARNING: must use bitrate >= 64000 to avoid SIGSEGV (see doc above)
  const NATIVE_SAFE_BITRATE = 64000;
  try {
    const opusModule = await import('@discordjs/opus');
    const OpusEncoder = opusModule.OpusEncoder || opusModule.default?.OpusEncoder;
    if (!OpusEncoder) throw new Error('OpusEncoder not found in module');

    const encoder = new OpusEncoder(sampleRate, channels);
    encoder.setBitrate(NATIVE_SAFE_BITRATE);

    logger.info('Opus monitor encoder initialized (native @discordjs/opus)', {
      sampleRate,
      channels,
      bitrate: NATIVE_SAFE_BITRATE,
    });

    return {
      encode(pcmFloat32: Float32Array): Buffer | null {
        if (pcmFloat32.length !== OPUS_FRAME_SIZE * channels) {
          return null;
        }
        try {
          const int16Buffer = float32ToInt16Buffer(pcmFloat32);
          return encoder.encode(int16Buffer);
        } catch (err) {
          logger.debug('Opus encode error (native)', err);
          return null;
        }
      },
      destroy() {
        // OpusEncoder doesn't need explicit cleanup
      },
    };
  } catch (err) {
    logger.debug('@discordjs/opus not available for encoding', err);
  }

  logger.warn('No Opus encoder available, audio monitor will use PCM only');
  return null;
}
