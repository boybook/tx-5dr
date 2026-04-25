import type { EngineMode } from '@tx5dr/contracts';
import type { PhysicalRadioManager } from './PhysicalRadioManager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PhysicalPttMonitor');
const POLL_INTERVAL_MS = 300;

type PhysicalPttMonitorOptions = {
  radioManager: PhysicalRadioManager;
  getEngineMode: () => EngineMode;
  isSoftwarePttActive: () => boolean;
  emitStatus: (active: boolean) => void;
};

export class PhysicalPttMonitor {
  private readonly radioManager: PhysicalRadioManager;
  private readonly getEngineMode: () => EngineMode;
  private readonly isSoftwarePttActive: () => boolean;
  private readonly emitStatus: (active: boolean) => void;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private lastActive = false;
  private consecutiveErrors = 0;
  private disabledForConnection: unknown = null;

  constructor(options: PhysicalPttMonitorOptions) {
    this.radioManager = options.radioManager;
    this.getEngineMode = options.getEngineMode;
    this.isSoftwarePttActive = options.isSoftwarePttActive;
    this.emitStatus = options.emitStatus;
  }

  reevaluate(): void {
    const connection = this.radioManager.getCurrentConnection();
    const shouldPoll = this.shouldPoll(connection);
    logger.debug('Physical PTT monitor reevaluate', {
      shouldPoll,
      engineMode: this.getEngineMode(),
      connected: this.radioManager.isConnected(),
      softwarePttActive: this.isSoftwarePttActive(),
      hasPTTRead: typeof connection?.getPTT === 'function',
      disabledForCurrentConnection: this.disabledForConnection === connection,
    });

    if (shouldPoll) {
      this.startPolling();
      return;
    }

    this.stopPolling();
    if (!this.isSoftwarePttActive()) {
      this.publish(false);
    }
  }

  setSoftwarePttActive(active: boolean): void {
    if (active) {
      this.stopPolling();
      logger.debug('Physical PTT polling paused while software PTT is active');
      return;
    }

    void this.pollOnce({ force: true });
    this.reevaluate();
  }

  stop(): void {
    this.stopPolling();
    this.pollInFlight = false;
    this.consecutiveErrors = 0;
    this.disabledForConnection = null;
    this.publish(false);
  }

  private shouldPoll(connection = this.radioManager.getCurrentConnection()): boolean {
    if (this.getEngineMode() !== 'voice') return false;
    if (!this.radioManager.isConnected()) return false;
    if (this.isSoftwarePttActive()) return false;
    if (!connection || this.disabledForConnection === connection) return false;
    return typeof connection.getPTT === 'function';
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    logger.debug('Starting physical PTT polling');
    this.consecutiveErrors = 0;
    void this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    logger.debug('Stopping physical PTT polling');
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(options: { force?: boolean } = {}): Promise<void> {
    if (this.pollInFlight) return;
    const connection = this.radioManager.getCurrentConnection();
    const canPoll = options.force
      ? this.getEngineMode() === 'voice'
        && this.radioManager.isConnected()
        && Boolean(connection?.getPTT)
        && this.disabledForConnection !== connection
      : this.shouldPoll(connection);

    if (!canPoll) {
      this.reevaluate();
      return;
    }

    this.pollInFlight = true;
    try {
      const active = await connection!.getPTT!();
      if (
        this.getEngineMode() !== 'voice'
        || !this.radioManager.isConnected()
        || this.radioManager.getCurrentConnection() !== connection
        || this.disabledForConnection === connection
        || this.isSoftwarePttActive()
      ) {
        return;
      }
      this.consecutiveErrors = 0;
      if (this.disabledForConnection === connection) {
        this.disabledForConnection = null;
      }
      this.publish(active);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('radio I/O is busy')) {
        return;
      }

      this.consecutiveErrors += 1;
      logger.debug('Physical PTT poll failed', { error: message, consecutiveErrors: this.consecutiveErrors });
      if (this.consecutiveErrors >= 5) {
        logger.warn('Disabling physical PTT polling for current radio connection after repeated failures', { error: message });
        this.disabledForConnection = connection;
        this.stopPolling();
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private publish(active: boolean): void {
    if (this.lastActive === active) return;
    this.lastActive = active;
    this.emitStatus(active);
  }
}
