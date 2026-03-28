/**
 * RadioCapabilityManager - 统一电台控制能力管理器
 *
 * 职责：
 * - 连接时探测各能力是否支持，读取初始值，启动轮询
 * - 轮询检测到值变化时 emit 'capabilityChanged'
 * - 接收写命令，路由到对应的连接层方法
 * - 断开时停止轮询、清空缓存
 */

import { EventEmitter } from 'eventemitter3';
import type { CapabilityState } from '@tx5dr/contracts';
import type { IRadioConnection } from './connections/IRadioConnection.js';
import { RadioConnectionType } from './connections/IRadioConnection.js';
import { HamlibConnection } from './connections/HamlibConnection.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioCapabilityManager');

// ===== 能力静态配置 =====

interface CapabilityConfig {
  updateMode: 'polling' | 'event' | 'none';
  pollIntervalMs?: number;
  readable: boolean;
  writable: boolean;
}

const CAPABILITY_CONFIGS: Record<string, CapabilityConfig> = {
  tuner_switch: { updateMode: 'polling', pollIntervalMs: 5000, readable: true, writable: true },
  tuner_tune:   { updateMode: 'none',    readable: false, writable: true },
  rf_power:     { updateMode: 'polling', pollIntervalMs: 10000, readable: true, writable: true },
  af_gain:      { updateMode: 'polling', pollIntervalMs: 10000, readable: true, writable: true },
  sql:          { updateMode: 'polling', pollIntervalMs: 10000, readable: true, writable: true },
  mic_gain:     { updateMode: 'polling', pollIntervalMs: 10000, readable: true, writable: true },
  nb:           { updateMode: 'polling', pollIntervalMs: 10000, readable: true, writable: true },
  nr:           { updateMode: 'polling', pollIntervalMs: 10000, readable: true, writable: true },
};

// ===== 能力读取路由表 =====

type ReadFn = (conn: IRadioConnection) => Promise<boolean | number>;
type WriteFn = (conn: IRadioConnection, value: boolean | number) => Promise<void>;
type ActionFn = (conn: IRadioConnection) => Promise<void>;

const READ_MAP: Record<string, ReadFn> = {
  tuner_switch: (c) => c.getTunerStatus!().then((s) => s.enabled),
  rf_power:     (c) => c.getRFPower!(),
  af_gain:      (c) => c.getAFGain!(),
  sql:          (c) => c.getSQL!(),
  mic_gain:     (c) => c.getMicGain!(),
  nb:           (c) => c.getNBEnabled!(),
  nr:           (c) => c.getNREnabled!(),
};

const WRITE_MAP: Record<string, WriteFn> = {
  tuner_switch: (c, v) => c.setTuner!(v as boolean),
  rf_power:     (c, v) => c.setRFPower!(v as number),
  af_gain:      (c, v) => c.setAFGain!(v as number),
  sql:          (c, v) => c.setSQL!(v as number),
  mic_gain:     (c, v) => c.setMicGain!(v as number),
  nb:           (c, v) => c.setNBEnabled!(v as number),
  nr:           (c, v) => c.setNREnabled!(v as number),
};

const ACTION_MAP: Record<string, ActionFn> = {
  tuner_tune: (c) => c.startTuning!().then(() => {}),
};

// ===== 事件接口 =====

export interface RadioCapabilityManagerEvents {
  capabilityList: (data: { capabilities: CapabilityState[] }) => void;
  capabilityChanged: (state: CapabilityState) => void;
}

// ===== 主类 =====

export class RadioCapabilityManager extends EventEmitter<RadioCapabilityManagerEvents> {
  private connection: IRadioConnection | null = null;
  private supportedCapabilities: Set<string> = new Set();
  private valueCache: Map<string, CapabilityState> = new Map();
  private pollingTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  /**
   * 电台连接成功时调用。
   * 探测各能力支持性 → 读取初始值 → 启动轮询 → emit capabilityList
   */
  async onConnected(connection: IRadioConnection): Promise<void> {
    this.connection = connection;

    logger.info('Probing radio capabilities');
    await this.probeCapabilities();
    await this.readInitialValues();
    this.startPolling();

    logger.info('Capability probe complete', {
      supported: Array.from(this.supportedCapabilities),
    });

    this.emit('capabilityList', { capabilities: this.buildSnapshot() });
  }

