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
  OperatorControl,
  RadioControl,
  LogbookAccess,
  BandAccess,
  UIBridge,
  PluginFileStore,
  PluginNetworkControl,
  PluginUdpRemoteInfo,
  PluginUdpSocket,
} from '../helpers.js';
import type {
  HostFT8Settings,
  HostFrequencyPresetsSettings,
  HostSettingsControl,
} from '../settings.js';
import type { PluginContext } from '../context.js';
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
}

/** Full mock context with typed access to all sub-mocks. */
export interface MockPluginContext extends PluginContext {
  readonly store: {
    readonly global: MockKVStore;
    readonly operator: MockKVStore;
  };
  readonly log: MockLogger;
  readonly timers: MockTimers;
  readonly ui: MockUIBridge;
  readonly settings: HostSettingsControl;
  readonly hostDependencies: HostDependencies;
  readonly network: PluginNetworkControl;
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

export function createMockKVStore(initial?: Record<string, unknown>): MockKVStore {
  const data = new Map<string, unknown>(initial ? Object.entries(initial) : []);
  return {
    _data: data,
    get<T = unknown>(key: string, defaultValue?: T): T {
      return (data.has(key) ? data.get(key) : defaultValue) as T;
    },
    set(key: string, value: unknown): void {
      data.set(key, value);
    },
    delete(key: string): void {
      data.delete(key);
    },
    getAll(): Record<string, unknown> {
      return Object.fromEntries(data);
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

// ===== Factory: OperatorControl =====

const DEFAULT_MODE: ModeDescriptor = {
  name: 'FT8',
  slotMs: 15000,
  toleranceMs: 100,
  windowTiming: [12000],
  transmitTiming: 1180,
  encodeAdvance: 400,
};

export function createMockOperatorControl(
  overrides?: Partial<OperatorControl>,
): OperatorControl {
  return {
    id: 'operator-0',
    isTransmitting: false,
    callsign: 'W1AW',
    grid: 'FN31',
    frequency: 1500,
    mode: DEFAULT_MODE,
    transmitCycles: [0],
    automation: null,
    startTransmitting(): void {},
    stopTransmitting(): void {},
    call(): void {},
    replyToDecode(): void {},
    setTransmitCycles(): void {},
    clearDecodes(): void {},
    haltTransmission(): void {},
    setFreeText(): void {},
    sendFreeText(): void {},
    setTemporaryLocation(): void {},
    highlightCallsign(): void {},
    hasWorkedCallsign: async () => false,
    isTargetBeingWorkedByOthers: () => false,
    recordQSO(): void {},
    notifySlotsUpdated(): void {},
    notifyStateChanged(): void {},
    ...overrides,
  };
}

// ===== Factory: RadioControl =====

export function createMockRadioControl(
  overrides?: Partial<RadioControl>,
): RadioControl {
  const capabilitySnapshot: CapabilityList = { descriptors: [], capabilities: [] };
  const powerState: RadioPowerStateEvent = { state: 'awake', stage: 'idle' };
  return {
    frequency: 14074000,
    band: '20m',
    isConnected: true,
    capabilities: {
      getSnapshot: () => capabilitySnapshot,
      getState: (id) => capabilitySnapshot.capabilities.find((capability) => capability.id === id) ?? null,
      refresh: async () => capabilitySnapshot,
      write: async () => {},
    },
    power: {
      getSupport: async (profileId = 'mock-profile') => ({
        profileId,
        canPowerOn: true,
        canPowerOff: true,
        supportedStates: ['off', 'standby', 'operate'],
      }),
      getState: () => powerState,
      set: async (state) => ({ success: true, target: state, state: state === 'off' ? 'off' : 'awake' }),
    },
    setFrequency: async () => {},
    ...overrides,
  };
}

// ===== Factory: LogbookAccess =====

export function createMockLogbookAccess(
  overrides?: Partial<LogbookAccess>,
): LogbookAccess {
  const callsignAccess = {
    callsign: 'N0CALL',
    getLogBookId: async () => 'logbook-N0CALL',
    queryQSOs: async () => [],
    countQSOs: async () => 0,
    addQSO: async () => {},
    updateQSO: async () => {},
    getStatistics: async () => null,
    notifyUpdated: async () => {},
  };

  return {
    hasWorked: async () => false,
    hasWorkedDXCC: async () => false,
    hasWorkedGrid: async () => false,
    queryQSOs: async () => [],
    countQSOs: async () => 0,
    forCallsign: () => callsignAccess,
    addQSO: async () => {},
    updateQSO: async () => {},
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
  return {
    _sentData: sentData,
    send(panelId: string, data: unknown): void {
      const existing = sentData.get(panelId) ?? [];
      existing.push(data);
      sentData.set(panelId, existing);
    },
    setPanelMeta(_panelId: string, _meta: Parameters<UIBridge['setPanelMeta']>[1]): void {
      // no-op in mock
    },
    setPanelContributions(_groupId: string, _panels: Parameters<UIBridge['setPanelContributions']>[1]): void {
      // no-op in mock
    },
    clearPanelContributions(_groupId: string): void {
      // no-op in mock
    },
    registerPageHandler(_handler: Parameters<UIBridge['registerPageHandler']>[0]): void {
      // no-op in mock
    },
    pushToSession(
      _pageSessionId: string,
      _action: string,
      _data?: unknown,
    ): void {
      // no-op in mock
    },
    listActivePageSessions(_pageId: string): ReturnType<UIBridge['listActivePageSessions']> {
      return [];
    },
    pushToPage(
      _pageId: string,
      _action: string,
      _data?: unknown,
    ): void {
      // no-op in mock
    },
  };
}

// ===== Factory: PluginFileStore =====

export function createMockFileStore(): PluginFileStore {
  const storage = new Map<string, Buffer>();
  return {
    async write(p: string, data: Buffer) { storage.set(p, data); },
    async read(p: string) { return storage.get(p) ?? null; },
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
            const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
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
            sent.push({ data, port, host });
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
      async get() { return ft8; },
      async update(patch) { Object.assign(ft8, patch); return ft8; },
    },
    decodeWindows: {
      async get() { return decodeWindows; },
      async update(settings) { Object.assign(decodeWindows, settings); return decodeWindows; },
    },
    realtime: {
      async get() { return realtime; },
      async update(settings) { Object.assign(realtime, settings); return realtime; },
    },
    frequencyPresets: {
      async get() { return frequencyPresets; },
      async update(presets) { frequencyPresets.presets = presets; frequencyPresets.isCustomized = true; return frequencyPresets; },
      async reset() { frequencyPresets.isCustomized = false; return frequencyPresets; },
    },
    station: {
      async get() { return station; },
      async update(patch) { Object.assign(station, patch); return station; },
    },
    pskReporter: {
      async get() { return pskReporter; },
      async update(patch) { Object.assign(pskReporter, patch); return pskReporter; },
    },
    ntp: {
      async get() { return ntp; },
      async update(request) { ntp.servers = request.servers; return ntp; },
    },
    ...overrides,
  };
}

// ===== Factory: PluginContext =====

export interface MockPluginContextOptions {
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
  operator?: Partial<OperatorControl>;
  /** Network control override. */
  network?: PluginNetworkControl;
  /** Radio control overrides. */
  radio?: Partial<RadioControl>;
  /** Logbook access overrides. */
  logbook?: Partial<LogbookAccess>;
  /** Band access overrides. */
  band?: Partial<BandAccess>;
  /** Host settings control overrides. */
  settings?: Partial<HostSettingsControl>;
  /** Host dependency overrides. */
  hostDependencies?: HostDependencies;
  /** Manifest permissions to model permission-gated optional host dependencies. */
  permissions?: PluginPermission[];
  /** Pre-constructed stores (uses fresh empty stores when omitted). */
  store?: { global?: MockKVStore; operator?: MockKVStore };
}

export function createMockContext(options?: MockPluginContextOptions): MockPluginContext {
  const opts = options ?? {};
  const log = createMockLogger();
  const timers = createMockTimers();
  const ui = createMockUIBridge();
  const globalStore = opts.store?.global ?? createMockKVStore();
  const operatorStore = opts.store?.operator ?? createMockKVStore();

  const mode: ModeDescriptor = opts.mode
    ? { ...DEFAULT_MODE, ...opts.mode }
    : DEFAULT_MODE;

  const operator = createMockOperatorControl({
    id: opts.operatorId ?? 'operator-0',
    callsign: opts.callsign ?? 'W1AW',
    grid: opts.grid ?? 'FN31',
    frequency: opts.frequency ?? 1500,
    mode,
    ...opts.operator,
  });

  const radio = createMockRadioControl(opts.radio);
  const logbook = createMockLogbookAccess(opts.logbook);
  const band = createMockBandAccess(opts.band);

  const settings = createMockHostSettingsControl(opts.settings);
  const files = createMockFileStore();
  const network = opts.network ?? createMockNetworkControl();
  const hostDependencies = opts.hostDependencies
    ?? (opts.permissions?.includes('host:hamlib') ? createMockHostDependencies() : {});
  const logbookSync = { register() { /* no-op in mock */ } };

  return {
    config: opts.config ?? {},
    async updateConfig(patch: Record<string, unknown>) {
      // no-op in mock
    },
    store: { global: globalStore, operator: operatorStore },
    log,
    timers,
    operator,
    radio,
    logbook,
    band,
    ui,
    settings,
    hostDependencies,
    files,
    network,
    logbookSync,
  };
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
