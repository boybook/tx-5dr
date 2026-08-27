/**
 * Test utilities for `@tx5dr/plugin-api`.
 *
 * Zero external dependencies — pure TypeScript mock implementations of all
 * plugin-api interfaces. Use in plugin unit tests without pulling in the full
 * TX-5DR server environment.
 *
 * ```ts
 * import { createMockContext, createMockSlotInfo } from '@tx5dr/plugin-api/testing';
 * ```
 */
import type {
  KVStore,
  PluginLogger,
  PluginTimers,
  OperatorSnapshot,
  OperatorCommandPort,
  PluginOperatorCommand,
  RadioView,
  RadioCapabilitiesView,
  RadioCommandPort,
  RadioTunerCommandPort,
  RadioPowerView,
  RadioPowerCommandPort,
  LogbookAccess,
  BandAccess,
  UIBridge,
  PluginFileStore,
  PluginNetworkControl,
  PluginEventBus,
  PluginEventBusMessage,
  PluginUdpRemoteInfo,
  PluginUdpSocket,
} from '../helpers.js';
import type {
  HostFT8Settings,
  HostFrequencyPresetsSettings,
  HostSettingsControl,
} from '../settings.js';
import type { PluginContextFor } from '../context.js';
import type { HostDependencies } from '../host-dependencies.js';
// Type-only imports from contracts (devDependency — erased at compile time)
import type {
  SlotInfo,
  ParsedFT8Message,
  ModeDescriptor,
  PluginPermission,
  CapabilityList,
  RadioPowerStateEvent,
  DecodeWindowSettings,
  NtpServerListSettings,
  PSKReporterConfig,
  RealtimeSettings,
  StationInfo,
  QSORecord,
} from '@tx5dr/contracts';
import { FT8MessageType } from '../ft8-message-type.js';

// ===== Mock interfaces =====

/** KVStore backed by an in-memory Map. Inspect `_data` in assertions. */
export interface MockKVStore extends KVStore {
  readonly _data: Map<string, unknown>;
}

/** Logger that records every call. Inspect `_calls` in assertions. */
export interface MockLogger extends PluginLogger {
  readonly _calls: Array<{ level: string; message: string; data?: unknown }>;
}

/** Timer manager backed by a Map. Inspect `_active` for registered timers. */
export interface MockTimers extends PluginTimers {
  readonly _active: Map<string, number>;
}

/** UIBridge that captures sent data. Inspect `_sentData` in assertions. */
export interface MockUIBridge extends UIBridge {
  readonly _sentData: Map<string, unknown[]>;
  readonly _events: Array<{ type: string; id: string; data?: unknown }>;
}

/** Full mock context with typed access to all sub-mocks. */
interface MockPluginContextDecorations {
  readonly store: {
    readonly global: MockKVStore;
    readonly operator: MockKVStore;
  };
  readonly log: MockLogger;
  readonly timers: MockTimers;
  readonly ui: MockUIBridge;
  readonly settings: HostSettingsControl;
}

export type MockPluginContextFor<Permissions extends readonly PluginPermission[]> =
  PluginContextFor<Permissions> & MockPluginContextDecorations;

export type MockPluginContext = MockPluginContextFor<readonly []>;

export interface MockOperatorCommandPort extends OperatorCommandPort {
  readonly _commands: PluginOperatorCommand[];
}

export interface MockUdpSocket extends PluginUdpSocket {
  readonly _sent: Array<{ data: Uint8Array | string; port: number; host: string }>;
  readonly _binds: Array<{ host?: string; port?: number } | undefined>;
  readonly _closed: () => boolean;
  _emitMessage(data: Uint8Array | string, remote?: Partial<PluginUdpRemoteInfo>): Promise<void>;
  _emitError(error: Error): void;
}

export interface MockNetworkControl extends PluginNetworkControl {
  readonly _sockets: MockUdpSocket[];
}

export interface MockEventBus extends PluginEventBus {
  readonly _subscriptions: Map<string, Array<(message: PluginEventBusMessage) => void | Promise<void>>>;
  readonly _published: PluginEventBusMessage[];
}


