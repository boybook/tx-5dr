import type { SquelchStatus } from '@tx5dr/contracts';
import type { EngineMode } from '@tx5dr/contracts';
import type { PhysicalRadioManager } from './PhysicalRadioManager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SquelchStatusMonitor');

const POLL_INTERVAL_MS = 300;
const UNSUPPORTED_STATUS: Omit<SquelchStatus, 'updatedAt'> = {
  supported: false,
  open: null,
  muted: false,
  source: 'unsupported',
};

type SquelchStatusMonitorOptions = {
  radioManager: PhysicalRadioManager;
  getEngineMode: () => EngineMode;
  emitStatus: (status: SquelchStatus) => void;
};

export class SquelchStatusMonitor {
  private readonly radioManager: PhysicalRadioManager;
  private readonly getEngineMode: () => EngineMode;
  private readonly emitStatus: (status: SquelchStatus) => void;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: SquelchStatus | null = null;
  private consecutiveErrors = 0;
  private pollInFlight = false;
  private disabledForConnection: unknown = null;

  constructor(options: SquelchStatusMonitorOptions) {
    this.radioManager = options.radioManager;
    this.getEngineMode = options.getEngineMode;
    this.emitStatus = options.emitStatus;
  }

  reevaluate(): void {
    const connection = this.radioManager.getCurrentConnection();
    const shouldPoll = this.shouldPoll(connection);
    logger.debug('Squelch monitor reevaluate', { shouldPoll, engineMode: this.getEngineMode(), connected: this.radioManager.isConnected(), pttActive: this.radioManager.isPTTActive(), hasDCD: typeof connection?.getDCD === 'function', disabledForCurrentConnection: this.disabledForConnection === connection });
    if (shouldPoll) {
      this.startPolling();
      return;
    }

    this.stopPolling();
    if (!this.radioManager.isPTTActive()) {
      this.publishUnsupported();
    }
  }

  setPTTActive(active: boolean): void {
    if (active) {
      this.stopPolling();
      logger.debug('DCD squelch polling paused while PTT is active');
      return;
    }
    this.reevaluate();
  }

  getSnapshot(): SquelchStatus {
    return this.lastStatus ?? this.buildStatus(UNSUPPORTED_STATUS);
  }

  stop(): void {
    this.stopPolling();
    this.lastStatus = null;
    this.consecutiveErrors = 0;
    this.disabledForConnection = null;
  }

  private shouldPoll(connection = this.radioManager.getCurrentConnection()): boolean {
    if (this.getEngineMode() !== 'voice') return false;
    if (!this.radioManager.isConnected()) return false;
    if (this.radioManager.isPTTActive()) return false;
    if (!connection || this.disabledForConnection === connection) return false;
    return typeof connection.getDCD === 'function';
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    logger.debug('Starting DCD squelch polling');
    this.consecutiveErrors = 0;
    void this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    logger.debug('Stopping DCD squelch polling');
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight) return;
    const connection = this.radioManager.getCurrentConnection();
    if (!this.shouldPoll(connection)) {
      this.reevaluate();
      return;
    }

    if (!connection?.getDCD) {
      this.publishUnsupported();
      return;
    }

    this.pollInFlight = true;
    try {
      const open = await connection.getDCD();
      this.consecutiveErrors = 0;
      if (this.disabledForConnection === connection) {
        this.disabledForConnection = null;
      }
      this.publish({
        supported: true,
        open,
        muted: !open,
        source: 'hamlib-dcd',
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('radio I/O is busy')) {
        // Low-priority DCD polls are expected to lose to normal CAT traffic.
        // Keep the last known squelch state instead of disabling software squelch.
        return;
      }
      this.consecutiveErrors += 1;
      logger.debug('DCD poll failed', { error: message, consecutiveErrors: this.consecutiveErrors });
      if (this.consecutiveErrors >= 3) {
        logger.warn('Disabling squelch DCD polling for current radio connection after repeated failures', { error: message });
        this.disabledForConnection = connection;
        this.stopPolling();
        this.publishUnsupported();
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private publishUnsupported(): void {
    this.publish(UNSUPPORTED_STATUS);
  }

  private publish(status: Omit<SquelchStatus, 'updatedAt'>): void {
    if (this.lastStatus
      && this.lastStatus.supported === status.supported
      && this.lastStatus.open === status.open
      && this.lastStatus.muted === status.muted
      && this.lastStatus.source === status.source) {
      return;
    }

    const next = this.buildStatus(status);
    this.lastStatus = next;
    this.emitStatus(next);
  }

  private buildStatus(status: Omit<SquelchStatus, 'updatedAt'>): SquelchStatus {
    return { ...status, updatedAt: Date.now() };
  }
}
