/**
 * Runtime dependencies that are owned and loaded by the TX-5DR host process.
 *
 * Plugins should use these handles instead of importing host-native packages by
 * package name. This keeps development, marketplace installs, and packaged
 * Electron/server deployments on the same module instance and native addon.
 */

/** One rotator backend reported by the Host-owned Hamlib installation. */
export interface HamlibSupportedRotatorInfo {
  /** Hamlib numeric rotator model ID used by the constructor. */
  rotModel: number;
  /** Human-readable model name. */
  modelName: string;
  /** Manufacturer name. */
  mfgName: string;
  /** Backend/driver version string. */
  version: string;
  /** Hamlib support status label for this backend. */
  status: string;
  /** Axes supported by the backend. */
  rotType: 'azimuth' | 'elevation' | 'azel' | 'other';
  /** Raw Hamlib rotator-type bit mask. */
  rotTypeMask: number;
}

/** Current transport/model state of one Host-owned rotator object. */
export interface HamlibRotatorConnectionInfo {
  /** Serial device or network transport. */
  connectionType: 'serial' | 'network';
  /** Configured serial path or network endpoint. */
  portPath: string;
  /** Whether the wrapper currently owns an open Hamlib handle. */
  isOpen: boolean;
  /** Model ID requested by the plugin. */
  originalModel: number;
  /** Model ID currently selected after any backend probing. */
  currentModel: number;
  /** Optional communication-health signal from the backend. */
  connected?: boolean;
  /** Model ID detected from the connected device, when available. */
  actualModel?: number;
}

/** Rotator position in degrees. */
export interface HamlibRotatorPosition {
  /** Azimuth in degrees. */
  azimuth: number;
  /** Elevation in degrees. */
  elevation: number;
}

/** Raw Hamlib status mask plus decoded flag names. */
export interface HamlibRotatorStatus {
  /** Raw backend status bit mask. */
  mask: number;
  /** Human-readable names for set status bits. */
  flags: string[];
}

/** Direction accepted by `HamlibRotator.move()`; numeric values are raw Hamlib constants. */
export type HamlibRotatorDirection =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'CCW'
  | 'CW'
  | 'UP_LEFT'
  | 'UP_RIGHT'
  | 'DOWN_LEFT'
  | 'DOWN_RIGHT'
  | 'UP_CCW'
  | 'UP_CW'
  | 'DOWN_CCW'
  | 'DOWN_CW'
  | number;

/** Reset target accepted by Hamlib; `ALL` resets every supported subsystem. */
export type HamlibRotatorResetType = 'ALL' | number;

/** Input renderer hint reported by a Hamlib configuration field. */
export type HamlibConfigFieldType = 'string' | 'number' | 'boolean' | 'select' | 'range' | string;

/** Metadata used to render and validate one rotator backend configuration value. */
export interface HamlibConfigFieldDescriptor {
  /** Hamlib configuration token passed to `setConf`/`getConf`. */
  token: string;
  /** Stable machine-readable field name. */
  name: string;
  /** Human-readable field label. */
  label: string;
  /** Optional explanatory text. */
  tooltip?: string;
  /** Backend-provided default value. */
  defaultValue?: string | number | boolean;
  /** Suggested input renderer. */
  type: HamlibConfigFieldType;
  /** Optional numeric lower bound. */
  min?: number;
  /** Optional numeric upper bound. */
  max?: number;
  /** Optional numeric increment. */
  step?: number;
  /** Allowed values for select-like fields. */
  options?: Array<{ label: string; value: string | number | boolean }>;
}

/** Serial/network timing and framing capabilities reported by a rotator backend. */
export interface HamlibPortCaps {
  /** Backend port type label. */
  portType: string;
  /** Minimum supported serial baud rate. */
  serialRateMin?: number;
  /** Maximum supported serial baud rate. */
  serialRateMax?: number;
  /** Supported serial data-bit counts. */
  serialDataBits?: number[];
  /** Supported serial stop-bit counts. */
  stopBits?: number[];
  /** Supported parity modes. */
  parity?: string[];
  /** Supported handshaking modes. */
  handshake?: string[];
  /** Recommended pre-write delay in milliseconds. */
  writeDelay?: number;
  /** Recommended post-write delay in milliseconds. */
  postWriteDelay?: number;
  /** Backend operation timeout in milliseconds. */
  timeout?: number;
  /** Recommended retry count. */
  retry?: number;
}