function createMockHostDependencies(): HostDependencies {
  class MockRotator {
    static getSupportedRotators() { return []; }
    static getHamlibVersion() { return 'mock-hamlib'; }
    static setDebugLevel(_level: number) { /* no-op */ }
    async open() { return 0; }
    async close() { return 0; }
    destroy() { /* no-op */ }
    getConnectionInfo() { return { connectionType: 'network' as const, portPath: '', isOpen: false, originalModel: 0, currentModel: 0 }; }
    async setPosition(_azimuth: number, _elevation: number) { return 0; }
    async getPosition() { return { azimuth: 0, elevation: 0 }; }
    async move(_direction: unknown, _speed: number) { return 0; }
    async stop() { return 0; }
    async park() { return 0; }
    async reset(_resetType: unknown) { return 0; }
    async getInfo() { return ''; }
    async getStatus() { return { mask: 0, flags: [] }; }
    async setConf(_name: string, _value: string) { return 0; }
    async getConf(_name: string) { return ''; }
    getConfigSchema() { return []; }
    getPortCaps() { return { portType: 'network' }; }
    getRotatorCaps() { return { rotType: 'azimuth' as const, rotTypeMask: 0, minAz: 0, maxAz: 360, minEl: 0, maxEl: 0, supportedStatuses: [] }; }
    async setLevel(_level: string, _value: number) { return 0; }
    async getLevel(_level: string) { return 0; }
    getSupportedLevels() { return []; }
    async setFunction(_func: string, _enable: boolean) { return 0; }
    async getFunction(_func: string) { return false; }
    getSupportedFunctions() { return []; }
    async setParm(_parm: string, _value: number) { return 0; }
    async getParm(_parm: string) { return 0; }
    getSupportedParms() { return []; }
  }

  return {
    hamlib: {
      Rotator: MockRotator,
      PASSBAND: { NORMAL: 0, NOCHANGE: -1 },
    },
  };
}

// ===== Factory: KVStore =====

function cloneJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined;
  return JSON.parse(serialized) as unknown;
}

function cloneStructuredValue<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  return structuredClone(value);
}

export function createMockKVStore(initial?: Record<string, unknown>): MockKVStore {
  const clonedInitial = initial ? cloneJsonValue(initial) as Record<string, unknown> : {};
  const data = new Map<string, unknown>(Object.entries(clonedInitial));
  return {
    _data: data,
    get<T = unknown>(key: string, defaultValue?: T): T {
      return (data.has(key) ? cloneJsonValue(data.get(key)) : defaultValue) as T;
    },
    set(key: string, value: unknown): void {
      const clonedEntry = cloneJsonValue({ [key]: value }) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(clonedEntry, key)) {
        data.delete(key);
      } else {
        data.set(key, clonedEntry[key]);
      }
    },
    update<T = unknown>(key: string, reducer: (current: T | undefined) => T | undefined): T | undefined {
      const current = data.has(key) ? cloneJsonValue(data.get(key)) as T : undefined;
      const next = reducer(current);
      const clonedEntry = cloneJsonValue({ [key]: next }) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(clonedEntry, key)) data.delete(key);
      else data.set(key, clonedEntry[key]);
      return data.has(key) ? cloneJsonValue(data.get(key)) as T : undefined;
    },
    delete(key: string): void {
      data.delete(key);
    },
    getAll(): Record<string, unknown> {
      return cloneJsonValue(Object.fromEntries(data)) as Record<string, unknown>;
    },
    async flush(): Promise<void> {
      // no-op in mock
    },
  };
}

// ===== Factory: Logger =====

export function createMockLogger(): MockLogger {
  const calls: MockLogger['_calls'] = [];
  return {
    _calls: calls,
    debug(message: string, data?: Record<string, unknown>): void {
      calls.push({ level: 'debug', message, data });
    },
    info(message: string, data?: Record<string, unknown>): void {
      calls.push({ level: 'info', message, data });
    },
    warn(message: string, data?: Record<string, unknown>): void {
      calls.push({ level: 'warn', message, data });
    },
    error(message: string, error?: unknown): void {
      calls.push({ level: 'error', message, data: error });
    },
  };
}

// ===== Factory: Timers =====

