import type { PhysicalRadioManager } from './PhysicalRadioManager.js';
import type { PhysicalTxCoordinator } from '../transmission/PhysicalTxCoordinator.js';
import { createLogger } from '../utils/logger.js';
import type { TuneMethod, TuneToneStatus } from '@tx5dr/contracts';
import {
  AudioToneCarrier,
  RadioTuneCarrier,
  type RadioTunePort,
  type TuneCarrier,
  type TuneCarrierRun,
} from './TuneCarriers.js';

const logger = createLogger('TuneToneController');

const DEFAULT_MAX_DURATION_MS = 15000;
// Backstop after the carrier's own duration; every carrier ends by itself.
const WATCHDOG_GRACE_MS = 1000;
const DEFAULT_TONE_HZ = 1500;
const MIN_TONE_HZ = 100;
const MAX_TONE_HZ = 3000;

export interface TuneToneControllerDeps {
  radioManager: PhysicalRadioManager;
  physicalTxCoordinator: PhysicalTxCoordinator;
  isTransmitBusy: () => boolean;
  getOperatorToneHz: (operatorId?: string | null) => number | null;
  /** The active radio's own tune function, when it provides one. */
  getRadioTune: () => RadioTunePort | null;
  emitStatus: (status: TuneToneStatus) => void;
}

export interface StartTuneToneOptions {
  operatorId?: string | null;
  toneHz?: number | null;
}

/**
 * Owns the manual tune transmission: one physical TX lease, a bounded duration,
 * and the status shown to operators. The carrier is the radio's own TUNE when
 * available, otherwise a PTT-keyed audio tone.
 */
export class TuneToneController {
  private active = false;
  private carrier: TuneCarrier | null = null;
  private run: TuneCarrierRun | null = null;
  // Survives a stop whose PTT release is unconfirmed, so a later stop can retry.
  private leaseId: string | null = null;
  private startedAt: number | null = null;
  private maxDurationMs = DEFAULT_MAX_DURATION_MS;
  private watchdog: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(private readonly deps: TuneToneControllerDeps) {}

  getStatus(error?: string): TuneToneStatus {
    const carrier = this.active ? this.carrier : null;
    return {
      active: this.active,
      method: carrier?.method ?? this.resolveMethod(),
      toneHz: carrier?.toneHz ?? null,
      startedAt: this.startedAt,
      maxDurationMs: this.maxDurationMs,
      ...(error ? { error } : {}),
    };
  }

  /** Re-publishes the idle status after the radio, and so the next method, changed. */
  refreshStatus(): void {
    if (!this.active) this.deps.emitStatus(this.getStatus());
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

    const carrier = this.createCarrier(options);
    const generation = ++this.generation;
    this.active = true;
    this.carrier = carrier;
    this.startedAt = Date.now();
    this.maxDurationMs = DEFAULT_MAX_DURATION_MS;
    this.deps.emitStatus(this.getStatus());

    try {
      const leaseId = await this.deps.physicalTxCoordinator.acquireLease({
        source: 'tune-tone',
        reason: `tune (${carrier.method})`,
        deferActiveUntilAudio: true,
        ...carrier.leaseOptions,
      });
      this.leaseId = leaseId;
      if (!this.isCurrent(generation)) {
        await this.deps.physicalTxCoordinator.forceInterruptLease(leaseId, 'tune cancelled while starting');
        this.leaseId = null;
        return;
      }
      this.watchdog = setTimeout(() => {
        void this.stop('timeout').catch((error) => {
          logger.error('Failed to auto-stop tune', error);
        });
      }, this.maxDurationMs + WATCHDOG_GRACE_MS);

      const run = await carrier.start(leaseId, this.maxDurationMs);
      if (!this.isCurrent(generation)) {
        run.dispose();
        return;
      }
      this.run = run;
      void run.ended.then((error) => {
        if (!this.isCurrent(generation)) return;
        if (error) logger.error('Tune carrier ended with an error', { method: carrier.method, error });
        void this.stop('carrier ended', error).catch((stopError) => {
          logger.error('Failed to finish tune after the carrier ended', stopError);
        });
      });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      await this.stop('start-error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async stop(reason = 'manual', error?: string): Promise<void> {
    if (!this.active && !this.leaseId) {
      if (error) {
        this.deps.emitStatus(this.getStatus(error));
      }
      return;
    }

    ++this.generation;
    this.clearWatchdog();
    this.run?.dispose();
    this.run = null;
    this.active = false;
    this.startedAt = null;

    if (this.leaseId) {
      error = (await this.releaseLease(this.leaseId, reason)) ?? error;
    }
    this.deps.emitStatus(this.getStatus(error));
  }

  /** Ends the lease; the coordinator runs the carrier's interrupt. Returns a release error. */
  private async releaseLease(leaseId: string, reason: string): Promise<string | undefined> {
    const coordinator = this.deps.physicalTxCoordinator;
    let releaseError: string | undefined;
    try {
      const snapshot = coordinator.getSnapshot();
      const result = snapshot.leaseId === leaseId && snapshot.phase === 'unknown'
        ? await coordinator.retryUnknownStop(`tune stop retry: ${reason}`)
        : await coordinator.forceInterruptLease(leaseId, `tune stop: ${reason}`);
      releaseError = result?.error;
    } catch (stopError) {
      logger.warn('Releasing tune transmission failed', stopError);
      releaseError = stopError instanceof Error ? stopError.message : String(stopError);
    }
    const snapshot = coordinator.getSnapshot();
    if (snapshot.leaseId === leaseId && snapshot.phase === 'unknown') {
      return 'PTT release unconfirmed';
    }
    this.leaseId = null;
    return releaseError;
  }

  private createCarrier(options: StartTuneToneOptions): TuneCarrier {
    const radioTune = this.deps.getRadioTune();
    return radioTune
      ? new RadioTuneCarrier(this.deps.physicalTxCoordinator, radioTune)
      : new AudioToneCarrier(this.deps.physicalTxCoordinator, this.resolveToneHz(options));
  }

  private resolveMethod(): TuneMethod {
    return this.deps.getRadioTune() ? 'radio-tune' : 'audio-tone';
  }

  private resolveToneHz(options: StartTuneToneOptions): number {
    const requested = typeof options.toneHz === 'number'
      ? options.toneHz
      : this.deps.getOperatorToneHz(options.operatorId);
    const value = Number.isFinite(requested) ? Number(requested) : DEFAULT_TONE_HZ;
    return Math.round(Math.min(MAX_TONE_HZ, Math.max(MIN_TONE_HZ, value)));
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation && this.active;
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
