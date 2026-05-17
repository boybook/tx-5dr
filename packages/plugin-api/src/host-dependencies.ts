/**
 * Runtime dependencies that are owned and loaded by the TX-5DR host process.
 *
 * Plugins should use these handles instead of importing host-native packages by
 * package name. This keeps development, marketplace installs, and packaged
 * Electron/server deployments on the same module instance and native addon.
 */

export interface HamlibSupportedRotatorInfo {
  rotModel: number;
  modelName: string;
  mfgName: string;
  version: string;
  status: string;
  rotType: 'azimuth' | 'elevation' | 'azel' | 'other';
  rotTypeMask: number;
}

export interface HamlibRotatorConnectionInfo {
  connectionType: 'serial' | 'network';
  portPath: string;
  isOpen: boolean;
  originalModel: number;
  currentModel: number;
  connected?: boolean;
  actualModel?: number;
}

export interface HamlibRotatorPosition {
  azimuth: number;
  elevation: number;
}

export interface HamlibRotatorStatus {
  mask: number;
  flags: string[];
}

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

export type HamlibRotatorResetType = 'ALL' | number;

export type HamlibConfigFieldType = 'string' | 'number' | 'boolean' | 'select' | 'range' | string;

export interface HamlibConfigFieldDescriptor {
  token: string;
  name: string;
  label: string;
  tooltip?: string;
  defaultValue?: string | number | boolean;
  type: HamlibConfigFieldType;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string | number | boolean }>;
}

export interface HamlibPortCaps {
  portType: string;
  serialRateMin?: number;
  serialRateMax?: number;
  serialDataBits?: number[];
  stopBits?: number[];
  parity?: string[];
  handshake?: string[];
  writeDelay?: number;
  postWriteDelay?: number;
  timeout?: number;
  retry?: number;
}

export interface HamlibRotatorCaps {
  rotType: 'azimuth' | 'elevation' | 'azel' | 'other';
  rotTypeMask: number;
  minAz: number;
  maxAz: number;
  minEl: number;
  maxEl: number;
  supportedStatuses: string[];
}

export interface HamlibRotatorConstructor {
  new(model: number, port?: string): HamlibRotator;
  getSupportedRotators(): HamlibSupportedRotatorInfo[];
  getHamlibVersion(): string;
  setDebugLevel(level: number): void;
  getCopyright?(): string;
  getLicense?(): string;
}

export interface HamlibRotator {
  open(): Promise<number>;
  close(): Promise<number>;
  destroy(): void;
  getConnectionInfo(): HamlibRotatorConnectionInfo;
  setPosition(azimuth: number, elevation: number): Promise<number>;
  getPosition(): Promise<HamlibRotatorPosition>;
  move(direction: HamlibRotatorDirection, speed: number): Promise<number>;
  stop(): Promise<number>;
  park(): Promise<number>;
  reset(resetType: HamlibRotatorResetType): Promise<number>;
  getInfo(): Promise<string>;
  getStatus(): Promise<HamlibRotatorStatus>;
  setConf(name: string, value: string): Promise<number>;
  getConf(name: string): Promise<string>;
  getConfigSchema(): HamlibConfigFieldDescriptor[];
  getPortCaps(): HamlibPortCaps;
  getRotatorCaps(): HamlibRotatorCaps;
  setLevel(level: string, value: number): Promise<number>;
  getLevel(level: string): Promise<number>;
  getSupportedLevels(): string[];
  setFunction(func: string, enable: boolean): Promise<number>;
  getFunction(func: string): Promise<boolean>;
  getSupportedFunctions(): string[];
  setParm(parm: string, value: number): Promise<number>;
  getParm(parm: string): Promise<number>;
  getSupportedParms(): string[];
}

export interface HamlibHostDependency {
  Rotator: HamlibRotatorConstructor;
  PASSBAND: {
    NORMAL: 0;
    NOCHANGE: -1;
  };
}

export interface HostDependencies {
  /** Host-owned node-hamlib Rotator surface. Requires the `host:hamlib` plugin permission. */
  readonly hamlib?: HamlibHostDependency;
}