/** Movement ranges and status features reported by a rotator backend. */
export interface HamlibRotatorCaps {
  /** Axes supported by the backend. */
  rotType: 'azimuth' | 'elevation' | 'azel' | 'other';
  /** Raw Hamlib rotator-type bit mask. */
  rotTypeMask: number;
  /** Minimum azimuth in degrees. */
  minAz: number;
  /** Maximum azimuth in degrees. */
  maxAz: number;
  /** Minimum elevation in degrees. */
  minEl: number;
  /** Maximum elevation in degrees. */
  maxEl: number;
  /** Status flag names supported by the backend. */
  supportedStatuses: string[];
}

/** Host-owned Hamlib Rotator constructor and static discovery helpers. */
export interface HamlibRotatorConstructor {
  /** Creates a rotator capability for a model ID and optional port/endpoint. */
  new(model: number, port?: string): HamlibRotator;
  /** Lists rotator backends compiled into the Host's Hamlib build. */
  getSupportedRotators(): HamlibSupportedRotatorInfo[];
  /** Returns the Host's Hamlib version. */
  getHamlibVersion(): string;
  /** Sets the process-wide Hamlib debug level. */
  setDebugLevel(level: number): void;
  /** Returns Hamlib copyright text when exposed by the native wrapper. */
  getCopyright?(): string;
  /** Returns Hamlib license text when exposed by the native wrapper. */
  getLicense?(): string;
}

/**
 * Live Host-owned rotator capability.
 *
 * Methods are valid only during a current Host callback and must not be sent
 * through UI/EventBus/data results. Close/destroy a plugin-opened connection in
 * an active callback when disabling it; `PluginCleanupContext` does not expose
 * native Host dependencies, and the Host revokes the capability on unload.
 */
export interface HamlibRotator {
  /** Opens the configured backend and returns the native Hamlib result code. */
  open(): Promise<number>;
  /** Closes the backend and returns the native Hamlib result code. */
  close(): Promise<number>;
  /** Releases native wrapper resources after close. */
  destroy(): void;
  /** Returns current transport and model-selection state. */
  getConnectionInfo(): HamlibRotatorConnectionInfo;
  /** Commands an absolute azimuth/elevation position in degrees. */
  setPosition(azimuth: number, elevation: number): Promise<number>;
  /** Reads the current azimuth/elevation position in degrees. */
  getPosition(): Promise<HamlibRotatorPosition>;
  /** Starts continuous motion in a direction at a backend-specific speed. */
  move(direction: HamlibRotatorDirection, speed: number): Promise<number>;
  /** Stops current movement. */
  stop(): Promise<number>;
  /** Moves to the backend-defined park position. */
  park(): Promise<number>;
  /** Resets the requested subsystem. */
  reset(resetType: HamlibRotatorResetType): Promise<number>;
  /** Returns backend-specific informational text. */
  getInfo(): Promise<string>;
  /** Reads raw and decoded rotator status flags. */
  getStatus(): Promise<HamlibRotatorStatus>;
  /** Writes one Hamlib configuration token. */
  setConf(name: string, value: string): Promise<number>;
  /** Reads one Hamlib configuration token. */
  getConf(name: string): Promise<string>;
  /** Returns descriptors for backend configuration fields. */
  getConfigSchema(): HamlibConfigFieldDescriptor[];
  /** Returns backend transport capabilities. */
  getPortCaps(): HamlibPortCaps;
  /** Returns movement-range and status capabilities. */
  getRotatorCaps(): HamlibRotatorCaps;
  /** Writes a numeric Hamlib level. */
  setLevel(level: string, value: number): Promise<number>;
  /** Reads a numeric Hamlib level. */
  getLevel(level: string): Promise<number>;
  /** Lists supported level names. */
  getSupportedLevels(): string[];
  /** Enables or disables a named Hamlib function. */
  setFunction(func: string, enable: boolean): Promise<number>;
  /** Reads a named Hamlib function state. */
  getFunction(func: string): Promise<boolean>;
  /** Lists supported function names. */
  getSupportedFunctions(): string[];
  /** Writes a numeric Hamlib parameter. */
  setParm(parm: string, value: number): Promise<number>;
  /** Reads a numeric Hamlib parameter. */
  getParm(parm: string): Promise<number>;
  /** Lists supported parameter names. */
  getSupportedParms(): string[];
}

/** Host-provided Hamlib surface exposed by the `host:hamlib` permission. */
export interface HamlibHostDependency {
  /** Guarded Rotator constructor and static helpers. */
  Rotator: HamlibRotatorConstructor;
  /** Common passband constants exported by the Host's Hamlib wrapper. */
  PASSBAND: {
    NORMAL: 0;
    NOCHANGE: -1;
  };
}

/** Optional native dependencies supplied by the Host instead of plugin imports. */
export interface HostDependencies {
  /** Host-owned node-hamlib Rotator surface. Requires the `host:hamlib` plugin permission. */
  readonly hamlib?: HamlibHostDependency;
}
