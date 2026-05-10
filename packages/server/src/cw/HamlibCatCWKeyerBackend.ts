import { estimateCWMessageDurationMs, type CWKeyerConfig } from '@tx5dr/contracts';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { HamlibConnection } from '../radio/connections/HamlibConnection.js';
import type { CWBackendAvailability, CWBackendPlaybackSignal, CWKeyerBackend } from './CWKeyerBackend.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HamlibCatCWKeyerBackend');
const MIN_CAT_STATUS_DURATION_MS = 250;
const HAMLIB_MORSE_HANDLER_POLL_MS = 100;

export class HamlibCatCWKeyerBackend implements CWKeyerBackend {
  readonly type = 'cat' as const;
  readonly supportsManualKeying = false;

  constructor(private readonly getRadioManager: () => PhysicalRadioManager) {}

  async start(_config: CWKeyerConfig): Promise<void> {
    // CAT CW uses the active Hamlib radio connection and has no standalone device to open.
  }

  async stop(): Promise<void> {
    await this.stopActive();
  }

  async sendText(text: string, wpm: number, signal: CWBackendPlaybackSignal): Promise<void> {
    const connection = this.getHamlibConnection();
    if (!connection) {
      throw new Error('CAT CW backend requires an active Hamlib radio connection');
    }
    if (!connection.supportsCWMessageKeyer()) {
      throw new Error('Active Hamlib connection does not support CAT CW Morse sending');
    }
    if (signal.isStopped()) return;

    logger.debug('Sending CW text through Hamlib CAT backend', { length: text.length, wpm });
    await connection.sendCWMessage(text, wpm);
    if (signal.isStopped()) return;

    const messageDurationMs = estimateCWMessageDurationMs(text, wpm);
    const durationMs = Math.max(
      messageDurationMs > 0 ? messageDurationMs + HAMLIB_MORSE_HANDLER_POLL_MS : 0,
      MIN_CAT_STATUS_DURATION_MS,
    );
    if (durationMs > 0) {
      await signal.wait(durationMs);
    }
  }

  async stopActive(): Promise<void> {
    const connection = this.getHamlibConnection();
    if (!connection || !connection.supportsCWMessageKeyer()) {
      return;
    }
    try {
      await connection.stopCWMessage();
    } catch (error) {
      logger.warn('Failed to stop Hamlib CAT CW message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getAvailability(): CWBackendAvailability {
    const connection = this.getHamlibConnection();
    if (!connection) {
      return {
        available: false,
        error: 'CAT CW requires an active Hamlib radio connection',
      };
    }
    if (!connection.supportsCWMessageKeyer()) {
      return {
        available: false,
        error: 'Active Hamlib connection does not support CAT CW Morse sending',
      };
    }
    return { available: true, error: null };
  }

  private getHamlibConnection(): HamlibConnection | null {
    const connection = this.getRadioManager().getActiveConnection();
    return connection instanceof HamlibConnection ? connection : null;
  }
}
