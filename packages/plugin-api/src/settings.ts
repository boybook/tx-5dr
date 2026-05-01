import type {
  DecodeWindowSettings,
  NtpServerListSettings,
  PresetFrequency,
  PSKReporterConfig,
  RealtimeSettings,
  StationInfo,
  UpdateNtpServerListRequest,
} from '@tx5dr/contracts';

/**
 * Host-level FT8/FT4 settings that plugins may inspect or adjust when granted
 * the `settings:ft8` permission.
 */
export interface HostFT8Settings {
  myCallsign: string;
  myGrid: string;
  frequency: number;
  transmitPower: number;
  autoReply: boolean;
  maxQSOTimeout: number;
  /** Set to 0 to disable the host repeated-transmission guard. */
  maxSameTransmissionCount: number;
  decodeWhileTransmitting: boolean;
  spectrumWhileTransmitting: boolean;
}

export type HostFT8SettingsPatch = Partial<HostFT8Settings>;

export interface HostFrequencyPresetsSettings {
  presets: PresetFrequency[];
  isCustomized: boolean;
}

export type HostStationInfoPatch = Partial<StationInfo>;
export type HostPSKReporterSettingsPatch = Partial<PSKReporterConfig>;

export interface HostSettingsNamespace<TValue, TPatch> {
  /** Returns the current host setting value for this namespace. */
  get(): Promise<TValue>;
  /** Applies a patch or replacement value and returns the updated value. */
  update(patch: TPatch): Promise<TValue>;
}

export interface HostFrequencyPresetsSettingsNamespace {
  get(): Promise<HostFrequencyPresetsSettings>;
  update(presets: PresetFrequency[]): Promise<HostFrequencyPresetsSettings>;
  reset(): Promise<HostFrequencyPresetsSettings>;
}

/**
 * Permission-gated host settings surface exposed as `ctx.settings`.
 *
 * Each namespace requires its matching plugin manifest permission, for example
 * `settings:ft8` for `ctx.settings.ft8`.
 */
export interface HostSettingsControl {
  readonly ft8: HostSettingsNamespace<HostFT8Settings, HostFT8SettingsPatch>;
  readonly decodeWindows: HostSettingsNamespace<DecodeWindowSettings, DecodeWindowSettings>;
  readonly realtime: HostSettingsNamespace<RealtimeSettings, RealtimeSettings>;
  readonly frequencyPresets: HostFrequencyPresetsSettingsNamespace;
  readonly station: HostSettingsNamespace<StationInfo, HostStationInfoPatch>;
  readonly pskReporter: HostSettingsNamespace<PSKReporterConfig, HostPSKReporterSettingsPatch>;
  readonly ntp: HostSettingsNamespace<NtpServerListSettings, UpdateNtpServerListRequest>;
}
