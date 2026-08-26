import path from 'path';
import { createSocket } from 'node:dgram';
import * as hostHamlib from 'hamlib';
import type { RemoteInfo, Socket, SocketType } from 'node:dgram';
import {
  getBandFromFrequency,
  getStandardDigitalFrequencyMatch,
  LogbookOperationError,
  toAdifMode,
} from '@tx5dr/core';
import { getPluginContextCapabilityKeys } from '@tx5dr/plugin-api';
import type {
  HostSettingsControl,
  HamlibHostDependency,
  LogbookSyncProvider,
  OtherOperatorSnapshot,
  PluginContextBase,
  RuntimePluginContext,
  RadioOperatingMode,
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
  EngineMode,
} from '@tx5dr/contracts';
import {
  MODES,
  RealtimeSettingsResponseDataSchema,
  RadioPowerTargetSchema,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { LogManager } from '../log/LogManager.js';
import type { LogBookInstance } from '../log/LogManager.js';
import { acquireSharedPluginStorage, PluginStorageProvider } from './PluginStorageProvider.js';
import { PluginFileStoreProvider } from './PluginFileStoreProvider.js';
import { PluginTimerManager } from './PluginTimerManager.js';
import { PluginUIBridge } from './PluginUIBridge.js';
import { HostSettingsService } from './HostSettingsService.js';
import { evaluateAutomaticTargetEligibility } from './AutoTargetEligibility.js';
import type { PluginEventBusOwner } from './PluginEventBusHost.js';
import { createLogger } from '../utils/logger.js';
import type { LoadedPlugin, PluginManagerDeps } from './types.js';
import { snapshotPluginData } from './plugin-data-boundary.js';

type HostHamlibModule = {
  Rotator: HamlibHostDependency['Rotator'];
  PASSBAND: HamlibHostDependency['PASSBAND'];
};

function createAllowedHamlibDependency(source: HostHamlibModule): HamlibHostDependency {
  return {
    Rotator: source.Rotator,
    PASSBAND: {
      NORMAL: source.PASSBAND.NORMAL,
      NOCHANGE: source.PASSBAND.NOCHANGE,
    },
  };
}

type SavedPluginFrequency = {
  frequency: number;
  mode?: string;
  radioMode?: string;
  band?: string;
} | null | undefined;

function snapshotPluginLogData(data: unknown): unknown {
  if (data === undefined) return undefined;
  const errorCause = data instanceof Error
    ? (data as Error & { cause?: unknown }).cause
    : undefined;
  const normalized = data instanceof Error
    ? {
        name: data.name,
        message: data.message,
        stack: data.stack,
        cause: errorCause instanceof Error
          ? { name: errorCause.name, message: errorCause.message, stack: errorCause.stack }
          : errorCause,
      }
    : data;
  try {
    return snapshotPluginData(normalized, 'json');
  } catch {
    return {
      code: 'PLUGIN_DATA_NOT_SERIALIZABLE',
      message: 'Plugin log data was not JSON-serializable',
    };
  }
}

function isValidFrequency(frequency: unknown): frequency is number {
  return typeof frequency === 'number' && Number.isFinite(frequency) && frequency > 0;
}

function normalizeModeToken(mode: string | null | undefined): string | undefined {
  const normalized = mode?.trim().toUpperCase();
  return normalized || undefined;
}

function cloneModeDescriptor(mode: ModeDescriptor): ModeDescriptor {
  return {
    ...mode,
    windowTiming: [...mode.windowTiming],
  };
}

/**
 * 为插件实例创建 PluginContext。
 */
export class PluginContextFactory {
  private readonly audioFrequencyReservationsBySlot = new Map<string, Map<string, number>>();

  constructor(
    private deps: PluginManagerDeps,
    private readonly onPanelMeta?: (payload: PluginPanelMetaPayload) => void,
    private readonly onPanelContributions?: (
      pluginName: string,
      instanceTarget: PluginUIInstanceTarget,
      groupId: string,
      panels: PluginPanelDescriptor[],
    ) => void,
    private readonly isOperatorPluginPaused: (pluginName: string, operatorId: string) => boolean = () => false,
  ) {}

  async create(
    plugin: LoadedPlugin,
    operatorId: string | undefined,
    instanceScope: 'operator' | 'global',
    pluginStorageDir: string,
    onTimer: (timerId: string) => void,
    getPluginSettings: () => Record<string, unknown>,
    updatePluginSettings?: (patch: Record<string, unknown>) => Promise<void>,
    invokeResourceCallback?: <T>(operation: string, callback: () => T | Promise<T>) => Promise<T>,
  ): Promise<RuntimePluginContext> {
    const globalStorage = await acquireSharedPluginStorage(`${pluginStorageDir}/global.json`);
    const operatorStorageName = operatorId ? `operator-${operatorId}.json` : 'instance-global.json';
    const operatorStorage = new PluginStorageProvider(`${pluginStorageDir}/${operatorStorageName}`);

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
    const contextRef: { current?: RuntimePluginContext } = {};
    const pluginLogger = this.createLogger(plugin.definition.name);
    const operatorSnapshot = this.createOperatorSnapshot(operatorId, instanceScope);
    const operatorCommands = this.createOperatorCommandPort(
      plugin,
      operatorId,
      instanceScope,
      () => contextRef.current,
    );
    const radioContext = this.createRadioContext(plugin);
    const logbookAccess = this.createLogbookAccess(operatorId, instanceScope);
    const bandAccess = this.createBandAccess(operatorId);
    const settingsControl = this.createSettingsControl(plugin);
    const fileStore = new PluginFileStoreProvider(
      path.join(pluginStorageDir, 'files'),
    );
    const networkControl = this.createNetworkControl(plugin, invokeResourceCallback);
    const eventBusControl = this.createEventBusControl(
      plugin,
      operatorId,
      instanceScope,
      invokeResourceCallback,
    );

    const baseContext: PluginContextBase = {
      get config() {
        return getPluginSettings();
      },
      async updateConfig(patch: Record<string, unknown>) {
        if (!updatePluginSettings) {
          throw new Error('updateConfig is not available for this plugin instance');
        }
        await updatePluginSettings(snapshotPluginData(patch, 'json'));
      },
      store: {
        global: globalStorage,
        operator: operatorStorage,
      },
      digitalMessagePreflight: {
        check: async (request) => {
          if (!this.deps.preflightDigitalMessage) {
            return {
              encodable: false,
              requestedText: request.text.trim().toUpperCase().replace(/\s+/g, ' '),
              reason: 'encode_failed' as const,
              error: 'preflight_unavailable',
            };
          }
          return this.deps.preflightDigitalMessage(request);
        },
      },
      log: pluginLogger,
      timers: timerManager,
      operator: operatorSnapshot,
      radio: radioContext.radio,
      band: bandAccess,
      ui: uiBridge,
      files: fileStore,
    };

    const capabilityCandidates: Partial<RuntimePluginContext> = {
      ...radioContext.capabilities,
      ...(operatorCommands ? { operatorCommands } : {}),
      ...(networkControl ? {
        network: networkControl,
        fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
      } : {}),
      ...(eventBusControl ? { eventBus: eventBusControl } : {}),
      logbook: plugin.definition.permissions?.includes('logbook:write')
        ? logbookAccess.full
        : logbookAccess.read,
      settings: settingsControl,
      logbookSync: {
        register: (provider: LogbookSyncProvider) => {
          this.validateLogbookSyncProvider(plugin, provider);
          this.deps.registerLogbookSyncProvider?.(plugin.definition.name, provider);
        },
      },
      hostDependencies: {
        hamlib: createAllowedHamlibDependency(hostHamlib as unknown as HostHamlibModule),
      },
    };
    const declaredCapabilities: Record<string, unknown> = {};
    for (const key of getPluginContextCapabilityKeys(plugin.definition.permissions)) {
      const value = capabilityCandidates[key];
      if (value !== undefined) {
        declaredCapabilities[key] = value;
      }
    }

    const ctx = Object.create(null) as RuntimePluginContext;
    Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(baseContext));
    Object.assign(ctx, declaredCapabilities);
    contextRef.current = ctx;

    return ctx;
  }

  private createEventBusControl(
    plugin: LoadedPlugin,
    operatorId: string | undefined,
    instanceScope: 'operator' | 'global',
    invokeResourceCallback?: <T>(operation: string, callback: () => T | Promise<T>) => Promise<T>,
  ): RuntimePluginContext['eventBus'] {
    const host = this.deps.pluginEventBusHost;
    if (!host) {
      return undefined;
    }

    const owner: PluginEventBusOwner = {
      pluginName: plugin.definition.name,
      instanceScope,
      operatorId: instanceScope === 'operator' ? operatorId : undefined,
    };

    return {
      publish(topic, payload) {
        host.publish(owner, topic, payload);
      },
      subscribe(topic, handler) {
        return host.subscribe(owner, topic, (message) => {
          if (!invokeResourceCallback) {
            return handler(message);
          }
          return invokeResourceCallback('event-bus:message', () => handler(message));
        });
      },
    };
  }


  private createNetworkControl(
    _plugin: LoadedPlugin,
    invokeResourceCallback?: <T>(operation: string, callback: () => T | Promise<T>) => Promise<T>,
  ): RuntimePluginContext['network'] {
    const sockets = new Set<Socket>();

    const toError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

    return {
      udp: {
        createSocket: (options?: import('@tx5dr/plugin-api').PluginUdpSocketOptions) => {
          const socketOptions = options
            ? snapshotPluginData(options, 'structured')
            : undefined;
          const socket = createSocket({
            type: (socketOptions?.type ?? 'udp4') as SocketType,
            reuseAddr: socketOptions?.reuseAddr ?? false,
          });
          sockets.add(socket);
          let bound = false;
          let closed = false;
          let messageHandler: ((data: Uint8Array, remote: import('@tx5dr/plugin-api').PluginUdpRemoteInfo) => void | Promise<void>) | undefined;
          let errorHandler: ((error: Error) => void) | undefined;
          let pendingMessages = 0;
          let messageQueue = Promise.resolve();
          const MAX_PENDING_MESSAGES = 100;
          const reportError = (error: Error) => {
            if (!errorHandler) return;
            if (invokeResourceCallback) {
              void invokeResourceCallback('network:udp-error', () => errorHandler!(error)).catch(() => undefined);
            } else {
              errorHandler(error);
            }
          };

          socket.on('message', (message: Buffer, remote: RemoteInfo) => {
            if (!messageHandler) return;
            if (pendingMessages >= MAX_PENDING_MESSAGES) {
              reportError(new Error('Plugin UDP receive queue is full'));
              return;
            }
            pendingMessages += 1;
            const payload = new Uint8Array(message);
            const remoteInfo = {
              address: remote.address,
              port: remote.port,
              family: remote.family,
              size: remote.size,
            };
            messageQueue = messageQueue.then(async () => {
              if (invokeResourceCallback) {
                await invokeResourceCallback('network:udp-message', () => messageHandler!(payload, remoteInfo));
              } else {
                await messageHandler!(payload, remoteInfo);
              }
            }).catch((error) => reportError(toError(error))).finally(() => {
              pendingMessages -= 1;
            });
          });
          socket.on('error', (error) => {
            reportError(error);
          });
          socket.on('close', () => {
            closed = true;
            sockets.delete(socket);
          });

          return {
            async bind(bindOptions?: import('@tx5dr/plugin-api').PluginUdpBindOptions) {
              if (closed) throw new Error('UDP socket is closed');
              if (bound) return;
              const detachedBindOptions = bindOptions
                ? snapshotPluginData(bindOptions, 'structured')
                : undefined;
              await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => {
                  socket.off('listening', onListening);
                  reject(error);
                };
                const onListening = () => {
                  socket.off('error', onError);
                  bound = true;
                  if (typeof socketOptions?.broadcast === 'boolean') {
                    socket.setBroadcast(socketOptions.broadcast);
                  }
                  if (typeof socketOptions?.multicastTtl === 'number') {
                    socket.setMulticastTTL(socketOptions.multicastTtl);
                  }
                  resolve();
                };
                socket.once('error', onError);
                socket.once('listening', onListening);
                socket.bind(detachedBindOptions?.port ?? 0, detachedBindOptions?.host);
              });
            },
            async send(data: Uint8Array | string, port: number, host: string) {
              if (closed) throw new Error('UDP socket is closed');
              if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error('UDP port must be an integer from 1 to 65535');
              }
              const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
              await new Promise<void>((resolve, reject) => {
                socket.send(payload, port, host, (error) => error ? reject(error) : resolve());
              });
            },
            onMessage(handler: (data: Uint8Array, remote: import('@tx5dr/plugin-api').PluginUdpRemoteInfo) => void | Promise<void>) {
              messageHandler = handler;
            },
            onError(handler: (error: Error) => void) {
              errorHandler = handler;
            },
            async close() {
              if (closed) return;
              await new Promise<void>((resolve) => {
                socket.once('close', resolve);
                try {
                  socket.close();
                } catch {
                  socket.off('close', resolve);
                  closed = true;
                  sockets.delete(socket);
                  resolve();
                }
              });
            },
          };
        },
        async closeAll() {
          await Promise.all(Array.from(sockets).map((socket) => new Promise<void>((resolve) => {
            socket.once('close', resolve);
            try {
              socket.close();
            } catch {
              socket.off('close', resolve);
              sockets.delete(socket);
              resolve();
            }
          }).catch(() => undefined)));
        },
      },
    };
  }


  private createSettingsControl(plugin: LoadedPlugin): Partial<HostSettingsControl> {
    const service = new HostSettingsService();
    const thisDeps = this.deps;
    const assertPermission = (permission: PluginPermission, action: string) => {
      if (!plugin.definition.permissions?.includes(permission)) {
        throw new Error(
          `Plugin '${plugin.definition.name}' requires permission '${permission}' to ${action}`,
        );
      }
    };

    const controls: HostSettingsControl = {
      ft8: {
        async get() {
          assertPermission('settings:ft8', 'read FT8 settings');
          return service.getFT8();
        },
        async update(patch: Parameters<HostSettingsService['updateFT8']>[0]) {
          assertPermission('settings:ft8', 'update FT8 settings');
          return service.updateFT8(snapshotPluginData(patch, 'structured'));
        },
      },
      decodeWindows: {
        async get() {
          assertPermission('settings:decode-windows', 'read decode window settings');
          return service.getDecodeWindows();
        },
        async update(settings: Parameters<HostSettingsService['updateDecodeWindows']>[0]) {
          assertPermission('settings:decode-windows', 'update decode window settings');
          return service.updateDecodeWindows(snapshotPluginData(settings, 'structured'));
        },
      },
      realtime: {
        async get() {
          assertPermission('settings:realtime', 'read realtime settings');
          return service.getRealtime();
        },
        async update(settings: Parameters<HostSettingsService['updateRealtime']>[0]) {
          assertPermission('settings:realtime', 'update realtime settings');
          const updated = await service.updateRealtime(snapshotPluginData(settings, 'structured'));
          const data = RealtimeSettingsResponseDataSchema.parse(updated);
          thisDeps.eventEmitter.emit('realtimeSettingsChanged', data);
          return updated;
        },
      },
      frequencyPresets: {
        async get() {
          assertPermission('settings:frequency-presets', 'read frequency presets');
          return service.getFrequencyPresets();
        },
        async update(presets: Parameters<HostSettingsService['updateFrequencyPresets']>[0]) {
          assertPermission('settings:frequency-presets', 'update frequency presets');
          return service.updateFrequencyPresets(snapshotPluginData(presets, 'structured'));
        },
        async reset() {
          assertPermission('settings:frequency-presets', 'reset frequency presets');
          return service.resetFrequencyPresets();
        },
      },
      station: {
        async get() {
          assertPermission('settings:station', 'read station settings');
          return service.getStation();
        },
        async update(patch: Parameters<HostSettingsService['updateStation']>[0]) {
          assertPermission('settings:station', 'update station settings');
          return service.updateStation(snapshotPluginData(patch, 'structured'));
        },
      },
      pskReporter: {
        async get() {
          assertPermission('settings:psk-reporter', 'read PSK Reporter settings');
          return service.getPSKReporter();
        },
        async update(patch: Parameters<HostSettingsService['updatePSKReporter']>[0]) {
          assertPermission('settings:psk-reporter', 'update PSK Reporter settings');
          return service.updatePSKReporter(snapshotPluginData(patch, 'structured'));
        },
      },
      ntp: {
        async get() {
          assertPermission('settings:ntp', 'read NTP settings');
          return service.getNtp();
        },
        async update(request: Parameters<HostSettingsService['updateNtp']>[0]) {
          assertPermission('settings:ntp', 'update NTP settings');
          return service.updateNtp(snapshotPluginData(request, 'structured'));
        },
      },
    };
    const permissions = new Set(plugin.definition.permissions ?? []);
    return {
      ...(permissions.has('settings:ft8') ? { ft8: controls.ft8 } : {}),
      ...(permissions.has('settings:decode-windows') ? { decodeWindows: controls.decodeWindows } : {}),
      ...(permissions.has('settings:realtime') ? { realtime: controls.realtime } : {}),
      ...(permissions.has('settings:frequency-presets') ? { frequencyPresets: controls.frequencyPresets } : {}),
      ...(permissions.has('settings:station') ? { station: controls.station } : {}),
      ...(permissions.has('settings:psk-reporter') ? { pskReporter: controls.pskReporter } : {}),
      ...(permissions.has('settings:ntp') ? { ntp: controls.ntp } : {}),
    };
  }

  private validateLogbookSyncProvider(
    plugin: LoadedPlugin,
    provider: LogbookSyncProvider,
  ): void {
    if (!plugin.definition.permissions?.includes('logbook:sync')) {
      throw new Error(`Plugin must declare logbook:sync to register a sync provider: ${plugin.definition.name}`);
    }
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
      const snapshot = snapshotPluginLogData(data);
      const entry: PluginLogEntry = {
        pluginName,
        level,
        message,
        data: snapshot,
        timestamp: Date.now(),
      };
      this.deps.eventEmitter.emit('pluginLog', entry);
      // 也写到系统日志
      const sysLogger = createLogger(`Plugin:${pluginName}`);
      sysLogger[level](message, typeof snapshot === 'object' && snapshot
        ? snapshot as Record<string, unknown>
        : { data: snapshot });
    };

    return {
      debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
      info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
      warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
      error: (msg: string, error?: unknown) => emit('error', msg, error),
    };
  }

  private createOperatorCommandPort(
    plugin: LoadedPlugin,
    operatorId: string | undefined,
    instanceScope: 'operator' | 'global',
    getContext: () => RuntimePluginContext | undefined,
  ): RuntimePluginContext['operatorCommands'] {
    if (instanceScope === 'global'
        || !operatorId
        || plugin.definition.apiVersion !== 2) {
      return undefined;
    }

    const deps = this.deps;
    const assertTransmitControlAllowed = (action: string): void => {
      if (!plugin.definition.permissions?.includes('operator:transmit-control')) {
        throw new Error(
          `Plugin '${plugin.definition.name}' cannot ${action}. Add permissions: ['operator:transmit-control'] and a transmit-control eligibility predicate before using operator commands.`,
        );
      }
      const isTransmitControlEnabled = plugin.definition.isTransmitControlEnabled
        ?? plugin.definition.isAutoCallEnabled;
      if (typeof isTransmitControlEnabled !== 'function') {
        throw new Error(
          `Plugin '${plugin.definition.name}' must implement isTransmitControlEnabled(ctx) or isAutoCallEnabled(ctx) before using operator commands.`,
        );
      }

      const ctx = getContext();
      if (!ctx) {
        throw new Error(`Plugin '${plugin.definition.name}' cannot ${action} before its PluginContext is ready`);
      }

      if (operatorId && this.isOperatorPluginPaused(plugin.definition.name, operatorId)) {
        throw new Error(
          `Plugin '${plugin.definition.name}' cannot ${action} because automatic calling is paused for operator '${operatorId}'. Resume this plugin for the operator before using operator transmit-control APIs.`,
        );
      }

      let enabled = false;
      try {
        const eligibilityContext = Object.freeze({
          config: snapshotPluginData(ctx.config, 'structured'),
        });
        enabled = isTransmitControlEnabled(eligibilityContext) === true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Plugin '${plugin.definition.name}' failed to evaluate its transmit-control eligibility before ${action}: ${message}`,
        );
      }

      if (!enabled) {
        throw new Error(
          `Plugin '${plugin.definition.name}' cannot ${action} because its transmit-control eligibility predicate returned false.`,
        );
      }
    };

    return {
      async submit(command) {
        assertTransmitControlAllowed(`submit operator command '${command.type}'`);
        if (!deps.submitOperatorCommand) {
          throw new Error('Host operator command coordinator is unavailable');
        }
        return deps.submitOperatorCommand(
          operatorId,
          snapshotPluginData(command, 'structured'),
          plugin.definition.name,
        );
      },
    };
  }

  private createOperatorSnapshot(
    operatorId: string | undefined,
    instanceScope: 'operator' | 'global',
  ): PluginContextBase['operator'] {
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
        get maxConcurrentStreams() { return 1; },
        get automation() { return null; },
        getOtherOperators: () => this.createOtherOperatorSnapshots(undefined),
        async hasWorkedCallsign(_callsign: string, _options?: { anyBand?: boolean }) { return false; },
        isTargetBeingWorkedByOthers(_targetCallsign: string) { return false; },
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
      get maxConcurrentStreams() {
        const configured = deps.getOperatorById(operatorId)?.config.maxConcurrentStreams ?? 3;
        const standardFrequency = getStandardDigitalFrequencyMatch(
          deps.getCurrentMode().name,
          deps.getKnownRadioFrequency?.() ?? null,
        );
        return standardFrequency ? 1 : configured;
      },
      get automation() {
        return deps.getOperatorAutomationSnapshot(operatorId);
      },
      getOtherOperators: () => this.createOtherOperatorSnapshots(operatorId),
      async hasWorkedCallsign(callsign: string, options?: { anyBand?: boolean }) {
        return deps.hasWorkedCallsign(
          operatorId,
          callsign,
          options ? snapshotPluginData(options, 'structured') : undefined,
        );
      },
      isTargetBeingWorkedByOthers(targetCallsign: string) {
        return deps.getOperatorById(operatorId)?.isTargetBeingWorkedByOthers(targetCallsign) ?? false;
      },
    };
  }

  private createOtherOperatorSnapshots(operatorId: string | undefined): OtherOperatorSnapshot[] {
    return this.deps.getOperators()
      .filter((operator) => !operatorId || operator.config.id !== operatorId)
      .map((operator) => ({
        id: operator.config.id,
        callsign: operator.config.myCallsign ?? '',
        grid: operator.config.myGrid ?? '',
        audioFrequencyHz: operator.config.frequency ?? 0,
        mode: cloneModeDescriptor(operator.config.mode ?? MODES.FT8),
        isTransmitting: operator.isTransmitting,
        transmitCycles: operator.getTransmitCycles(),
        automation: this.deps.getOperatorAutomationSnapshot(operator.config.id),
      }));
  }

  private getOtherOperatorAudioFrequenciesHz(
    operatorId: string | undefined,
    slotId?: string,
  ): number[] {
    const reservations = slotId
      ? this.audioFrequencyReservationsBySlot.get(slotId)
      : undefined;
    return this.createOtherOperatorSnapshots(operatorId)
      .map((operator) => reservations?.get(operator.id) ?? operator.audioFrequencyHz)
      .filter((frequency) => (
        typeof frequency === 'number'
        && Number.isFinite(frequency)
        && frequency >= 0
        && frequency <= 3000
      ));
  }

  private reserveOperatorAudioFrequency(
    operatorId: string | undefined,
    slotId: string,
    frequency: number,
  ): void {
    if (!operatorId) {
      return;
    }

    let reservations = this.audioFrequencyReservationsBySlot.get(slotId);
    if (!reservations) {
      reservations = new Map();
      this.audioFrequencyReservationsBySlot.set(slotId, reservations);
      while (this.audioFrequencyReservationsBySlot.size > 4) {
        const oldestSlotId = this.audioFrequencyReservationsBySlot.keys().next().value;
        if (oldestSlotId === undefined) {
          break;
        }
        this.audioFrequencyReservationsBySlot.delete(oldestSlotId);
      }
    }
    reservations.set(operatorId, frequency);
  }

  private createRadioContext(plugin: LoadedPlugin): {
    radio: PluginContextBase['radio'];
    capabilities: Omit<RuntimePluginContext, keyof PluginContextBase>;
  } {
    const deps = this.deps;
    const configManager = ConfigManager.getInstance();

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

    const getEngineMode = (): EngineMode => deps.getEngineMode?.() ?? configManager.getLastEngineMode();
    const getSavedFrequencyForEngineMode = (): SavedPluginFrequency => {
      switch (getEngineMode()) {
        case 'voice':
          return configManager.getLastVoiceFrequency();
        case 'cw':
          return configManager.getLastCWFrequency();
        case 'digital':
        default:
          return configManager.getLastSelectedFrequency();
      }
    };

    const getModeDescriptorForEngineMode = (): ModeDescriptor => {
      switch (getEngineMode()) {
        case 'voice':
          return MODES.VOICE;
        case 'cw':
          return MODES.CW;
        case 'digital':
        default:
          return deps.getCurrentMode();
      }
    };

    const getCurrentRadioMode = (): string | undefined => {
      const savedFrequency = getSavedFrequencyForEngineMode();
      const hostRadioMode = normalizeModeToken(deps.getCurrentRadioMode?.());
      if (hostRadioMode) {
        return hostRadioMode;
      }

      const savedRadioMode = normalizeModeToken(savedFrequency?.radioMode);
      if (savedRadioMode) {
        return savedRadioMode;
      }

      if (getEngineMode() === 'voice') {
        return 'USB';
      }
      if (getEngineMode() === 'cw') {
        return 'CW';
      }
      return undefined;
    };

    const getOperatingMode = (): RadioOperatingMode => {
      const engineMode = getEngineMode();
      const descriptor = getModeDescriptorForEngineMode();
      const radioMode = getCurrentRadioMode();
      const baseMode = engineMode === 'voice'
        ? (radioMode ?? 'USB')
        : engineMode === 'cw'
          ? 'CW'
          : descriptor.name;
      const projected = toAdifMode({ mode: baseMode });

      return {
        engineMode,
        mode: projected.mode,
        ...(projected.submode ? { submode: projected.submode } : {}),
        ...(radioMode ? { radioMode } : {}),
        descriptor,
      };
    };

    const getKnownFrequency = (): number | null => {
      const knownFrequency = deps.getKnownRadioFrequency?.();
      if (isValidFrequency(knownFrequency)) {
        return knownFrequency;
      }
      return null;
    };

    const getEffectiveFrequency = (): number => {
      const knownFrequency = getKnownFrequency();
      if (knownFrequency !== null) {
        return knownFrequency;
      }

      const savedFrequency = getSavedFrequencyForEngineMode()?.frequency;
      return isValidFrequency(savedFrequency) ? savedFrequency : 0;
    };

    const resolveBandFromFrequency = (frequency: number): string | null => {
      if (!isValidFrequency(frequency)) {
        return null;
      }
      try {
        const band = getBandFromFrequency(frequency);
        return band && band !== 'Unknown' ? band : null;
      } catch {
        return null;
      }
    };

    const radio: PluginContextBase['radio'] = {
      get frequency() {
        return getEffectiveFrequency();
      },
      get band() {
        const derivedBand = resolveBandFromFrequency(getKnownFrequency() ?? 0);
        if (derivedBand) {
          return derivedBand;
        }

        return getSavedFrequencyForEngineMode()?.band || deps.getRadioBand();
      },
      get mode() {
        return getOperatingMode();
      },
      get isConnected() {
        return deps.getRadioConnected();
      },
    };

    const capabilities: Omit<RuntimePluginContext, keyof PluginContextBase> = {};
    capabilities.radioCapabilities = {
        getSnapshot() {
          return requireRadioCapabilitySnapshot()();
        },
        getState(id: string) {
          return requireRadioCapabilitySnapshot()().capabilities.find((capability) => capability.id === id) ?? null;
        },
        async refresh() {
          if (!deps.refreshRadioCapabilities) {
            throw new Error('Radio capability refresh API is unavailable in this host');
          }
          return deps.refreshRadioCapabilities();
        },
    };
    capabilities.radioPower = {
        async getSupport(profileId?: string) {
          if (!deps.getRadioPowerSupport) {
            throw new Error('Radio power support API is unavailable in this host');
          }
          return deps.getRadioPowerSupport(profileId);
        },
        getState(profileId?: string) {
          return resolvePowerStateGetter()(profileId);
        },
    };
    capabilities.radioCommands = {
        async submit(command) {
          if (!deps.submitRadioMaintenanceCommand) {
            throw new Error('Host radio maintenance coordinator is unavailable');
          }
          if (command.type === 'switch-band'
              && command.autoTune === true
              && !plugin.definition.permissions?.includes('radio:tuner-control')) {
            throw new Error('switch-band autoTune requires radio:tuner-control');
          }
          await deps.submitRadioMaintenanceCommand(snapshotPluginData(command, 'structured'));
        },
    };
    capabilities.radioTunerCommands = {
        async submit(command) {
          if (!deps.submitRadioMaintenanceCommand) {
            throw new Error('Host radio maintenance coordinator is unavailable');
          }
          await deps.submitRadioMaintenanceCommand(snapshotPluginData(command, 'structured'));
        },
    };
    capabilities.radioPowerCommands = {
        async submit(command) {
          if (!deps.setRadioPower) {
            throw new Error('Radio power control API is unavailable in this host');
          }
          const detached = snapshotPluginData(command, 'structured');
          return deps.setRadioPower(
            RadioPowerTargetSchema.parse(detached.state),
            detached.options,
          );
        },
    };

    return { radio, capabilities };
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

      const getRequiredLogBook = (): LogBookInstance => {
        const logBook = getExistingLogBook();
        if (!logBook) {
          throw new LogbookOperationError(
            'LOGBOOK_UNAVAILABLE',
            `Logbook for ${normalizedCallsign || 'the requested callsign'} is unavailable`,
          );
        }
        return logBook;
      };

      const buildQuery = (filter?: QSOQueryFilter) => ({
        callsign: filter?.callsign,
        timeRange: filter?.timeRange,
        frequencyRange: filter?.frequencyRange,
        mode: filter?.mode,
        band: filter?.band,
        qslStatus: filter?.qslStatus,
        limit: filter?.limit,
        offset: filter?.offset,
        orderDirection: filter?.orderDirection,
      });

      const toLogBookStatistics = async (logBook: LogBookInstance | null): Promise<LogBookStatistics | null> => {
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
          const logBook = getExistingLogBook();
          if (!logBook) return [];
          return logBook.provider.queryQSOs(buildQuery(filter));
        },
        async readQsoSnapshot(filter?: QSOQueryFilter) {
          const logBook = getRequiredLogBook();
          const result = await logBook.provider.readQsoSnapshot(buildQuery(filter));
          return snapshotPluginData(result, 'structured');
        },
        async countQSOs(filter?: QSOQueryFilter) {
          const logBook = getExistingLogBook();
          if (!logBook) return 0;
          const records = await logBook.provider.queryQSOs(buildQuery(filter));
          return records.length;
        },
        async addQSO(record: import('@tx5dr/contracts').QSORecord) {
          const logBook = getRequiredLogBook();
          return logBook.provider.addQSO(snapshotPluginData(record, 'structured'), operatorId);
        },
        async updateQSO(qsoId: string, updates: Partial<import('@tx5dr/contracts').QSORecord>) {
          const logBook = getRequiredLogBook();
          return logBook.provider.updateQSO(qsoId, snapshotPluginData(updates, 'structured'));
        },
        async applyQsoBatch(
          mutations: readonly import('@tx5dr/core').LogbookBatchMutation[],
          options: { expectedRevision: string },
        ) {
          const logBook = getRequiredLogBook();
          const result = await logBook.provider.applyQsoBatch(
            snapshotPluginData(mutations, 'structured'),
            snapshotPluginData(options, 'structured'),
            operatorId,
          );
          return snapshotPluginData(result, 'structured');
        },
        async getStatistics() {
          const logBook = getExistingLogBook();
          return toLogBookStatistics(logBook);
        },
        async notifyUpdated(explicitOperatorId?: string) {
          const logBook = getExistingLogBook();
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

    const fullAccess = {
      // === Original read-only helpers ===

      async hasWorked(callsign: string, options?: { anyBand?: boolean }) {
        if (!operatorId) {
          return false;
        }
        return deps.hasWorkedCallsign(
          operatorId,
          callsign,
          options ? snapshotPluginData(options, 'structured') : undefined,
        );
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

      async readQsoSnapshot(filter?: QSOQueryFilter) {
        const callsign = getBoundCallsign();
        if (!callsign) throw new Error('Operator logbook is unavailable');
        return createCallsignAccess(callsign).readQsoSnapshot(filter);
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
        if (!callsign) throw new Error('Operator logbook is unavailable');
        return createCallsignAccess(callsign).addQSO(record);
      },

      async updateQSO(qsoId: string, updates: Partial<import('@tx5dr/contracts').QSORecord>) {
        const callsign = getBoundCallsign();
        if (!callsign) throw new Error('Operator logbook is unavailable');
        return createCallsignAccess(callsign).updateQSO(qsoId, updates);
      },

      async applyQsoBatch(
        mutations: readonly import('@tx5dr/core').LogbookBatchMutation[],
        options: { expectedRevision: string },
      ) {
        const callsign = getBoundCallsign();
        if (!callsign) throw new Error('Operator logbook is unavailable');
        return createCallsignAccess(callsign).applyQsoBatch(mutations, options);
      },

      // === Notification ===

      async notifyUpdated() {
        const callsign = getBoundCallsign();
        if (!callsign) return;
        await createCallsignAccess(callsign).notifyUpdated(operatorId);
      },
    };

    return {
      full: fullAccess,
      read: {
        hasWorked: fullAccess.hasWorked,
        hasWorkedDXCC: fullAccess.hasWorkedDXCC,
        hasWorkedGrid: fullAccess.hasWorkedGrid,
        queryQSOs: fullAccess.queryQSOs,
        readQsoSnapshot: fullAccess.readQsoSnapshot,
        countQSOs: fullAccess.countQSOs,
        forCallsign(callsign: string) {
          const access = createCallsignAccess(callsign);
          return {
            callsign: access.callsign,
            getLogBookId: access.getLogBookId,
            queryQSOs: access.queryQSOs,
            readQsoSnapshot: access.readQsoSnapshot,
            countQSOs: access.countQSOs,
            getStatistics: access.getStatistics,
          };
        },
      },
      commands: {
        addQSO: fullAccess.addQSO,
        updateQSO: fullAccess.updateQSO,
        applyQsoBatch: fullAccess.applyQsoBatch,
        notifyUpdated: fullAccess.notifyUpdated,
        forCallsign(callsign: string) {
          const access = createCallsignAccess(callsign);
          return {
            callsign: access.callsign,
            addQSO: access.addQSO,
            updateQSO: access.updateQSO,
            applyQsoBatch: access.applyQsoBatch,
            notifyUpdated: access.notifyUpdated,
          };
        },
      },
    };
  }

  private createBandAccess(operatorId: string | undefined) {
    const deps = this.deps;
    const getOtherOperatorAudioFrequenciesHz = (slotId: string) => (
      this.getOtherOperatorAudioFrequenciesHz(operatorId, slotId)
    );
    const reserveOperatorAudioFrequency = (slotId: string, frequency: number) => {
      this.reserveOperatorAudioFrequency(operatorId, slotId, frequency);
    };
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
          getOtherOperatorAudioFrequenciesHz(slotId),
        );
        if (typeof result !== 'number' || !Number.isFinite(result)) {
          return null;
        }
        reserveOperatorAudioFrequency(slotId, result);
        return result;
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