export function createMockTimers(): MockTimers {
  const active = new Map<string, number>();
  return {
    _active: active,
    set(id: string, intervalMs: number): void {
      active.set(id, intervalMs);
    },
    clear(id: string): void {
      active.delete(id);
    },
    clearAll(): void {
      active.clear();
    },
  };
}

// ===== Factory: Operator snapshot and commands =====

const DEFAULT_MODE: ModeDescriptor = {
  name: 'FT8',
  slotMs: 15000,
  toleranceMs: 100,
  windowTiming: [12000],
  transmitTiming: 1180,
  encodeAdvance: 400,
};

export function createMockOperatorSnapshot(
  overrides?: Partial<OperatorSnapshot>,
): OperatorSnapshot {
  const mode = cloneStructuredValue(overrides?.mode ?? DEFAULT_MODE);
  const transmitCycles = cloneStructuredValue(overrides?.transmitCycles ?? [0]);
  const automation = cloneStructuredValue(overrides?.automation ?? null);
  const getOtherOperators = overrides?.getOtherOperators ?? (() => []);
  return {
    id: overrides?.id ?? 'operator-0',
    isTransmitting: overrides?.isTransmitting ?? false,
    callsign: overrides?.callsign ?? 'W1AW',
    grid: overrides?.grid ?? 'FN31',
    frequency: overrides?.frequency ?? 1500,
    maxConcurrentStreams: overrides?.maxConcurrentStreams ?? 3,
    get mode() { return cloneStructuredValue(mode); },
    get transmitCycles() { return cloneStructuredValue(transmitCycles); },
    get automation() { return cloneStructuredValue(automation); },
    getOtherOperators: () => cloneStructuredValue(getOtherOperators()),
    hasWorkedCallsign: overrides?.hasWorkedCallsign ?? (async () => false),
    isTargetBeingWorkedByOthers: overrides?.isTargetBeingWorkedByOthers ?? (() => false),
  };
}

export function createMockOperatorCommandPort(
  submit?: (command: PluginOperatorCommand) => void | Promise<void>,
): MockOperatorCommandPort {
  const commands: PluginOperatorCommand[] = [];
  return {
    _commands: commands,
    async submit(command) {
      const snapshot = cloneStructuredValue(command);
      commands.push(snapshot);
      await submit?.(cloneStructuredValue(snapshot));
      return { epoch: commands.length, outcome: 'completed' };
    },
  };
}

// ===== Factory: RadioControl =====

export function createMockRadioView(
  overrides?: Partial<RadioView>,
): RadioView {
  const mode: RadioView['mode'] = cloneStructuredValue(overrides?.mode ?? {
    engineMode: 'digital',
    mode: 'FT8',
    radioMode: 'USB',
    descriptor: DEFAULT_MODE,
  });
  return {
    frequency: overrides?.frequency ?? 14074000,
    band: overrides?.band ?? '20m',
    get mode() { return cloneStructuredValue(mode); },
    isConnected: overrides?.isConnected ?? true,
  };
}

export function createMockRadioCapabilitiesView(): RadioCapabilitiesView {
  const snapshot: CapabilityList = { descriptors: [], capabilities: [] };
  return {
    getSnapshot: () => cloneStructuredValue(snapshot),
    getState: (id: string) => cloneStructuredValue(
      snapshot.capabilities.find((capability) => capability.id === id) ?? null,
    ),
    refresh: async () => cloneStructuredValue(snapshot),
  };
}

export function createMockRadioCommandPort(): RadioCommandPort {
  return { submit: async () => {} };
}

export function createMockRadioTunerCommandPort(): RadioTunerCommandPort {
  return { submit: async () => {} };
}

export function createMockRadioPowerView(): RadioPowerView {
  const state: RadioPowerStateEvent = { state: 'awake', stage: 'idle' };
  return {
    getSupport: async (profileId = 'mock-profile') => ({
      profileId,
      canPowerOn: true,
      canPowerOff: true,
      supportedStates: ['off', 'standby', 'operate'],
    }),
    getState: () => cloneStructuredValue(state),
  };
}

export function createMockRadioPowerCommandPort(): RadioPowerCommandPort {
  return {
    submit: async (command) => ({
      success: true,
      target: command.state,
      state: command.state === 'off' ? 'off' : 'awake',
    }),
  };
}