  /**
   * 电台断开时调用。
   * 停止所有轮询，清空缓存，广播全部 unsupported。
   */
  onDisconnected(): void {
    this.stopAllPolling();
    this.connection = null;
    this.supportedCapabilities.clear();
    this.valueCache.clear();

    // 广播空列表，让前端清空状态
    this.emit('capabilityList', { capabilities: [] });
  }

  /**
   * 写入能力值（由 PhysicalRadioManager / WSServer 调用）
   */
  async writeCapability(id: string, value?: boolean | number, action?: boolean): Promise<void> {
    if (!this.connection) {
      throw new Error('Radio not connected');
    }

    if (!this.supportedCapabilities.has(id)) {
      throw new Error(`Capability '${id}' is not supported by current radio`);
    }

    if (action) {
      // action 类能力（如 tuner_tune）
      const actionFn = ACTION_MAP[id];
      if (!actionFn) throw new Error(`No action handler for capability '${id}'`);
      logger.info(`Executing action: ${id}`);
      await actionFn(this.connection);

      // action 后更新天调 meta 状态（tuner_tune 触发调谐中）
      if (id === 'tuner_tune') {
        const tunerState = this.valueCache.get('tuner_switch');
        if (tunerState) {
          const updatedState: CapabilityState = {
            ...tunerState,
            meta: { ...tunerState.meta, status: 'tuning' },
            updatedAt: Date.now(),
          };
          this.valueCache.set('tuner_switch', updatedState);
          this.emit('capabilityChanged', updatedState);
        }
      }
      return;
    }

    if (value === undefined) {
      throw new Error(`Value required for capability '${id}'`);
    }

    const writeFn = WRITE_MAP[id];
    if (!writeFn) throw new Error(`No write handler for capability '${id}'`);

    logger.info(`Writing capability: ${id} = ${value}`);
    await writeFn(this.connection, value);

    // 写后立即更新缓存（乐观更新），并触发重读确认
    const optimisticState: CapabilityState = {
      id,
      supported: true,
      value,
      meta: this.valueCache.get(id)?.meta,
      updatedAt: Date.now(),
    };
    this.valueCache.set(id, optimisticState);
    this.emit('capabilityChanged', optimisticState);

    // 延迟 500ms 回读确认
    setTimeout(() => this.pollCapabilityOnce(id), 500);
  }

  /**
   * 获取当前所有能力的状态快照（用于 REST 接口）
   */
  getCapabilityStates(): CapabilityState[] {
    return this.buildSnapshot();
  }

  // ===== 私有方法 =====

  /**
   * 探测各能力是否被当前电台支持
   */
  private async probeCapabilities(): Promise<void> {
    if (!this.connection) return;

    // ----- 天调（tuner_switch / tuner_tune）-----
    if (this.connection.getTunerCapabilities) {
      try {
        const caps = await this.connection.getTunerCapabilities();
        if (caps.hasSwitch) {
          this.supportedCapabilities.add('tuner_switch');
          logger.debug('Capability supported: tuner_switch');
        }
        if (caps.hasManualTune) {
          this.supportedCapabilities.add('tuner_tune');
          logger.debug('Capability supported: tuner_tune');
        }
      } catch (error) {
        logger.warn('Failed to probe tuner capabilities', error);
      }
    }

    // ----- Hamlib Level 类（基于 supportedLevels Set，零额外 CAT 命令）-----
    if (this.connection.getType() === RadioConnectionType.HAMLIB) {
      const hamlibConn = this.connection as HamlibConnection;
      const levelMap: Record<string, string> = {
        rf_power: 'RFPOWER',
        af_gain:  'AF',
        sql:      'SQL',
        mic_gain: 'MICGAIN',
      };
      for (const [capId, levelName] of Object.entries(levelMap)) {
        if (hamlibConn.isSupportedLevel(levelName)) {
          this.supportedCapabilities.add(capId);
          logger.debug(`Capability supported: ${capId} (Hamlib level: ${levelName})`);
        }
      }
    }

    // ----- 需要主动探测的可选能力（icom-wlan / hamlib function）-----
    const optionalProbes: Array<[string, () => Promise<number> | undefined]> = [
      ['af_gain',  () => this.connection?.getAFGain?.()],
      ['sql',      () => this.connection?.getSQL?.()],
      ['rf_power', () => this.connection?.getRFPower?.()],
      ['mic_gain', () => this.connection?.getMicGain?.()],
      ['nb',       () => this.connection?.getNBEnabled?.()],
      ['nr',       () => this.connection?.getNREnabled?.()],
    ];

    for (const [capId, probeFn] of optionalProbes) {
      if (this.supportedCapabilities.has(capId)) {
        continue;
      }

      if (!probeFn()) continue;
      try {
        await probeFn();
        this.supportedCapabilities.add(capId);
        logger.debug(`Capability supported: ${capId} (probe succeeded)`);
      } catch {
        logger.debug(`Capability not supported: ${capId} (probe failed)`);
      }
    }
  }

