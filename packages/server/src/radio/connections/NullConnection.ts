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
  RadioModeBandwidth,
  SetRadioModeOptions,
} from './IRadioConnection.js';
import { RadioConnectionType, RadioConnectionState } from './IRadioConnection.js';

export class NullConnection extends EventEmitter<IRadioConnectionEvents> implements IRadioConnection {
  getType(): RadioConnectionType {
    return RadioConnectionType.NONE;
  }

  getState(): RadioConnectionState {
    return RadioConnectionState.CONNECTED;
  }

  isHealthy(): boolean {
    return true;
  }

  async connect(_config: RadioConnectionConfig): Promise<void> {
    // no-op, 立即成功
    this.emit('stateChanged', RadioConnectionState.CONNECTED);
    this.emit('connected');
  }

  async disconnect(_reason?: string): Promise<void> {
    // no-op
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

  async setPTT(_enabled: boolean): Promise<void> {
    // no-op
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

  async getMode(): Promise<{ mode: string; bandwidth: string }> {
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
