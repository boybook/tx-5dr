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
} from '../helpers.js';
import type { PluginContext } from '../context.js';
// Type-only imports from contracts (devDependency — erased at compile time)
import type {
  SlotInfo,
  ParsedFT8Message,
  ModeDescriptor,
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
    setTransmitCycles(): void {},
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
  return {
    frequency: 14074000,
    band: '20m',
    isConnected: true,
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
  /** Radio control overrides. */
  radio?: Partial<RadioControl>;
  /** Logbook access overrides. */
  logbook?: Partial<LogbookAccess>;
  /** Band access overrides. */
  band?: Partial<BandAccess>;
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

  const files = createMockFileStore();
  const logbookSync = { register() { /* no-op in mock */ } };

  return {
    config: opts.config ?? {},
    store: { global: globalStore, operator: operatorStore },
    log,
    timers,
    operator,
    radio,
    logbook,
    band,
    ui,
    files,
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