// ===== Factory: LogbookAccess =====

export function createMockLogbookAccess(
  overrides?: Partial<LogbookAccess>,
): LogbookAccess {
  const commit = async (record: QSORecord): Promise<QSORecord> => cloneStructuredValue(record);
  const update = async (
    qsoId: string,
    updates: Partial<QSORecord>,
  ): Promise<QSORecord> => commit({
    callsign: updates.callsign ?? 'N0CALL',
    frequency: updates.frequency ?? 14_074_000,
    mode: updates.mode ?? 'FT8',
    startTime: updates.startTime ?? 0,
    messageHistory: updates.messageHistory ?? [],
    ...updates,
    id: qsoId,
  });
  const readQsoSnapshot = async () => ({ revision: 'mock-revision', records: [] });
  const applyQsoBatch: LogbookAccess['applyQsoBatch'] = async (mutations) => ({
    revision: 'mock-revision',
    outcomes: await Promise.all(mutations.map(async (mutation, inputIndex) => {
      if (mutation.type === 'add') {
        return { inputIndex, status: 'added' as const, record: await commit(mutation.record) };
      }
      return {
        inputIndex,
        status: 'updated' as const,
        record: await update(mutation.qsoId, mutation.updates),
      };
    })),
  });
  const callsignAccess = {
    callsign: 'N0CALL',
    getLogBookId: async () => 'logbook-N0CALL',
    queryQSOs: async () => [],
    readQsoSnapshot,
    countQSOs: async () => 0,
    addQSO: commit,
    updateQSO: update,
    applyQsoBatch,
    getStatistics: async () => null,
    notifyUpdated: async () => {},
  };

  return {
    hasWorked: async () => false,
    hasWorkedDXCC: async () => false,
    hasWorkedGrid: async () => false,
    queryQSOs: async () => [],
    readQsoSnapshot,
    countQSOs: async () => 0,
    forCallsign: () => callsignAccess,
    addQSO: commit,
    updateQSO: update,
    applyQsoBatch,
    notifyUpdated: async () => {},
    ...overrides,
  };
}

// ===== Factory: BandAccess =====

export function createMockBandAccess(
  overrides?: Partial<BandAccess>,
): BandAccess {
  return {
    getActiveCallers: () => [],
    getLatestSlotPack: () => null,
    findIdleTransmitFrequency: () => null,
    evaluateAutoTargetEligibility: () => ({ eligible: true, reason: 'plain_cq' as const }),
    ...overrides,
  };
}

// ===== Factory: UIBridge =====

export function createMockUIBridge(): MockUIBridge {
  const sentData = new Map<string, unknown[]>();
  const events: MockUIBridge['_events'] = [];
  return {
    _sentData: sentData,
    _events: events,
    send(panelId: string, data: unknown): void {
      const existing = sentData.get(panelId) ?? [];
      existing.push(cloneJsonValue(data));
      sentData.set(panelId, existing);
    },
    setPanelMeta(panelId: string, meta: Parameters<UIBridge['setPanelMeta']>[1]): void {
      events.push({ type: 'panel-meta', id: panelId, data: cloneJsonValue(meta) });
    },
    setPanelContributions(groupId: string, panels: Parameters<UIBridge['setPanelContributions']>[1]): void {
      events.push({ type: 'panel-contributions', id: groupId, data: cloneJsonValue(panels) });
    },
    clearPanelContributions(groupId: string): void {
      events.push({ type: 'panel-contributions', id: groupId, data: [] });
    },
    refreshOperatorProjection(): void {
      events.push({ type: 'operator-projection-refresh', id: 'operator' });
    },
    registerPageHandler(_handler: Parameters<UIBridge['registerPageHandler']>[0]): void {
      // no-op in mock
    },
    pushToSession(
      pageSessionId: string,
      action: string,
      data?: unknown,
    ): void {
      events.push({ type: 'session-push', id: `${pageSessionId}:${action}`, data: cloneJsonValue(data) });
    },
    listActivePageSessions(_pageId: string): ReturnType<UIBridge['listActivePageSessions']> {
      return [];
    },
    pushToPage(
      pageId: string,
      action: string,
      data?: unknown,
    ): void {
      events.push({ type: 'page-push', id: `${pageId}:${action}`, data: cloneJsonValue(data) });
    },
  };
}

