import path from 'path';
import type {
  LogbookSyncProvider,
  PluginContext,
  PluginUIInstanceTarget,
  QSOQueryFilter,
} from '@tx5dr/plugin-api';
import type {
  LogBookStatistics,
  PluginLogEntry,
  PluginPanelDescriptor,
  PluginPanelMetaPayload,
  ModeDescriptor,
  PluginUIPageDescriptor,
  PluginPermission,
  RadioPowerTarget,
  WriteCapabilityPayload,
} from '@tx5dr/contracts';
import { MODES, RadioPowerTargetSchema, WriteCapabilityPayloadSchema } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { LogManager } from '../log/LogManager.js';
import { PluginStorageProvider } from './PluginStorageProvider.js';
import { PluginFileStoreProvider } from './PluginFileStoreProvider.js';
import { PluginTimerManager } from './PluginTimerManager.js';
import { PluginUIBridge } from './PluginUIBridge.js';
import { evaluateAutomaticTargetEligibility } from './AutoTargetEligibility.js';
import { createLogger } from '../utils/logger.js';
import type { LoadedPlugin, PluginManagerDeps } from './types.js';

/**
 * 为插件实例创建 PluginContext。
 */
export class PluginContextFactory {
  constructor(
    private deps: PluginManagerDeps,
    private readonly onPanelMeta?: (payload: PluginPanelMetaPayload) => void,
    private readonly onPanelContributions?: (
      pluginName: string,
      instanceTarget: PluginUIInstanceTarget,
      groupId: string,
      panels: PluginPanelDescriptor[],
    ) => void,
  ) {}

