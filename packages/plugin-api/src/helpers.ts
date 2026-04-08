import type { ParsedFT8Message, SlotInfo, SlotPack, QSORecord, FrameMessage, OperatorSlots, ModeDescriptor } from '@tx5dr/contracts';
import type { StrategyRuntimeSnapshot } from './runtime.js';
import type { PluginSettingDescriptor, PluginQuickAction, PluginPanelDescriptor, PluginPermission, PluginType, PluginSettingScope } from '@tx5dr/contracts';

// ===== KV Storage =====

export interface KVStore {
  get<T = unknown>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  getAll(): Record<string, unknown>;
}

// ===== Logger =====

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

// ===== Timer Manager =====

export interface PluginTimers {
  /** Set a named interval timer. If the timer already exists, it will be replaced. */
  set(id: string, intervalMs: number): void;
  /** Clear a named timer. */
  clear(id: string): void;
  /** Clear all timers for this plugin. */
  clearAll(): void;
}

// ===== Operator Control =====

export interface OperatorControl {
  /** Unique operator ID. */
  readonly id: string;
  /** Whether the operator is currently transmitting. */
  readonly isTransmitting: boolean;
  /** The operator's callsign. */
  readonly callsign: string;
  /** The operator's grid locator. */
  readonly grid: string;
  /** Audio offset frequency in Hz (within the passband). */
  readonly frequency: number;
  /** Current mode (FT8, FT4, …). */
  readonly mode: ModeDescriptor;
  /** Current transmit cycles configuration (0=even, 1=odd). */
  readonly transmitCycles: number[];
  /** Active automation runtime snapshot for the current operator, if available. */
  readonly automation: StrategyRuntimeSnapshot | null;
  /** Start transmitting (enable the operator). */
  startTransmitting(): void;
  /** Stop transmitting (disable the operator). */
  stopTransmitting(): void;
  /** Initiate a call to the given callsign. */
  call(callsign: string, lastMessage?: { message: FrameMessage; slotInfo: SlotInfo }): void;
  /** Set transmit cycles (0=even, 1=odd). */
  setTransmitCycles(cycles: number | number[]): void;
  /** Check if a callsign has been worked before (async, queries logbook). */
  hasWorkedCallsign(callsign: string): Promise<boolean>;
  /** Check if another operator with the same callsign is already working this target. */
  isTargetBeingWorkedByOthers(targetCallsign: string): boolean;
  /** Record a completed QSO to the logbook. */
  recordQSO(record: QSORecord): void;
  /** Notify the frontend of updated TX slot contents (TX1-TX6 text). */
  notifySlotsUpdated(slots: OperatorSlots): void;
  /** Notify the frontend of a state machine state change. */
  notifyStateChanged(state: string): void;
}

// ===== Radio Control =====

export interface RadioControl {
  /** Current radio frequency in Hz. */
  readonly frequency: number;
  /** Current band (e.g., "20m"). */
  readonly band: string;
  /** Whether the radio is connected. */
  readonly isConnected: boolean;
  /** Set the radio frequency. */
  setFrequency(freq: number): Promise<void>;
}

// ===== Logbook Access =====

export interface LogbookAccess {
  /** Check if a callsign has been worked before. */
  hasWorked(callsign: string): Promise<boolean>;
  /** Check if a DXCC entity has been worked. */
  hasWorkedDXCC(dxccEntity: string): Promise<boolean>;
  /** Check if a grid has been worked. */
  hasWorkedGrid(grid: string): Promise<boolean>;
}

// ===== Band Access =====

export interface BandAccess {
  /** Get the list of active CQ callers in the current slot. */
  getActiveCallers(): ParsedFT8Message[];
  /** Get the latest SlotPack. */
  getLatestSlotPack(): SlotPack | null;
}

// ===== UI Bridge =====

export interface UIBridge {
  /** Push data to a frontend panel. */
  send(panelId: string, data: unknown): void;
}
