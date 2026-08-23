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
  /** Station callsign used by the digital-mode engine. */
  myCallsign: string;
  /** Station Maidenhead grid locator. */
  myGrid: string;
  /** Current digital-mode dial frequency in hertz. */
  frequency: number;
  /** Configured transmit power in watts. */
  transmitPower: number;
  /** Whether the Host automatically answers eligible decoded calls. */
  autoReply: boolean;
  /** No-progress receive/transmit cycles before the active QSO times out. */
  maxQSOTimeout: number;
  /** Set to 0 to disable the host repeated-transmission guard. */
  maxSameTransmissionCount: number;
  /** Whether decoding continues while any operator is transmitting. */
  decodeWhileTransmitting: boolean;
  /** Whether spectrum analysis continues while transmitting. */
  spectrumWhileTransmitting: boolean;
}

/** Partial update accepted by `ctx.settings.ft8.update()`. */
export type HostFT8SettingsPatch = Partial<HostFT8Settings>;

/** Current frequency preset list and whether it differs from Host defaults. */
export interface HostFrequencyPresetsSettings {
  /** Presets currently exposed by the Host. */
  presets: PresetFrequency[];
  /** `true` when the current list is user- or plugin-customized. */
  isCustomized: boolean;
}

/** Partial station metadata update accepted by the station namespace. */
export type HostStationInfoPatch = Partial<StationInfo>;
/** Partial PSK Reporter update accepted by the PSK Reporter namespace. */
export type HostPSKReporterSettingsPatch = Partial<PSKReporterConfig>;

/**
 * Read/update pair shared by patch- or replacement-based settings namespaces.
 * The concrete namespace type determines whether `update` is a partial patch or
 * complete replacement. Host schema validation, normalization or persistence
 * failures reject the returned Promise.
 */
export interface HostSettingsNamespace<TValue, TPatch> {
  /** Returns the current host setting value for this namespace. */
  get(): Promise<TValue>;
  /** Applies a patch or replacement value and returns the updated value. */
  update(patch: TPatch): Promise<TValue>;
}

/** Frequency preset namespace with explicit update and reset operations. */
export interface HostFrequencyPresetsSettingsNamespace {
  /** Returns the current preset list and customization flag. */
  get(): Promise<HostFrequencyPresetsSettings>;
  /** Replaces all presets and returns the normalized Host value. */
  update(presets: PresetFrequency[]): Promise<HostFrequencyPresetsSettings>;
  /** Restores Host defaults and returns the resulting value. */
  reset(): Promise<HostFrequencyPresetsSettings>;
}

/**
 * Permission-gated host settings surface exposed as `ctx.settings`.
 *
 * Each namespace requires its matching plugin manifest permission, for example
 * `settings:ft8` for `ctx.settings.ft8`.
 */
export interface HostSettingsControl {
  /** FT8/FT4 engine settings. Requires `settings:ft8`. */
  readonly ft8: HostSettingsNamespace<HostFT8Settings, HostFT8SettingsPatch>;
  /** Decode window configuration. Requires `settings:decode-windows`. */
  readonly decodeWindows: HostSettingsNamespace<DecodeWindowSettings, DecodeWindowSettings>;
  /** Realtime audio transport configuration. Requires `settings:realtime`. */
  readonly realtime: HostSettingsNamespace<RealtimeSettings, RealtimeSettings>;
  /** Frequency preset list. Requires `settings:frequency-presets`. */
  readonly frequencyPresets: HostFrequencyPresetsSettingsNamespace;
  /** Public station metadata. Requires `settings:station`. */
  readonly station: HostSettingsNamespace<StationInfo, HostStationInfoPatch>;
  /** PSK Reporter configuration. Requires `settings:psk-reporter`. */
  readonly pskReporter: HostSettingsNamespace<PSKReporterConfig, HostPSKReporterSettingsPatch>;
  /** NTP server list. Requires `settings:ntp`. */
  readonly ntp: HostSettingsNamespace<NtpServerListSettings, UpdateNtpServerListRequest>;
}
