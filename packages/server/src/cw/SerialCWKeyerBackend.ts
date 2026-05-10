import { encodeTextToCWEvents, type CWKeyerConfig } from '@tx5dr/contracts';
import { CWKeyerHardware } from './CWKeyerHardware.js';
import type { CWBackendAvailability, CWBackendPlaybackSignal, CWKeyerBackend } from './CWKeyerBackend.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SerialCWKeyerBackend');

export class SerialCWKeyerBackend implements CWKeyerBackend {
  readonly type = 'serial' as const;
  readonly supportsManualKeying = true;

  private hardware: CWKeyerHardware | null = null;
  private config: CWKeyerConfig | null = null;
  private started = false;

  async start(config: CWKeyerConfig): Promise<void> {
    this.config = { ...config };
    if (this.started && this.hardware?.isOpen) {
      return;
    }

    if (!config.keyPort) {
      this.started = true;
      logger.warn('Serial CW backend started without hardware (no keyPort configured)');
      return;
    }

    if (this.hardware) {
      await this.hardware.close();
      this.hardware = null;
    }

    this.hardware = new CWKeyerHardware(config.keyPort, config.keyMethod);
    await this.hardware.open();
    this.started = true;
    logger.info('Serial CW backend started');
  }

  async stop(): Promise<void> {
    await this.stopActive();
    if (this.hardware) {
      await this.hardware.close();
      this.hardware = null;
    }
    this.started = false;
  }

  async sendText(text: string, wpm: number, signal: CWBackendPlaybackSignal): Promise<void> {
    const events = encodeTextToCWEvents(text, wpm);
    for (const event of events) {
      if (signal.isStopped()) return;
      if (event.afterMs > 0) {
        const shouldContinue = await signal.wait(event.afterMs);
        if (!shouldContinue || signal.isStopped()) return;
      }

      if (event.type === 'key-down') {
        await this.keyDown();
        signal.onKeyDown?.();
      } else {
        await this.keyUp();
      }
    }
  }

  async stopActive(): Promise<void> {
    if (this.hardware?.isKeyDown) {
      await this.hardware.keyUp();
    }
  }

  async keyDown(): Promise<void> {
    if (this.hardware) {
      await this.hardware.keyDown();
    }
  }

  async keyUp(): Promise<void> {
    if (this.hardware) {
      await this.hardware.keyUp();
    }
  }

  getAvailability(): CWBackendAvailability {
    if (!this.config?.keyPort) {
      return {
        available: false,
        error: 'CW serial key port is not configured',
      };
    }
    return { available: true, error: null };
  }
}
