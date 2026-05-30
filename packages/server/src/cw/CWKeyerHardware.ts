import { SerialPort } from 'serialport';
import type { CWKeyActiveLevel } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CWKeyerHardware');

/**
 * CW 键控硬件层 — 直接通过串口 DTR/RTS 引脚控制电台 CW KEY 输入。
 *
 * 不走 Hamlib PTT 路径，用 node-serialport 直接操作引脚电平，
 * 确保莫尔斯时序精度（20 WPM 时点长约 60ms，要求毫秒级响应）。
 */
export class CWKeyerHardware {
  private port: SerialPort | null = null;
  private readonly portPath: string;
  private readonly method: 'dtr' | 'rts';
  private readonly activeLevel: CWKeyActiveLevel;
  private _isKeyDown = false;
  private _open = false;

  constructor(portPath: string, method: 'dtr' | 'rts', activeLevel: CWKeyActiveLevel = 'high') {
    this.portPath = portPath;
    this.method = method;
    this.activeLevel = activeLevel;
  }

  get isOpen(): boolean {
    return this._open;
  }

  get isKeyDown(): boolean {
    return this._isKeyDown;
  }

  /**
   * 打开串口（仅用于引脚控制，不进行数据收发）
   */
  async open(): Promise<void> {
    if (this._open) {
      return;
    }

    this.port = new SerialPort({
      path: this.portPath,
      baudRate: 9600, // 引脚控制不需要特定波特率
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      this.port!.open((err) => {
        if (err) {
          reject(new Error(`Failed to open CW key port ${this.portPath}: ${err.message}`));
          return;
        }
        this.resetControlLines()
          .then(resolve)
          .catch(async (error) => {
            await this.closePortBestEffort(this.port);
            reject(new Error(`Failed to reset CW key port ${this.portPath}: ${error instanceof Error ? error.message : String(error)}`));
          });
      });
    });

    this._open = true;
    logger.info(`CW keyer hardware opened on ${this.portPath} (${this.method}, active ${this.activeLevel})`);
  }

  /**
   * 键控按下（按配置的有效电平驱动引脚）
   */
  async keyDown(): Promise<void> {
    if (!this._open || this._isKeyDown) {
      return;
    }
    await this.setPin(true);
    this._isKeyDown = true;
  }

  /**
   * 键控释放（按配置的空闲电平驱动引脚）
   */
  async keyUp(): Promise<void> {
    if (!this._open || !this._isKeyDown) {
      return;
    }
    await this.setPin(false);
    this._isKeyDown = false;
  }

  /**
   * 关闭串口
   */
  async close(): Promise<void> {
    if (!this._open || !this.port) {
      return;
    }

    // 确保所有控制线释放，覆盖 Linux open() 后默认拉高 DTR/RTS 的情况。
    try {
      await this.resetControlLines();
    } catch (error) {
      logger.warn(`Failed to reset CW keyer control lines before close on ${this.portPath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this._isKeyDown = false;

    const port = this.port;
    this.port = null;
    this._open = false;

    await new Promise<void>((resolve) => {
      port.close((_err) => {
        resolve();
      });
    });

    logger.info(`CW keyer hardware closed on ${this.portPath}`);
  }

  private async resetControlLines(): Promise<void> {
    const idle = this.inactivePinState();
    try {
      await this.setControlLines({ rts: idle, dtr: idle });
      return;
    } catch (combinedError) {
      logger.warn(`Failed to reset both CW keyer control lines on ${this.portPath}; trying individual lines`, {
        error: this.formatError(combinedError),
        method: this.method,
        activeLevel: this.activeLevel,
      });

      try {
        await this.setControlLines({ [this.method]: idle });
      } catch (selectedError) {
        throw new Error(
          `Failed to release selected ${this.method.toUpperCase()} line after combined reset failed: `
          + `${this.formatError(selectedError)} (combined reset: ${this.formatError(combinedError)})`,
        );
      }

      const otherMethod = this.method === 'dtr' ? 'rts' : 'dtr';
      try {
        await this.setControlLines({ [otherMethod]: idle });
      } catch (otherError) {
        logger.warn(`Failed to reset unused ${otherMethod.toUpperCase()} CW control line on ${this.portPath}`, {
          error: this.formatError(otherError),
          method: this.method,
          activeLevel: this.activeLevel,
        });
      }
    }
  }

  private async setPin(keyDown: boolean): Promise<void> {
    await this.setControlLines({ [this.method]: keyDown ? this.activePinState() : this.inactivePinState() });
  }

  private activePinState(): boolean {
    return this.activeLevel !== 'low';
  }

  private inactivePinState(): boolean {
    return !this.activePinState();
  }

  private async setControlLines(signal: { dtr?: boolean; rts?: boolean }): Promise<void> {
    if (!this.port) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.port!.set(signal, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private async closePortBestEffort(port: SerialPort | null): Promise<void> {
    if (!port) {
      return;
    }
    await new Promise<void>((resolve) => {
      port.close(() => resolve());
    });
    if (this.port === port) {
      this.port = null;
    }
    this._open = false;
    this._isKeyDown = false;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
