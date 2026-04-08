import type { PluginContext } from '@tx5dr/plugin-api';
import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents, PluginLogEntry, ModeDescriptor } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { ConfigManager } from '../config/config-manager.js';
import { PluginStorageProvider } from './PluginStorageProvider.js';
import { PluginTimerManager } from './PluginTimerManager.js';
import { PluginUIBridge } from './PluginUIBridge.js';
import type { LoadedPlugin, PluginManagerDeps } from './types.js';

const logger = createLogger('PluginContextFactory');

/**
 * 为每个插件×操作员创建 PluginContext 实例
 */
export class PluginContextFactory {
  constructor(private deps: PluginManagerDeps) {}

  create(
    plugin: LoadedPlugin,
    operatorId: string,
    pluginStorageDir: string,
    onTimer: (timerId: string) => void,
    getPluginSettings: () => Record<string, unknown>,
  ): PluginContext {
    const globalStorage = new PluginStorageProvider(`${pluginStorageDir}/global.json`);
    const operatorStorage = new PluginStorageProvider(`${pluginStorageDir}/operator-${operatorId}.json`);

    // 初始化存储（异步，忽略错误由 init 内部处理）
    globalStorage.init().catch(err => logger.warn('Failed to init global storage', { error: err }));
    operatorStorage.init().catch(err => logger.warn('Failed to init operator storage', { error: err }));

    const timerManager = new PluginTimerManager(plugin.definition.name, onTimer);
    const uiBridge = new PluginUIBridge(plugin.definition.name, operatorId, this.deps.eventEmitter);
    const pluginLogger = this.createLogger(plugin.definition.name);
    const operatorControl = this.createOperatorControl(operatorId);
    const radioControl = this.createRadioControl();
    const logbookAccess = this.createLogbookAccess(operatorId);
    const bandAccess = this.createBandAccess();

    const ctx: PluginContext = {
      get config() {
        return Object.freeze({ ...getPluginSettings() });
      },
      store: {
        global: globalStorage,
        operator: operatorStorage,
      },
      log: pluginLogger,
      timers: timerManager,
      operator: operatorControl,
      radio: radioControl,
      logbook: logbookAccess,
      band: bandAccess,
      ui: uiBridge,
      fetch: plugin.definition.permissions?.includes('network')
        ? (url, init) => globalThis.fetch(url, init)
        : undefined,
    };

    return ctx;
  }

  private createLogger(pluginName: string) {
    const emit = (level: PluginLogEntry['level'], message: string, data?: unknown) => {
      const entry: PluginLogEntry = {
        pluginName,
        level,
        message,
        data,
        timestamp: Date.now(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.deps.eventEmitter as any).emit('pluginLog', entry);
      // 也写到系统日志
      const sysLogger = createLogger(`Plugin:${pluginName}`);
      sysLogger[level](message, typeof data === 'object' && data ? data as Record<string, unknown> : { data });
    };

    return {
      debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
      info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
      warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
      error: (msg: string, error?: unknown) => emit('error', msg, error),
    };
  }

  private createOperatorControl(operatorId: string) {
    const deps = this.deps;
    return {
      get id() { return operatorId; },
      get isTransmitting() {
        return deps.getOperatorById(operatorId)?.isTransmitting ?? false;
      },
      get callsign() {
        return deps.getOperatorById(operatorId)?.config.myCallsign ?? '';
      },
      get grid() {
        return deps.getOperatorById(operatorId)?.config.myGrid ?? '';
      },
      get frequency() {
        return deps.getOperatorById(operatorId)?.config.frequency ?? 0;
      },
      get mode(): ModeDescriptor {
        return deps.getOperatorById(operatorId)?.config.mode ?? MODES.FT8;
      },
      get transmitCycles() {
        return deps.getOperatorById(operatorId)?.getTransmitCycles() ?? [];
      },
      get automation() {
        return deps.getOperatorAutomationSnapshot(operatorId);
      },
      startTransmitting() {
        deps.getOperatorById(operatorId)?.start();
      },
      stopTransmitting() {
        deps.getOperatorById(operatorId)?.stop();
      },
      call(callsign: string, lastMessage?: { message: import('@tx5dr/contracts').FrameMessage; slotInfo: import('@tx5dr/contracts').SlotInfo }) {
        deps.requestOperatorCall(operatorId, callsign, lastMessage);
      },
      setTransmitCycles(cycles: number | number[]) {
        deps.getOperatorById(operatorId)?.setTransmitCycles(cycles);
      },
      async hasWorkedCallsign(callsign: string) {
        return deps.hasWorkedCallsign(operatorId, callsign);
      },
      isTargetBeingWorkedByOthers(targetCallsign: string) {
        return deps.getOperatorById(operatorId)?.isTargetBeingWorkedByOthers(targetCallsign) ?? false;
      },
      recordQSO(record: import('@tx5dr/contracts').QSORecord) {
        deps.getOperatorById(operatorId)?.recordQSOLog(record);
      },
      notifySlotsUpdated(slots: import('@tx5dr/contracts').OperatorSlots) {
        deps.getOperatorById(operatorId)?.notifySlotsUpdated(slots);
      },
      notifyStateChanged(state: string) {
        deps.getOperatorById(operatorId)?.notifyStateChanged(state);
      },
    };
  }

  private createRadioControl() {
    const deps = this.deps;
    return {
      get frequency() {
        return ConfigManager.getInstance().getLastSelectedFrequency()?.frequency ?? 0;
      },
      get band() {
        return deps.getRadioBand();
      },
      get isConnected() {
        return deps.getRadioConnected();
      },
      async setFrequency(freq: number) {
        deps.setRadioFrequency(freq);
      },
    };
  }

  private createLogbookAccess(operatorId: string) {
    const deps = this.deps;
    return {
      async hasWorked(callsign: string) {
        return deps.hasWorkedCallsign(operatorId, callsign);
      },
      async hasWorkedDXCC(_dxccEntity: string) {
        // TODO: implement DXCC lookup via LogManager
        return false;
      },
      async hasWorkedGrid(_grid: string) {
        // TODO: implement grid lookup via LogManager
        return false;
      },
    };
  }

  private createBandAccess() {
    const deps = this.deps;
    return {
      getActiveCallers() {
        // 从最新 SlotPack 中提取 CQ 消息
        const slotPack = deps.getLatestSlotPack();
        if (!slotPack) return [];
        // 返回空数组，插件通过 onDecode hook 获取解码消息
        return [];
      },
      getLatestSlotPack() {
        return deps.getLatestSlotPack();
      },
    };
  }
}