  /**
   * 读取所有已支持能力的初始值
   */
  private async readInitialValues(): Promise<void> {
    for (const id of this.supportedCapabilities) {
      await this.pollCapabilityOnce(id);
    }
  }

  /**
   * 启动各能力的轮询定时器
   */
  private startPolling(): void {
    for (const id of this.supportedCapabilities) {
      const config = CAPABILITY_CONFIGS[id];
      if (!config || config.updateMode !== 'polling' || !config.pollIntervalMs) continue;
      if (!config.readable) continue;

      const timer = setInterval(() => {
        this.pollCapabilityOnce(id).catch(() => {/* poll failure silently ignored */});
      }, config.pollIntervalMs);

      this.pollingTimers.set(id, timer);
      logger.debug(`Started polling for ${id} (interval: ${config.pollIntervalMs}ms)`);
    }
  }

  /**
   * 停止所有轮询
   */
  private stopAllPolling(): void {
    for (const [id, timer] of this.pollingTimers) {
      clearInterval(timer);
      logger.debug(`Stopped polling for ${id}`);
    }
    this.pollingTimers.clear();
  }

  /**
   * 单次轮询某个能力值，若变化则 emit capabilityChanged
   */
  private async pollCapabilityOnce(id: string): Promise<void> {
    if (!this.connection) return;

    const readFn = READ_MAP[id];
    if (!readFn) return;

    try {
      const newValue = await readFn(this.connection);
      const cached = this.valueCache.get(id);

      if (!cached || cached.value !== newValue) {
        const newState: CapabilityState = {
          id,
          supported: true,
          value: newValue,
          meta: cached?.meta,
          updatedAt: Date.now(),
        };

        // tuner_switch 轮询后更新 meta.status
        if (id === 'tuner_switch') {
          const currentMeta = cached?.meta ?? {};
          // 若之前状态为 tuning，保留（稍后由 startTuning 完成回调更新）
          newState.meta = currentMeta.status === 'tuning' ? currentMeta : { ...currentMeta, status: 'idle' };
        }

        this.valueCache.set(id, newState);

        if (cached) {
          // 非首次读取才广播（首次由 readInitialValues → capabilityList 广播）
          logger.debug(`Capability changed: ${id} = ${newValue}`);
          this.emit('capabilityChanged', newState);
        }
      }
    } catch (error) {
      logger.debug(`Failed to poll capability ${id}`, error);
    }
  }

  /**
   * 构建当前所有能力的快照列表
   */
  private buildSnapshot(): CapabilityState[] {
    const allIds = Object.keys(CAPABILITY_CONFIGS);
    return allIds.map((id) => {
      const cached = this.valueCache.get(id);
      if (cached) return cached;

      // 已支持但尚未读到值（不应出现，保险起见）
      if (this.supportedCapabilities.has(id)) {
        return {
          id,
          supported: true,
          value: null,
          updatedAt: Date.now(),
        };
      }

      // 未支持
      return {
        id,
        supported: false,
        value: null,
        updatedAt: Date.now(),
      };
    });
  }
}
