import { SerialPort } from 'serialport';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PttHardware');

/** 独立 PTT 硬件。用于无 CAT 电台 profile 的 DTR/RTS 控制。 */
export class PttHardware {
  private port: SerialPort | null = null;
  private openState = false;
  private active = false;

  constructor(
    private readonly path: string,
    private readonly method: 'dtr' | 'rts',
  ) {}

  async open(): Promise<void> {
    if (this.openState) return;
    const port = new SerialPort({ path: this.path, baudRate: 9600, autoOpen: false });
    this.port = port;
    try {
      await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
      await this.set(false);
      this.openState = true;
      logger.info(`PTT hardware opened on ${this.path} (${this.method.toUpperCase()})`);
    } catch (error) {
      await this.closePort(port);
      throw new Error(`Failed to open PTT port ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async set(enabled: boolean): Promise<void> {
    if (!this.port) return;
    const signal = { [this.method]: enabled } as { dtr?: boolean; rts?: boolean };
    await new Promise<void>((resolve, reject) => this.port!.set(signal, error => error ? reject(error) : resolve()));
    this.active = enabled;
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    try { await this.set(false); } catch (error) {
      logger.warn(`Failed to release PTT ${this.method.toUpperCase()} on ${this.path}`, { error: error instanceof Error ? error.message : String(error) });
    }
    await this.closePort(port);
    this.port = null;
    this.openState = false;
    this.active = false;
  }

  private async closePort(port: SerialPort): Promise<void> {
    await new Promise<void>(resolve => {
      if (!port.isOpen) { resolve(); return; }
      port.close(() => resolve());
    });
  }
}