// ===== Factory: PluginFileStore =====

export function createMockFileStore(): PluginFileStore {
  const storage = new Map<string, Buffer>();
  return {
    async write(p: string, data: Buffer) { storage.set(p, Buffer.from(data)); },
    async read(p: string) {
      const data = storage.get(p);
      return data ? Buffer.from(data) : null;
    },
    async delete(p: string) { return storage.delete(p); },
    async list(prefix?: string) {
      const keys = Array.from(storage.keys());
      return prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
    },
  };
}

// ===== Factory: NetworkControl =====

export function createMockNetworkControl(): MockNetworkControl {
  const sockets: MockUdpSocket[] = [];
  return {
    _sockets: sockets,
    udp: {
      createSocket() {
        let messageHandler: Parameters<ReturnType<PluginNetworkControl['udp']['createSocket']>['onMessage']>[0] | undefined;
        let errorHandler: Parameters<ReturnType<PluginNetworkControl['udp']['createSocket']>['onError']>[0] | undefined;
        let closed = false;
        const sent: MockUdpSocket['_sent'] = [];
        const binds: MockUdpSocket['_binds'] = [];
        const socket: MockUdpSocket = {
          _sent: sent,
          _binds: binds,
          _closed: () => closed,
          async _emitMessage(data, remote) {
            if (!messageHandler) return;
            const payload = typeof data === 'string'
              ? Buffer.from(data, 'utf8')
              : new Uint8Array(data);
            await messageHandler(payload, {
              address: remote?.address ?? '127.0.0.1',
              port: remote?.port ?? 2237,
              family: remote?.family ?? 'IPv4',
              size: remote?.size ?? payload.byteLength,
            });
          },
          _emitError(error) {
            errorHandler?.(error);
          },
          async bind(options) {
            binds.push(options);
          },
          async send(data, port, host) {
            sent.push({
              data: typeof data === 'string' ? data : new Uint8Array(data),
              port,
              host,
            });
          },
          onMessage(handler) {
            messageHandler = handler;
          },
          onError(handler) {
            errorHandler = handler;
          },
          async close() {
            closed = true;
          },
        };
        sockets.push(socket);
        return socket;
      },
      async closeAll() {
        await Promise.all(sockets.map((socket) => socket.close()));
      },
    },
  };
}

// ===== Factory: EventBus =====

/**
 * Options for {@link createMockEventBus}.
 */
export interface MockEventBusOptions {
  /** Publisher metadata injected into every message. Defaults to `mock-plugin` / `operator-0`. */
  owner?: {
    pluginName?: string;
    instanceScope?: 'operator' | 'global';
    operatorId?: string;
  };
}

/**
 * Creates a mock {@link PluginEventBus} for unit testing plugin code.
 *
 * All published messages are recorded in `_published` for assertion.
 * The internal `_subscriptions` map lets tests inspect active subscriptions.
 *
 * @param options - Optional configuration for publisher metadata.
 * @returns A mock event bus with inspection helpers.
 *
 * @example
 * ```ts
 * const bus = createMockEventBus({ owner: { pluginName: 'my-plugin' } });
 * bus.subscribe('topic', handler);
 * bus.publish('topic', { value: 42 });
 * expect(bus._published).toHaveLength(1);
 * expect(bus._published[0].publisher.pluginName).toBe('my-plugin');
 * ```
 */
