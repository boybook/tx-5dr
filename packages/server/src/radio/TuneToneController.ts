import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import type { PhysicalRadioManager } from './PhysicalRadioManager.js';
import { createLogger } from '../utils/logger.js';
import type { TuneToneStatus } from '@tx5dr/contracts';

const logger = createLogger('TuneToneController');

const TONE_SAMPLE_RATE = 12000;
const DEFAULT_MAX_DURATION_MS = 15000;
const DEFAULT_TONE_HZ = 1500;
const MIN_TONE_HZ = 100;
const MAX_TONE_HZ = 3000;
const TONE_GAIN = 0.35;
const RAMP_MS = 20;

export interface TuneToneControllerDeps {
  radioManager: PhysicalRadioManager;
  audioStreamManager: AudioStreamManager;
  isTransmitBusy: () => boolean;
  getOperatorToneHz: (operatorId?: string | null) => number | null;
  setSoftwarePttActive: (active: boolean) => void;
  emitStatus: (status: TuneToneStatus) => void;
}

export interface StartTuneToneOptions {
  operatorId?: string | null;
  toneHz?: number | null;
}

export class TuneToneController {
  private active = false;
  private pttAsserted = false;
  private toneHz: number | null = null;
  private startedAt: number | null = null;
  private maxDurationMs = DEFAULT_MAX_DURATION_MS;
  private timeout: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(private readonly deps: TuneToneControllerDeps) {}

  getStatus(error?: string): TuneToneStatus {
    return {
      active: this.active,
      toneHz: this.toneHz,
      startedAt: this.startedAt,
      maxDurationMs: this.maxDurationMs,
      ...(error ? { error } : {}),
    };
  }

  async start(options: StartTuneToneOptions = {}): Promise<void> {
    if (this.active) {
      return;
    }
    if (!this.deps.radioManager.isConnected()) {
      throw new Error('radio not connected');
    }
    if (this.deps.isTransmitBusy()) {
      throw new Error('transmitter is busy');
    }

    const toneHz = this.resolveToneHz(options);
    const currentGeneration = ++this.generation;
    this.active = true;
    this.pttAsserted = false;
    this.toneHz = toneHz;
    this.startedAt = Date.now();
    this.maxDurationMs = DEFAULT_MAX_DURATION_MS;
    this.deps.emitStatus(this.getStatus());

    try {
      await this.deps.radioManager.setPTT(true);
      this.pttAsserted = true;
      this.deps.setSoftwarePttActive(true);
      this.timeout = setTimeout(() => {
        void this.stop('timeout').catch((error) => {
          logger.error('Failed to auto-stop tune tone', error);
        });
      }, this.maxDurationMs);

      const audio = generateTone(toneHz, this.maxDurationMs, TONE_SAMPLE_RATE);
      void this.deps.audioStreamManager.playAudio(audio, TONE_SAMPLE_RATE, {
        injectIntoMonitor: true,
        playbackKind: 'tune-tone',
      })
        .then(() => {
          if (this.generation === currentGeneration && this.active) {
            void this.stop('complete');
          }
        })
        .catch((error) => {
          const interrupted = error instanceof Error && error.message === 'playback interrupted';
          if (this.generation === currentGeneration && this.active) {
            if (interrupted) {
              void this.stop('playback-interrupted');
            } else {
              logger.error('Tune tone playback failed', error);
              void this.stop('playback-error', error instanceof Error ? error.message : String(error));
            }
          }
        });
    } catch (error) {
      await this.stop('start-error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async stop(_reason = 'manual', error?: string): Promise<void> {
    if (!this.active && !this.pttAsserted) {
      if (error) {
        this.deps.emitStatus(this.getStatus(error));
      }
      return;
    }

    ++this.generation;
    this.clearTimeout();

    const shouldStopPlayback = this.deps.audioStreamManager.isPlaying('tune-tone');
    const shouldReleasePtt = this.pttAsserted;
    this.active = false;
    this.toneHz = null;
    this.startedAt = null;

    if (shouldStopPlayback) {
      try {
        await this.deps.audioStreamManager.stopCurrentPlayback({ kind: 'tune-tone' });
      } catch (stopError) {
        logger.warn('Stopping tune tone playback failed', stopError);
      }
    }

    if (shouldReleasePtt) {
      try {
        await this.deps.radioManager.setPTT(false);
      } catch (pttError) {
        logger.warn('Releasing tune tone PTT failed', pttError);
      }
      this.pttAsserted = false;
    }

    this.deps.setSoftwarePttActive(false);
    this.deps.emitStatus(this.getStatus(error));
  }

  private resolveToneHz(options: StartTuneToneOptions): number {
    const requested = typeof options.toneHz === 'number'
      ? options.toneHz
      : this.deps.getOperatorToneHz(options.operatorId);
    const value = Number.isFinite(requested) ? Number(requested) : DEFAULT_TONE_HZ;
    return Math.round(Math.min(MAX_TONE_HZ, Math.max(MIN_TONE_HZ, value)));
  }

  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}

function generateTone(toneHz: number, durationMs: number, sampleRate: number): Float32Array {
  const samples = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const rampSamples = Math.max(1, Math.round((RAMP_MS / 1000) * sampleRate));
  const output = new Float32Array(samples);
  const step = (Math.PI * 2 * toneHz) / sampleRate;

  for (let i = 0; i < samples; i++) {
    const fadeIn = Math.min(1, i / rampSamples);
    const fadeOut = Math.min(1, (samples - i - 1) / rampSamples);
    const gain = TONE_GAIN * Math.max(0, Math.min(fadeIn, fadeOut));
    output[i] = Math.sin(i * step) * gain;
  }

  return output;
}
