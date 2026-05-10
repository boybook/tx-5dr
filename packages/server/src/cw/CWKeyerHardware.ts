import { SerialPort } from 'serialport';
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
  private _isKeyDown = false;
  private _open = false;

  constructor(portPath: string, method: 'dtr' | 'rts') {
    this.portPath = portPath;
    this.method = method;
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
        resolve();
      });
    });

    // 确保初始状态为 key-up
    await this.setPin(false);
    this._open = true;
    logger.info(`CW keyer hardware opened on ${this.portPath} (${this.method})`);
  }

  /**
   * 键控按下（引脚拉高）
   */
  async keyDown(): Promise<void> {
    if (!this._open || this._isKeyDown) {
      return;
    }
    await this.setPin(true);
    this._isKeyDown = true;
  }

  /**
   * 键控释放（引脚拉低）
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

    // 确保键控释放
    if (this._isKeyDown) {
      await this.setPin(false);
      this._isKeyDown = false;
    }

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

  private async setPin(active: boolean): Promise<void> {
    if (!this.port) {
      return;
    }
    const signal = { [this.method]: active };
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
}
