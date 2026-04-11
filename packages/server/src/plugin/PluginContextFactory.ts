import path from 'path';
import type { PluginContext, QSOQueryFilter } from '@tx5dr/plugin-api';
import type { PluginLogEntry, ModeDescriptor } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { ConfigManager } from '../config/config-manager.js';
import { LogManager } from '../log/LogManager.js';
import { PluginStorageProvider } from './PluginStorageProvider.js';
import { PluginFileStoreProvider } from './PluginFileStoreProvider.js';
import { PluginTimerManager } from './PluginTimerManager.js';
import { PluginUIBridge } from './PluginUIBridge.js';
import { evaluateAutomaticTargetEligibility } from './AutoTargetEligibility.js';
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
    const bandAccess = this.createBandAccess(operatorId);
    const fileStore = new PluginFileStoreProvider(
      path.join(pluginStorageDir, 'files'),
    );

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
      files: fileStore,
      logbookSync: {
        register: (provider) => {
          this.deps.registerLogbookSyncProvider?.(plugin.definition.name, provider);
        },
      },
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
      this.deps.eventEmitter.emit('pluginLog', entry);
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

    /** Resolve the operator's callsign and its logbook instance. */
    const getLogBook = async () => {
      const callsign = deps.getOperatorById(operatorId)?.config.myCallsign;
      if (!callsign) return null;
      return LogManager.getInstance().getOrCreateLogBookByCallsign(callsign);
    };

    return {
      // === Original read-only helpers ===

      async hasWorked(callsign: string) {
        return deps.hasWorkedCallsign(operatorId, callsign);
      },
      async hasWorkedDXCC(dxccEntity: string) {
        if (!deps.hasWorkedDXCC) {
          return false;
        }
        return deps.hasWorkedDXCC(operatorId, dxccEntity);
      },
      async hasWorkedGrid(grid: string) {
        if (!deps.hasWorkedGrid) {
          return false;
        }
        return deps.hasWorkedGrid(operatorId, grid);
      },

      // === Query ===

      async queryQSOs(filter: QSOQueryFilter) {
        const logBook = await getLogBook();
        if (!logBook) return [];
        return logBook.provider.queryQSOs({
          callsign: filter.callsign,
          timeRange: filter.timeRange,
          frequencyRange: filter.frequencyRange,
          mode: filter.mode,
          qslStatus: filter.qslStatus,
          limit: filter.limit,
          offset: filter.offset,
          orderDirection: filter.orderDirection,
        });
      },

      async countQSOs(filter?: QSOQueryFilter) {
        const logBook = await getLogBook();
        if (!logBook) return 0;
        const records = await logBook.provider.queryQSOs({
          callsign: filter?.callsign,
          timeRange: filter?.timeRange,
          frequencyRange: filter?.frequencyRange,
          mode: filter?.mode,
          qslStatus: filter?.qslStatus,
        });
        return records.length;
      },

      // === Write ===

      async addQSO(record: import('@tx5dr/contracts').QSORecord) {
        const logBook = await getLogBook();
        if (!logBook) return;
        await logBook.provider.addQSO(record, operatorId);
      },

      async updateQSO(qsoId: string, updates: Partial<import('@tx5dr/contracts').QSORecord>) {
        const logBook = await getLogBook();
        if (!logBook) return;
        await logBook.provider.updateQSO(qsoId, updates);
      },

      // === Notification ===

      notifyUpdated() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        deps.eventEmitter.emit('logbookUpdated' as any, { operatorId });
      },
    };
  }

  private createBandAccess(operatorId: string) {
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
      findIdleTransmitFrequency(options?: {
        slotId?: string;
        minHz?: number;
        maxHz?: number;
        guardHz?: number;
      }) {
        if (!deps.findBestTransmitFrequency) {
          return null;
        }

        const slotId = options?.slotId ?? deps.getLatestSlotPack()?.slotId;
        if (!slotId) {
          return null;
        }

        const result = deps.findBestTransmitFrequency(
          slotId,
          options?.minHz,
          options?.maxHz,
          options?.guardHz,
        );
        return typeof result === 'number' && Number.isFinite(result) ? result : null;
      },
      evaluateAutoTargetEligibility(message: import('@tx5dr/contracts').ParsedFT8Message) {
        const operatorCallsign = deps.getOperatorById(operatorId)?.config.myCallsign ?? '';
        return evaluateAutomaticTargetEligibility(operatorCallsign, message);
      },
    };
  }
}
