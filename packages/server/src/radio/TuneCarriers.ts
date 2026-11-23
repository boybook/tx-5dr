import type { TuneMethod } from '@tx5dr/contracts';
import type { PhysicalTxCoordinator, PhysicalTxLeaseRequest } from '../transmission/PhysicalTxCoordinator.js';
import type { IRadioConnection } from './connections/IRadioConnection.js';

const TONE_SAMPLE_RATE = 12000;
// WSJT-X encodes FT8/FT4 at full scale (peak 1.0, RMS ~0.707). The tune tone
// must use the same source amplitude so the shared user volume gain produces
// the same RF drive as a digital transmission instead of being ~9 dB weaker.
const TONE_GAIN = 1.0;
const RAMP_MS = 20;

/** A carrier that is on the air under a physical TX lease. */
export interface TuneCarrierRun {
  /**
   * Settles when the carrier ends without a stop request: its duration elapsed,
   * playback failed, or the radio switched it off. Resolves to an error message.
   */
  readonly ended: Promise<string | undefined>;
  /** Detaches observers; switching the carrier off is the lease interrupt's job. */
  dispose(): void;
}

/**
 * One way of producing a tune carrier. The controller owns the lease and the
 * lifecycle; a carrier only declares how the lease keys and interrupts it and
 * puts the carrier on the air once the lease is held.
 */
export interface TuneCarrier {
  readonly method: TuneMethod;
  readonly toneHz: number | null;
  readonly leaseOptions: Pick<PhysicalTxLeaseRequest, 'playbackKind' | 'assertPtt' | 'interrupt'>;
  start(leaseId: string, durationMs: number): Promise<TuneCarrierRun>;
}

/** The radio connection surface needed for a radio-owned tune carrier. */
export interface RadioTunePort {
  setRadioTune(enabled: boolean): Promise<void>;
  on(event: 'radioTuneChanged', listener: (active: boolean) => void): unknown;
  off(event: 'radioTuneChanged', listener: (active: boolean) => void): unknown;
}

export function getRadioTunePort(connection: IRadioConnection | null): RadioTunePort | null {
  if (!connection?.setRadioTune || connection.supportsRadioTune?.() !== true) return null;
  return connection as RadioTunePort;
}

/** PTT plus a generated sine tone: RF power follows the normal drive and audio gain. */
export class AudioToneCarrier implements TuneCarrier {
  readonly method = 'audio-tone' as const;
  readonly leaseOptions = { playbackKind: 'tune-tone' as const };

  constructor(
    private readonly coordinator: PhysicalTxCoordinator,
    readonly toneHz: number,
  ) {}

  async start(leaseId: string, durationMs: number): Promise<TuneCarrierRun> {
    const completion = this.coordinator.playAudioOnLease(leaseId, {
      audioData: generateTone(this.toneHz, durationMs, TONE_SAMPLE_RATE),
      sampleRate: TONE_SAMPLE_RATE,
      playbackKind: 'tune-tone',
      playbackOptions: { injectIntoMonitor: true },
    });
    return {
      ended: completion.then(
        (result) => result.error,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      dispose: () => undefined,
    };
  }
}

/**
 * The radio software's own TUNE function: it generates the carrier and applies
 * its tune power. The lease is self-keyed, so no PTT or TX audio is involved.
 */
export class RadioTuneCarrier implements TuneCarrier {
  readonly method = 'radio-tune' as const;
  readonly toneHz = null;
  readonly leaseOptions: TuneCarrier['leaseOptions'];

  constructor(
    private readonly coordinator: PhysicalTxCoordinator,
    private readonly radio: RadioTunePort,
  ) {
    this.leaseOptions = { assertPtt: false, interrupt: () => this.radio.setRadioTune(false) };
  }

  async start(leaseId: string, durationMs: number): Promise<TuneCarrierRun> {
    let finish!: (error: string | undefined) => void;
    const ended = new Promise<string | undefined>((resolve) => { finish = resolve; });
    const onRadioTuneChanged = (active: boolean) => {
      if (!active) finish(undefined);
    };
    let timer: NodeJS.Timeout | null = null;
    const dispose = () => {
      this.radio.off('radioTuneChanged', onRadioTuneChanged);
      if (timer) clearTimeout(timer);
      timer = null;
    };

    this.radio.on('radioTuneChanged', onRadioTuneChanged);
    try {
      await this.radio.setRadioTune(true);
      this.coordinator.markSelfKeyedLeaseActive(leaseId);
    } catch (error) {
      dispose();
      throw error;
    }
    // Same duration contract as the audio tone, whose waveform ends by itself.
    timer = setTimeout(() => finish(undefined), durationMs);
    return { ended, dispose };
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