  async create(
    plugin: LoadedPlugin,
    operatorId: string | undefined,
    instanceScope: 'operator' | 'global',
    pluginStorageDir: string,
    onTimer: (timerId: string) => void,
    getPluginSettings: () => Record<string, unknown>,
  ): Promise<PluginContext> {
    const globalStorage = new PluginStorageProvider(`${pluginStorageDir}/global.json`);
    const operatorStorageName = operatorId ? `operator-${operatorId}.json` : 'instance-global.json';
    const operatorStorage = new PluginStorageProvider(`${pluginStorageDir}/${operatorStorageName}`);

    await globalStorage.init();
    await operatorStorage.init();

    const timerManager = new PluginTimerManager(plugin.definition.name, onTimer);
    const uiBridge = new PluginUIBridge(
      plugin.definition.name,
      instanceScope === 'global'
        ? { kind: 'global' as const }
        : { kind: 'operator' as const, operatorId: operatorId ?? '__missing__' },
      this.deps.eventEmitter,
      (pluginName, instanceTarget, pageId) =>
        this.deps.listPluginPageSessions?.(pluginName, instanceTarget, pageId) ?? [],
      this.onPanelMeta,
      this.onPanelContributions,
    );
    const pluginLogger = this.createLogger(plugin.definition.name);
    const operatorControl = this.createOperatorControl(operatorId, instanceScope);
    const radioControl = this.createRadioControl(plugin);
    const logbookAccess = this.createLogbookAccess(operatorId, instanceScope);
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
          this.validateLogbookSyncProvider(plugin, provider);
          this.deps.registerLogbookSyncProvider?.(plugin.definition.name, provider);
        },
      },
      fetch: plugin.definition.permissions?.includes('network')
        ? (url, init) => globalThis.fetch(url, init)
        : undefined,
    };

    return ctx;
  }

  private validateLogbookSyncProvider(
    plugin: LoadedPlugin,
    provider: LogbookSyncProvider,
  ): void {
    if (plugin.definition.type !== 'utility') {
      throw new Error(`Logbook sync provider must come from a utility plugin: ${plugin.definition.name}`);
    }
    if ((plugin.definition.instanceScope ?? 'operator') !== 'global') {
      throw new Error(`Logbook sync provider must come from a global plugin: ${plugin.definition.name}`);
    }

    const pages = plugin.definition.ui?.pages ?? [];
    const settingsPage = pages.find((page) => page.id === provider.settingsPageId);
    if (!provider.settingsPageId || !settingsPage) {
      throw new Error(
        `Sync provider settingsPageId must reference an existing page: ${plugin.definition.name}/${provider.id}`,
      );
    }

    this.validateSyncSettingsPage(plugin.definition.name, provider, settingsPage);
  }

  private validateSyncSettingsPage(
    pluginName: string,
    provider: LogbookSyncProvider,
    settingsPage: PluginUIPageDescriptor,
  ): void {
    if ((settingsPage.resourceBinding ?? 'none') !== 'callsign') {
      throw new Error(
        `Sync provider settings page must bind callsign: ${pluginName}/${provider.settingsPageId}`,
      );
    }

    if (provider.accessScope === 'operator' && (settingsPage.accessScope ?? 'admin') !== 'operator') {
      throw new Error(
        `Operator sync provider settings page must be operator-scoped: ${pluginName}/${provider.settingsPageId}`,
      );
    }
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

  private createOperatorControl(
    operatorId: string | undefined,
    instanceScope: 'operator' | 'global',
  ) {
    const deps = this.deps;
    if (instanceScope === 'global' || !operatorId) {
      return {
        get id() { return '__global__'; },
        get isTransmitting() { return false; },
        get callsign() { return ''; },
        get grid() { return ''; },
        get frequency() { return 0; },
        get mode(): ModeDescriptor { return MODES.FT8; },
        get transmitCycles() { return []; },
        get automation() { return null; },
        startTransmitting() {},
        stopTransmitting() {},
        call(_callsign: string, _lastMessage?: { message: import('@tx5dr/contracts').FrameMessage; slotInfo: import('@tx5dr/contracts').SlotInfo }) {},
        setTransmitCycles(_cycles: number | number[]) {},
        async hasWorkedCallsign(_callsign: string) { return false; },
        isTargetBeingWorkedByOthers(_targetCallsign: string) { return false; },
        recordQSO(_record: import('@tx5dr/contracts').QSORecord) {},
        notifySlotsUpdated(_slots: import('@tx5dr/contracts').OperatorSlots) {},
        notifyStateChanged(_state: string) {},
      };
    }

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

  private createRadioControl(plugin: LoadedPlugin) {
    const deps = this.deps;
    const assertPermission = (permission: PluginPermission, action: string) => {
      if (!plugin.definition.permissions?.includes(permission)) {
        throw new Error(
          `Plugin '${plugin.definition.name}' requires permission '${permission}' to ${action}`,
        );
      }
    };

    const requireRadioCapabilitySnapshot = () => {
      if (!deps.getRadioCapabilitySnapshot) {
        throw new Error('Radio capability API is unavailable in this host');
      }
      return deps.getRadioCapabilitySnapshot;
    };

    const resolvePowerStateGetter = () => {
      if (!deps.getRadioPowerState) {
        throw new Error('Radio power API is unavailable in this host');
      }
      return deps.getRadioPowerState;
    };

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
        assertPermission('radio:control', 'set radio frequency');
        deps.setRadioFrequency(freq);
      },
      capabilities: {
        getSnapshot() {
          assertPermission('radio:read', 'read radio capabilities');
          return requireRadioCapabilitySnapshot()();
        },
        getState(id: string) {
          assertPermission('radio:read', 'read radio capability state');
          return requireRadioCapabilitySnapshot()().capabilities.find((capability) => capability.id === id) ?? null;
        },
        async refresh() {
          assertPermission('radio:read', 'refresh radio capabilities');
          if (!deps.refreshRadioCapabilities) {
            throw new Error('Radio capability refresh API is unavailable in this host');
          }
          return deps.refreshRadioCapabilities();
        },
        async write(payload: WriteCapabilityPayload) {
          assertPermission('radio:control', 'write radio capabilities');
          if (!deps.writeRadioCapability) {
            throw new Error('Radio capability write API is unavailable in this host');
          }
          await deps.writeRadioCapability(WriteCapabilityPayloadSchema.parse(payload));
        },
      },
      power: {
        async getSupport(profileId?: string) {
          assertPermission('radio:read', 'read radio power support');
          if (!deps.getRadioPowerSupport) {
            throw new Error('Radio power support API is unavailable in this host');
          }
          return deps.getRadioPowerSupport(profileId);
        },
        getState(profileId?: string) {
          assertPermission('radio:read', 'read radio power state');
          return resolvePowerStateGetter()(profileId);
        },
        async set(state: RadioPowerTarget, options?: { profileId?: string; autoEngine?: boolean }) {
          assertPermission('radio:power', 'control radio power');
          if (!deps.setRadioPower) {
            throw new Error('Radio power control API is unavailable in this host');
          }
          return deps.setRadioPower(RadioPowerTargetSchema.parse(state), options);
        },
      },
    };
  }

  private createLogbookAccess(
    operatorId: string | undefined,
    instanceScope: 'operator' | 'global',
  ) {
    const deps = this.deps;
    const logManager = LogManager.getInstance();

    const createCallsignAccess = (callsign: string) => {
      const normalizedCallsign = callsign.trim().toUpperCase();

      const getExistingLogBook = () => {
        const logBookId = logManager.resolveLogBookId(normalizedCallsign);
        return logBookId ? logManager.getLogBook(logBookId) : null;
      };

      const getOrCreateLogBook = async () => {
        if (!normalizedCallsign) {
          return null;
        }
        return logManager.getOrCreateLogBookByCallsign(normalizedCallsign);
      };

      const buildQuery = (filter?: QSOQueryFilter) => ({
        callsign: filter?.callsign,
        timeRange: filter?.timeRange,
        frequencyRange: filter?.frequencyRange,
        mode: filter?.mode,
        qslStatus: filter?.qslStatus,
        limit: filter?.limit,
        offset: filter?.offset,
        orderDirection: filter?.orderDirection,
      });

      const toLogBookStatistics = async (logBook: Awaited<ReturnType<typeof getOrCreateLogBook>>): Promise<LogBookStatistics | null> => {
        if (!logBook) {
          return null;
        }

        const rawStatistics = await logBook.provider.getStatistics();
        const connectedOperators = logManager.getOperatorIdsForLogBook(logBook.id);
        return {
          totalQSOs: rawStatistics.totalQSOs || 0,
          totalOperators: connectedOperators.length,
          uniqueCallsigns: rawStatistics.uniqueCallsigns || 0,
          lastQSO: rawStatistics.lastQSOTime ? new Date(rawStatistics.lastQSOTime).toISOString() : undefined,
          firstQSO: rawStatistics.firstQSOTime ? new Date(rawStatistics.firstQSOTime).toISOString() : undefined,
          dxcc: rawStatistics.dxcc,
        };
      };

      return {
        get callsign() {
          return normalizedCallsign;
        },
        async getLogBookId() {
          return getExistingLogBook()?.id ?? null;
        },
        async queryQSOs(filter: QSOQueryFilter) {
          const logBook = await getOrCreateLogBook();
          if (!logBook) return [];
          return logBook.provider.queryQSOs(buildQuery(filter));
        },
        async countQSOs(filter?: QSOQueryFilter) {
          const logBook = await getOrCreateLogBook();
          if (!logBook) return 0;
          const records = await logBook.provider.queryQSOs(buildQuery(filter));
          return records.length;
        },
        async addQSO(record: import('@tx5dr/contracts').QSORecord) {
          const logBook = await getOrCreateLogBook();
          if (!logBook) return;
          await logBook.provider.addQSO(record, operatorId);
        },
        async updateQSO(qsoId: string, updates: Partial<import('@tx5dr/contracts').QSORecord>) {
          const logBook = await getOrCreateLogBook();
          if (!logBook) return;
          await logBook.provider.updateQSO(qsoId, updates);
        },
        async getStatistics() {
          const logBook = await getOrCreateLogBook();
          return toLogBookStatistics(logBook);
        },
        async notifyUpdated(explicitOperatorId?: string) {
          const logBook = await getOrCreateLogBook();
          if (!logBook) return;
          const statistics = await toLogBookStatistics(logBook);
          if (!statistics) return;
          const associatedOperatorId = explicitOperatorId
            ?? logManager.getOperatorIdsForLogBook(logBook.id)[0]
            ?? operatorId;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          deps.eventEmitter.emit('logbookUpdated' as any, {
            logBookId: logBook.id,
            statistics,
            operatorId: associatedOperatorId,
          });
        },
      };
    };

    const getBoundCallsign = () => {
      if (instanceScope !== 'operator' || !operatorId) {
        return null;
      }
      const callsign = deps.getOperatorById(operatorId)?.config.myCallsign;
      return callsign?.trim() ? callsign : null;
    };

    return {
      // === Original read-only helpers ===

      async hasWorked(callsign: string) {
        if (!operatorId) {
          return false;
        }
        return deps.hasWorkedCallsign(operatorId, callsign);
      },
      async hasWorkedDXCC(dxccEntity: string) {
        if (!deps.hasWorkedDXCC || !operatorId) {
          return false;
        }
        return deps.hasWorkedDXCC(operatorId, dxccEntity);
      },
      async hasWorkedGrid(grid: string) {
        if (!deps.hasWorkedGrid || !operatorId) {
          return false;
        }
        return deps.hasWorkedGrid(operatorId, grid);
      },

      // === Query ===

      async queryQSOs(filter: QSOQueryFilter) {
        const callsign = getBoundCallsign();
        if (!callsign) return [];
        return createCallsignAccess(callsign).queryQSOs(filter);
      },

      async countQSOs(filter?: QSOQueryFilter) {
        const callsign = getBoundCallsign();
        if (!callsign) return 0;
        return createCallsignAccess(callsign).countQSOs(filter);
      },

      forCallsign(callsign: string) {
        return createCallsignAccess(callsign);
      },

      // === Write ===

      async addQSO(record: import('@tx5dr/contracts').QSORecord) {
        const callsign = getBoundCallsign();
        if (!callsign) return;
        await createCallsignAccess(callsign).addQSO(record);
      },

      async updateQSO(qsoId: string, updates: Partial<import('@tx5dr/contracts').QSORecord>) {
        const callsign = getBoundCallsign();
        if (!callsign) return;
        await createCallsignAccess(callsign).updateQSO(qsoId, updates);
      },

      // === Notification ===

      async notifyUpdated() {
        const callsign = getBoundCallsign();
        if (!callsign) return;
        await createCallsignAccess(callsign).notifyUpdated(operatorId);
      },
    };
  }

  private createBandAccess(operatorId: string | undefined) {
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
        const operatorCallsign = operatorId
          ? deps.getOperatorById(operatorId)?.config.myCallsign ?? ''
          : '';
        return evaluateAutomaticTargetEligibility(operatorCallsign, message);
      },
    };
  }
}
