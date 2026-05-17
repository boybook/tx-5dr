import { estimateCWMessageDurationMs, type CWKeyerConfig } from '@tx5dr/contracts';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { IRadioConnection } from '../radio/connections/IRadioConnection.js';
import type { CWBackendAvailability, CWBackendPlaybackSignal, CWKeyerBackend } from './CWKeyerBackend.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioCatCWKeyerBackend');
const MIN_CAT_STATUS_DURATION_MS = 250;
const RADIO_CW_HANDLER_POLL_MS = 100;
const CAT_CW_UNSUPPORTED_ERROR = 'Active radio does not report CAT/radio CW text sending support (SEND_MORSE or ICOM CW 0x17)';

export class RadioCatCWKeyerBackend implements CWKeyerBackend {
  readonly type = 'cat' as const;
  readonly supportsManualKeying = false;

  constructor(private readonly getRadioManager: () => PhysicalRadioManager) {}

  async start(_config: CWKeyerConfig): Promise<void> {
    // CAT CW uses the active radio connection and has no standalone device to open.
  }

  async stop(): Promise<void> {
    await this.stopActive();
  }

  async sendText(text: string, wpm: number, signal: CWBackendPlaybackSignal): Promise<void> {
    const connection = this.getConnection();
    if (!connection) {
      throw new Error('CAT CW backend requires an active radio connection');
    }
    if (!this.isConnectionSupported(connection)) {
      throw new Error(CAT_CW_UNSUPPORTED_ERROR);
    }
    if (signal.isStopped()) return;

    logger.debug('Sending CW text through radio CAT backend', { length: text.length, wpm });
    await connection.sendCWMessage!(text, wpm);
    if (signal.isStopped()) return;

    const messageDurationMs = estimateCWMessageDurationMs(text, wpm);
    const durationMs = Math.max(
      messageDurationMs > 0 ? messageDurationMs + RADIO_CW_HANDLER_POLL_MS : 0,
      MIN_CAT_STATUS_DURATION_MS,
    );
    if (durationMs > 0) {
      await signal.wait(durationMs);
    }
  }

  async stopActive(): Promise<void> {
    const connection = this.getConnection();
    if (!connection || !this.isConnectionSupported(connection) || !connection.stopCWMessage) {
      return;
    }
    try {
      await connection.stopCWMessage();
    } catch (error) {
      logger.warn('Failed to stop radio CAT CW message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getAvailability(): CWBackendAvailability {
    const connection = this.getConnection();
    if (!connection) {
      return {
        available: false,
        error: 'CAT CW requires an active radio connection',
      };
    }
    if (!this.isConnectionSupported(connection)) {
      return {
        available: false,
        error: CAT_CW_UNSUPPORTED_ERROR,
      };
    }
    return { available: true, error: null };
  }

  private getConnection(): IRadioConnection | null {
    return this.getRadioManager().getActiveConnection();
  }

  private isConnectionSupported(connection: IRadioConnection): boolean {
    return connection.supportsCWMessageKeyer?.() === true
      && typeof connection.sendCWMessage === 'function';
  }
}