export function createMockEventBus(options?: MockEventBusOptions): MockEventBus {
  const subscriptions = new Map<string, Array<(message: PluginEventBusMessage) => void | Promise<void>>>();
  const published: PluginEventBusMessage[] = [];
  const ownerName = options?.owner?.pluginName ?? 'mock-plugin';
  const ownerScope = options?.owner?.instanceScope ?? 'operator';
  const ownerId = ownerScope === 'operator'
    ? (options?.owner?.operatorId ?? 'operator-0')
    : undefined;

  return {
    _subscriptions: subscriptions,
    _published: published,
    publish(topic: string, payload?: unknown) {
      const message = cloneStructuredValue<PluginEventBusMessage>({
        topic,
        payload: cloneStructuredValue(payload),
        timestamp: Date.now(),
        publisher: {
          pluginName: ownerName,
          instanceScope: ownerScope,
          operatorId: ownerId,
        },
      });
      published.push(cloneStructuredValue(message));
      const handlers = [...(subscriptions.get(topic) ?? [])];
      for (const handler of handlers) {
        try {
          void Promise.resolve(handler(cloneStructuredValue(message))).catch(() => undefined);
        } catch {
          // Match the production bus: subscriber failures do not reach publishers.
        }
      }
    },
    subscribe(topic, handler) {
      const handlers = subscriptions.get(topic) ?? [];
      if (!handlers.includes(handler)) {
        handlers.push(handler);
        subscriptions.set(topic, handlers);
      }
      return () => {
        const current = subscriptions.get(topic);
        if (!current) return;
        const next = current.filter((candidate) => candidate !== handler);
        if (next.length === 0) {
          subscriptions.delete(topic);
          return;
        }
        subscriptions.set(topic, next);
      };
    },
  };
}

// ===== Factory: HostSettingsControl =====

export function createMockHostSettingsControl(overrides?: Partial<HostSettingsControl>): HostSettingsControl {
  const ft8: HostFT8Settings = {
    myCallsign: 'W1AW',
    myGrid: 'FN31',
    frequency: 14_074_000,
    transmitPower: 25,
    autoReply: false,
    maxQSOTimeout: 6,
    maxSameTransmissionCount: 20,
    decodeWhileTransmitting: false,
    spectrumWhileTransmitting: true,
  };
  const decodeWindows: DecodeWindowSettings = { ft8: { preset: 'balanced' }, ft4: { preset: 'balanced' } };
  const realtime: RealtimeSettings = { transportPolicy: 'auto', rtcDataAudioPublicHost: null, rtcDataAudioPublicUdpPort: null };
  const frequencyPresets: HostFrequencyPresetsSettings = {
    presets: [{ band: '20m', mode: 'FT8', radioMode: 'USB', frequency: 14_074_000, description: '20m FT8' }],
    isCustomized: false,
  };
  const station: StationInfo = { callsign: 'W1AW', qth: { grid: 'FN31' } };
  const pskReporter: PSKReporterConfig = {
    enabled: false,
    receiverCallsign: '',
    receiverLocator: '',
    decodingSoftware: 'TX-5DR',
    antennaInformation: '',
    reportIntervalSeconds: 30,
    useTestServer: false,
    stats: { todayReportCount: 0, totalReportCount: 0, consecutiveFailures: 0 },
  };
  const ntp: NtpServerListSettings = { servers: ['pool.ntp.org'], defaultServers: ['pool.ntp.org'] };

  return {
    ft8: {
      async get() { return cloneStructuredValue(ft8); },
      async update(patch) {
        Object.assign(ft8, cloneStructuredValue(patch));
        return cloneStructuredValue(ft8);
      },
    },
    decodeWindows: {
      async get() { return cloneStructuredValue(decodeWindows); },
      async update(settings) {
        Object.assign(decodeWindows, cloneStructuredValue(settings));
        return cloneStructuredValue(decodeWindows);
      },
    },
    realtime: {
      async get() { return cloneStructuredValue(realtime); },
      async update(settings) {
        Object.assign(realtime, cloneStructuredValue(settings));
        return cloneStructuredValue(realtime);
      },
    },
    frequencyPresets: {
      async get() { return cloneStructuredValue(frequencyPresets); },
      async update(presets) {
        frequencyPresets.presets = cloneStructuredValue(presets);
        frequencyPresets.isCustomized = true;
        return cloneStructuredValue(frequencyPresets);
      },
      async reset() {
        frequencyPresets.isCustomized = false;
        return cloneStructuredValue(frequencyPresets);
      },
    },
    station: {
      async get() { return cloneStructuredValue(station); },
      async update(patch) {
        Object.assign(station, cloneStructuredValue(patch));
        return cloneStructuredValue(station);
      },
    },
    pskReporter: {
      async get() { return cloneStructuredValue(pskReporter); },
      async update(patch) {
        Object.assign(pskReporter, cloneStructuredValue(patch));
        return cloneStructuredValue(pskReporter);
      },
    },
    ntp: {
      async get() { return cloneStructuredValue(ntp); },
      async update(request) {
        ntp.servers = cloneStructuredValue(request.servers);
        return cloneStructuredValue(ntp);
      },
    },
    ...overrides,
  };
}

