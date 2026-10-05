/**
 * NullConnection - 空对象模式
 *
 * 当 type=none（无电台模式）时使用，所有操作都是 no-op。
 * 避免在各处散布 `if (type === 'none') return` 的条件判断。
 */

import { EventEmitter } from 'eventemitter3';
import type { MeterCapabilities } from '@tx5dr/contracts';
import type {
  ApplyOperatingStateRequest,
  ApplyOperatingStateResult,
  IRadioConnection,
  IRadioConnectionEvents,
  RadioConnectionConfig,
  RadioModeInfo,
  RadioModeBandwidth,
  SetRadioModeOptions,
} from './IRadioConnection.js';
import { RadioConnectionType, RadioConnectionState } from './IRadioConnection.js';
import { PttHardware } from '../PttHardware.js';

export class NullConnection extends EventEmitter<IRadioConnectionEvents> implements IRadioConnection {
  private pttHardware: PttHardware | null = null;
  getType(): RadioConnectionType {
    return RadioConnectionType.NONE;
  }

  getState(): RadioConnectionState {
    return RadioConnectionState.CONNECTED;
  }

  isHealthy(): boolean {
    return true;
  }

  async connect(config: RadioConnectionConfig): Promise<void> {
    if (config.type === 'none' && (config.pttMethod === 'dtr' || config.pttMethod === 'rts')) {
      const path = config.pttPort;
      if (!path) throw new Error('PTT port is required for DTR/RTS in no-radio mode');
      this.pttHardware = new PttHardware(path, config.pttMethod);
      await this.pttHardware.open();
    }
    this.emit('stateChanged', RadioConnectionState.CONNECTED);
    this.emit('connected');
  }

  async disconnect(_reason?: string): Promise<void> {
    await this.pttHardware?.close();
    this.pttHardware = null;
  }

  isCriticalOperationActive(): boolean {
    return false;
  }

  async setFrequency(_frequency: number): Promise<void> {
    // no-op
  }

  async getFrequency(): Promise<number> {
    return 0;
  }

  async setPTT(enabled: boolean): Promise<void> {
    await this.pttHardware?.set(enabled);
  }

  async setMode(_mode: string, _bandwidth?: RadioModeBandwidth, _options?: SetRadioModeOptions): Promise<void> {
    // no-op
  }

  async applyOperatingState(request: ApplyOperatingStateRequest): Promise<ApplyOperatingStateResult> {
    return {
      frequencyApplied: request.frequency !== undefined,
      modeApplied: Boolean(request.mode),
    };
  }

  async getMode(): Promise<RadioModeInfo> {
    return { mode: 'NONE', bandwidth: '' };
  }

  getMeterCapabilities(): MeterCapabilities {
    return {
      strength: false,
      swr: false,
      alc: false,
      power: false,
      powerWatts: false,
    };
  }

  setKnownFrequency(_frequencyHz: number): void {
    // no-op: null connection has no meter data
  }

  getConnectionInfo(): {
    type: RadioConnectionType;
    state: RadioConnectionState;
    config: Partial<RadioConnectionConfig>;
  } {
    return {
      type: RadioConnectionType.NONE,
      state: RadioConnectionState.CONNECTED,
      config: { type: 'none' },
    };
  }
}
