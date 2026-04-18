/**
 * Public types for @tx5dr/rigctld-server.
 *
 * Embedders provide a RadioController implementation; this package speaks the
 * rigctld protocol to any NET rigctl client and translates each command into
 * controller calls. The controller is expected to serialize its own I/O.
 */

export type RigctlMode =
  | 'USB'
  | 'LSB'
  | 'CW'
  | 'CWR'
  | 'AM'
  | 'FM'
  | 'WFM'
  | 'RTTY'
  | 'RTTYR'
  | 'PKTUSB'
  | 'PKTLSB'
  | 'PKTFM';

export type RigctlVfo = 'VFOA' | 'VFOB' | 'MEM';

export type RigctlLevel = 'RFPOWER' | 'AF' | 'SQL' | 'STRENGTH';

export interface RadioModeResult {
  mode: RigctlMode;
  bandwidthHz: number;
}

export interface RadioSplitState {
  enabled: boolean;
  txVfo: RigctlVfo;
}

/**
 * Abstract radio interface that the embedder implements.
 *
 * - All methods are async; timeouts / retries are the embedder's responsibility.
 * - Optional methods return `RIG_ENIMPL (-11)` to clients when omitted.
 * - Throwing any error is translated into `RIG_EIO (-5)` on the wire; throw a
 *   `RigctldProtocolError` with a specific code to return a different code.
 */
export interface RadioController {
  getFrequency(): Promise<number>;
  setFrequency(hz: number): Promise<void>;

  getMode(): Promise<RadioModeResult>;
  setMode(mode: RigctlMode, bandwidthHz: number): Promise<void>;

  getPTT(): Promise<boolean>;
  setPTT(on: boolean): Promise<void>;

  getVFO?(): Promise<RigctlVfo>;
  setVFO?(vfo: RigctlVfo): Promise<void>;

  getSplit?(): Promise<RadioSplitState>;
  setSplit?(state: RadioSplitState): Promise<void>;

  /** Split TX frequency (rigctld `i` / `I`). */
  getSplitFreq?(): Promise<number>;
  setSplitFreq?(hz: number): Promise<void>;

  /** Split TX mode (rigctld `x` / `X`). */
  getSplitMode?(): Promise<RadioModeResult>;
  setSplitMode?(mode: RigctlMode, bandwidthHz: number): Promise<void>;

  getLevel?(name: RigctlLevel): Promise<number>;
  setLevel?(name: RigctlLevel, value: number): Promise<void>;

  getPowerStat?(): Promise<boolean>;
  setPowerStat?(on: boolean): Promise<void>;

  /**
   * Panel lock (rigctld `\get_lock_mode` / `\set_lock_mode`).
   * Omit to have the server report "unlocked" for reads and `RIG_ENIMPL` for writes.
   */
  getLockMode?(): Promise<boolean>;
  setLockMode?(locked: boolean): Promise<void>;

  /**
   * RIT offset in Hz (rigctld `\get_rit` / `\set_rit`). 0 = disabled.
   * Omit to have the server report "0" for reads and `RIG_ENIMPL` for writes.
   */
  getRit?(): Promise<number>;
  setRit?(offsetHz: number): Promise<void>;

  /**
   * XIT offset in Hz (rigctld `\get_xit` / `\set_xit`). 0 = disabled.
   * Omit to have the server report "0" for reads and `RIG_ENIMPL` for writes.
   */
  getXit?(): Promise<number>;
  setXit?(offsetHz: number): Promise<void>;

  /**
   * Current tuning step in Hz (rigctld `\get_ts` / `\set_ts`).
   * Omit to have the server report "0" for reads and `RIG_ENIMPL` for writes.
   */
  getTuningStep?(): Promise<number>;
  setTuningStep?(stepHz: number): Promise<void>;

  /**
   * Antenna selection (rigctld `\get_ant` / `\set_ant`).
   * `ant` is a 1-based index matching the rig's physical ANT ports.
   * Omit to have the server report antenna 1 as the only option (read) and
   * `RIG_ENIMPL` on writes.
   */
  getAntenna?(): Promise<{ current: number; rx?: number; tx?: number }>;
  setAntenna?(ant: number): Promise<void>;

  /**
   * Data carrier detect — true while squelch is open / a signal is being
   * received (rigctld `\get_dcd`). Omit to report "0" (squelch closed).
   */
  getDCD?(): Promise<boolean>;

  /** Free-form info string returned by `\get_info`. */
  getInfo?(): Promise<string>;
}

export interface RigctldLogger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface RigctldServerOptions {
  controller: RadioController;
  /** Bind address, default `'127.0.0.1'`. Use `'0.0.0.0'` to expose on LAN. */
  host?: string;
  /** TCP port, default `4532`. */
  port?: number;
  logger?: RigctldLogger;
  /** Static model identity advertised in `dump_state`. Defaults to IC-7300. */
  identity?: Partial<RigctldIdentity>;
  /**
   * When true, every command that would mutate radio state is rejected with
   * `RPRT -11`. Useful for "log-only" deployments where external software
   * records QSOs while the operator tunes manually — it hard-disables
   * frequency / mode / PTT / level / powerstat writes at the server boundary
   * regardless of what the embedder's controller methods would do.
   */
  readOnly?: boolean;
}

export interface RigctldIdentity {
  /** Hamlib rig model number. IC-7300 = 3073. */
  rigModel: number;
  /** Model name string, e.g. `"IC-7300"`. */
  modelName: string;
  /** Manufacturer, e.g. `"Icom"`. */
  mfgName: string;
  /** Version label shown by `\get_info`. */
  version: string;
}

export interface RigctldClientInfo {
  id: number;
  peer: string;
  connectedAt: number;
  lastCommand?: string;
  lastCommandAt?: number;
}

export interface RigctldServerEvents {
  clientConnected: [RigctldClientInfo];
  clientDisconnected: [RigctldClientInfo];
  commandHandled: [{ clientId: number; command: string; durationMs: number; ok: boolean }];
  listening: [{ host: string; port: number }];
  error: [Error];
}