// ===== Factory: PluginContext =====

export interface MockPluginContextOptions<
  Permissions extends readonly PluginPermission[] = readonly [],
> {
  /** Initial config values (default: empty). */
  config?: Record<string, unknown>;
  /** Operator identifier (default: `'operator-0'`). */
  operatorId?: string;
  /** Station callsign (default: `'W1AW'`). */
  callsign?: string;
  /** Station grid (default: `'FN31'`). */
  grid?: string;
  /** Audio offset frequency in Hz (default: `1500`). */
  frequency?: number;
  /** Partial mode descriptor overrides. */
  mode?: Partial<ModeDescriptor>;
  /** Additional operator control overrides. */
  operator?: Partial<OperatorSnapshot>;
  /** Optional command-port override. Otherwise created only with `operator:transmit-control`. */
  operatorCommands?: OperatorCommandPort;
  /** Network control override. */
  network?: PluginNetworkControl;
  /** Radio control overrides. */
  radio?: Partial<RadioView>;
  radioCapabilities?: RadioCapabilitiesView;
  radioCommands?: RadioCommandPort;
  radioTunerCommands?: RadioTunerCommandPort;
  radioPower?: RadioPowerView;
  radioPowerCommands?: RadioPowerCommandPort;
  /** Logbook access overrides. */
  logbook?: Partial<LogbookAccess>;
  /** Band access overrides. */
  band?: Partial<BandAccess>;
  /** Host settings control overrides. */
  settings?: Partial<HostSettingsControl>;
  /** Event bus override. */
  eventBus?: PluginEventBus;
  /** Host dependency overrides. */
  hostDependencies?: HostDependencies;
  /** Manifest permissions to model permission-gated optional host dependencies. */
  permissions?: Permissions;
  /** Pre-constructed stores (uses fresh empty stores when omitted). */
  store?: { global?: MockKVStore; operator?: MockKVStore };
}

export function createMockContext<
  const Permissions extends readonly PluginPermission[] = readonly [],
