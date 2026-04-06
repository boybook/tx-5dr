/**
 * RadioCapabilityManager - 统一电台控制能力管理器
 *
 * Facade 职责：
 * - 暴露连接生命周期入口和快照读取接口
 * - 组合 definitions 与 runtime registry
 * - 处理少量 capability 特有的后置编排（如 tuner_tune optimistic meta）
 */

import { EventEmitter } from 'eventemitter3';
import type {
  CapabilityDescriptor,
  CapabilityState,
  CapabilityValue,
  TunerStatus,
} from '@tx5dr/contracts';
import type { IRadioConnection } from './connections/IRadioConnection.js';
import { CapabilityRuntimeRegistry } from './capabilities/CapabilityRuntimeRegistry.js';
import type { CapabilityRuntimeEvents } from './capabilities/types.js';

export interface RadioCapabilityManagerEvents extends CapabilityRuntimeEvents {}

export class RadioCapabilityManager extends EventEmitter<RadioCapabilityManagerEvents> {
  private readonly runtime = new CapabilityRuntimeRegistry();

  constructor() {
    super();

    this.runtime.on('capabilityList', (data) => {
      this.emit('capabilityList', data);
    });
    this.runtime.on('capabilityChanged', (state) => {
      this.emit('capabilityChanged', state);
    });
  }

  async onConnected(connection: IRadioConnection): Promise<void> {
    await this.runtime.onConnected(connection);
  }

  onDisconnected(): void {
    this.runtime.onDisconnected();
  }

  async writeCapability(id: string, value?: CapabilityValue, action?: boolean): Promise<void> {
    await this.runtime.writeCapability(id, value, action);
  }

  syncTunerStatus(status: TunerStatus): void {
    const currentState = this.runtime.getCapabilityStates().find((capability) => capability.id === 'tuner_switch');
    const currentMeta = currentState?.meta as { status?: string; swr?: number } | undefined;
    const nextStatus = status.status ?? (status.active ? 'tuning' : 'idle');

    this.runtime.setCapabilityState('tuner_switch', {
      supported: true,
      value: status.enabled,
      meta: {
        ...(currentMeta ?? {}),
        status: nextStatus,
        ...(status.swr !== undefined ? { swr: status.swr } : {}),
      },
    });
  }

  getCapabilitySnapshot(): { descriptors: CapabilityDescriptor[]; capabilities: CapabilityState[] } {
    return this.runtime.getCapabilitySnapshot();
  }

  getCapabilityStates(): CapabilityState[] {
    return this.runtime.getCapabilityStates();
  }

  getCapabilityDescriptors(): CapabilityDescriptor[] {
    return this.runtime.getCapabilityDescriptors();
  }
}