>(options?: MockPluginContextOptions<Permissions>): MockPluginContextFor<Permissions> {
  const opts = options ?? {};
  const log = createMockLogger();
  const timers = createMockTimers();
  const ui = createMockUIBridge();
  const globalStore = opts.store?.global ?? createMockKVStore();
  const operatorStore = opts.store?.operator ?? createMockKVStore();

  const mode: ModeDescriptor = opts.mode
    ? { ...DEFAULT_MODE, ...opts.mode }
    : DEFAULT_MODE;

  const operator = createMockOperatorSnapshot({
    id: opts.operatorId ?? 'operator-0',
    callsign: opts.callsign ?? 'W1AW',
    grid: opts.grid ?? 'FN31',
    frequency: opts.frequency ?? 1500,
    mode,
    ...opts.operator,
  });

  const radio = createMockRadioView(opts.radio);
  const logbook = createMockLogbookAccess(opts.logbook);
  const readOnlyLogbook = {
    hasWorked: logbook.hasWorked,
    hasWorkedDXCC: logbook.hasWorkedDXCC,
    hasWorkedGrid: logbook.hasWorkedGrid,
    queryQSOs: logbook.queryQSOs,
    readQsoSnapshot: logbook.readQsoSnapshot,
    countQSOs: logbook.countQSOs,
    forCallsign(callsign: string) {
      const access = logbook.forCallsign(callsign);
      return {
        callsign: access.callsign,
        getLogBookId: access.getLogBookId,
        queryQSOs: access.queryQSOs,
        readQsoSnapshot: access.readQsoSnapshot,
        countQSOs: access.countQSOs,
        getStatistics: access.getStatistics,
      };
    },
  };
  const band = createMockBandAccess(opts.band);

  const settings = createMockHostSettingsControl(opts.settings);
  const files = createMockFileStore();
  const network = opts.network ?? createMockNetworkControl();
  const eventBus = opts.eventBus ?? createMockEventBus();
  const hostDependencies = opts.hostDependencies
    ?? (opts.permissions?.includes('host:hamlib') ? createMockHostDependencies() : {});
  const logbookSync = { register() { /* no-op in mock */ } };
  const configState = cloneJsonValue(opts.config ?? {}) as Record<string, unknown>;

  return {
    get config() {
      return cloneStructuredValue(configState);
    },
    async updateConfig(patch: Record<string, unknown>) {
      Object.assign(configState, cloneJsonValue(patch));
    },
    store: { global: globalStore, operator: operatorStore },
    digitalMessagePreflight: {
      async check(request) {
        const text = request.text.trim().toUpperCase().replace(/\s+/g, ' ');
        return text
          ? { encodable: true, requestedText: text, transmittedText: text }
          : { encodable: false, requestedText: text, reason: 'empty' as const };
      },
    },
    log,
    timers,
    operator,
    radio,
    band,
    ui,
    files,
    ...((opts.permissions?.includes('logbook:read') || opts.permissions?.includes('logbook:write')) ? {
      logbook: opts.permissions?.includes('logbook:write') ? logbook : readOnlyLogbook,
    } : {}),
    ...(opts.permissions?.includes('logbook:sync') ? { logbookSync } : {}),
    ...((opts.permissions ?? []).some(permission => permission.startsWith('settings:')) ? {
      settings: {
        ...(opts.permissions?.includes('settings:ft8') ? { ft8: settings.ft8 } : {}),
        ...(opts.permissions?.includes('settings:decode-windows') ? { decodeWindows: settings.decodeWindows } : {}),
        ...(opts.permissions?.includes('settings:realtime') ? { realtime: settings.realtime } : {}),
        ...(opts.permissions?.includes('settings:frequency-presets') ? { frequencyPresets: settings.frequencyPresets } : {}),
        ...(opts.permissions?.includes('settings:station') ? { station: settings.station } : {}),
        ...(opts.permissions?.includes('settings:psk-reporter') ? { pskReporter: settings.pskReporter } : {}),
        ...(opts.permissions?.includes('settings:ntp') ? { ntp: settings.ntp } : {}),
      },
    } : {}),
    ...(opts.permissions?.includes('operator:transmit-control') ? {
      operatorCommands: opts.operatorCommands ?? createMockOperatorCommandPort(),
    } : {}),
    ...(opts.permissions?.includes('radio:read') ? {
      radioCapabilities: opts.radioCapabilities ?? createMockRadioCapabilitiesView(),
      radioPower: opts.radioPower ?? createMockRadioPowerView(),
    } : {}),
    ...(opts.permissions?.includes('radio:control') ? {
      radioCommands: opts.radioCommands ?? createMockRadioCommandPort(),
    } : {}),
    ...(opts.permissions?.includes('radio:tuner-control') ? {
      radioTunerCommands: opts.radioTunerCommands ?? createMockRadioTunerCommandPort(),
    } : {}),
    ...(opts.permissions?.includes('radio:power') ? {
      radioPowerCommands: opts.radioPowerCommands ?? createMockRadioPowerCommandPort(),
    } : {}),
    ...(opts.permissions?.includes('host:hamlib') ? { hostDependencies } : {}),
    ...(opts.permissions?.includes('network') ? { network, fetch: globalThis.fetch } : {}),
    ...(opts.permissions?.includes('plugin:event-bus') ? { eventBus } : {}),
  } as MockPluginContextFor<Permissions>;
}

// ===== Data factories =====

export function createMockSlotInfo(overrides?: Partial<SlotInfo>): SlotInfo {
  return {
    id: 'slot-0',
    startMs: 0,
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: 0,
    utcSeconds: 0,
    mode: 'FT8',
    ...overrides,
  };
}

export function createMockParsedMessage(overrides?: Partial<ParsedFT8Message>): ParsedFT8Message {
  return {
    snr: -10,
    dt: 0.1,
    df: 1500,
    rawMessage: 'CQ TEST W1AW FN31',
    message: {
      type: FT8MessageType.CQ,
      senderCallsign: 'W1AW',
      grid: 'FN31',
    },
    slotId: 'slot-0',
    timestamp: 0,
    ...overrides,
  };
}
