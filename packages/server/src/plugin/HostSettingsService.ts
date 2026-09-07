import {
  CustomFrequencyPresetsSchema,
  DecodeWindowSettingsSchema,
  DEFAULT_DECODE_WINDOW_SETTINGS,
  NtpServerListSettingsSchema,
  PSKReporterConfigSchema,
  RealtimeSettingsSchema,
  StationInfoSchema,
  UpdateNtpServerListRequestSchema,
  type DecodeWindowSettings,
  type NtpServerListSettings,
  type PresetFrequency,
  type PSKReporterConfig,
  type RealtimeSettings,
  type StationInfo,
  type UpdateNtpServerListRequest,
} from '@tx5dr/contracts';
import type {
  HostFT8Settings,
  HostFT8SettingsPatch,
  HostFrequencyPresetsSettings,
  HostPSKReporterSettingsPatch,
  HostStationInfoPatch,
} from '@tx5dr/plugin-api';
import { ConfigManager, type AppConfig } from '../config/config-manager.js';
import { FrequencyManager } from '../radio/FrequencyManager.js';

export class HostSettingsService {
  constructor(private readonly configManager = ConfigManager.getInstance()) {}

  getFT8(): HostFT8Settings {
    return this.configManager.getFT8Config() as HostFT8Settings;
  }

  async updateFT8(patch: HostFT8SettingsPatch): Promise<HostFT8Settings> {
    await this.configManager.updateFT8Config(patch as Partial<AppConfig['ft8']>);
    return this.getFT8();
  }

  getDecodeWindows(): DecodeWindowSettings {
    const configured = this.configManager.getDecodeWindowSettings();
    return DecodeWindowSettingsSchema.parse({
      decodeDepth: configured?.decodeDepth ?? DEFAULT_DECODE_WINDOW_SETTINGS.decodeDepth,
      ft8: configured?.ft8 ?? DEFAULT_DECODE_WINDOW_SETTINGS.ft8,
      ft4: configured?.ft4 ?? DEFAULT_DECODE_WINDOW_SETTINGS.ft4,
    });
  }

  async updateDecodeWindows(settings: DecodeWindowSettings): Promise<DecodeWindowSettings> {
    const parsed = DecodeWindowSettingsSchema.parse(settings);
    const current = this.getDecodeWindows();
    // Older persisted configs and plugin callers may omit the newly added
    // global depth (or either mode block). Keep those values stable while
    // still validating the complete value that is written to disk.
    const merged = DecodeWindowSettingsSchema.parse({
      decodeDepth: parsed.decodeDepth ?? current.decodeDepth ?? DEFAULT_DECODE_WINDOW_SETTINGS.decodeDepth,
      ft8: parsed.ft8 ?? current.ft8 ?? DEFAULT_DECODE_WINDOW_SETTINGS.ft8,
      ft4: parsed.ft4 ?? current.ft4 ?? DEFAULT_DECODE_WINDOW_SETTINGS.ft4,
    });
    await this.configManager.updateDecodeWindowSettings(merged);
    return this.getDecodeWindows();
  }

  getRealtime(): RealtimeSettings {
    return RealtimeSettingsSchema.parse({
      transportPolicy: this.configManager.getRealtimeTransportPolicy(),
      rtcDataAudioPublicHost: this.configManager.getRtcDataAudioPublicHost(),
      rtcDataAudioPublicUdpPort: this.configManager.getRtcDataAudioPublicUdpPort(),
    });
  }

  async updateRealtime(settings: RealtimeSettings): Promise<RealtimeSettings> {
    const parsed = RealtimeSettingsSchema.parse(settings);
    await this.configManager.updateRealtimeTransportPolicy(parsed.transportPolicy ?? 'auto');
    await this.configManager.updateRtcDataAudioPublicHost(parsed.rtcDataAudioPublicHost?.trim() || null);
    await this.configManager.updateRtcDataAudioPublicUdpPort(parsed.rtcDataAudioPublicUdpPort ?? null);
    return this.getRealtime();
  }

  getFrequencyPresets(): HostFrequencyPresetsSettings {
    const custom = this.configManager.getCustomFrequencyPresets();
    const freqManager = new FrequencyManager(custom);
    return {
      presets: freqManager.getPresets(),
      isCustomized: custom !== null,
    };
  }

  async updateFrequencyPresets(presets: PresetFrequency[]): Promise<HostFrequencyPresetsSettings> {
    const parsed = CustomFrequencyPresetsSchema.parse({ presets });
    await this.configManager.updateCustomFrequencyPresets(parsed.presets);
    return this.getFrequencyPresets();
  }

  async resetFrequencyPresets(): Promise<HostFrequencyPresetsSettings> {
    await this.configManager.resetCustomFrequencyPresets();
    return this.getFrequencyPresets();
  }

  getStation(): StationInfo {
    return this.configManager.getStationInfo();
  }

  async updateStation(patch: HostStationInfoPatch): Promise<StationInfo> {
    const parsed = StationInfoSchema.parse(patch);
    await this.configManager.updateStationInfo(parsed);
    return this.getStation();
  }

  getPSKReporter(): PSKReporterConfig {
    return this.configManager.getPSKReporterConfig();
  }

  async updatePSKReporter(patch: HostPSKReporterSettingsPatch): Promise<PSKReporterConfig> {
    const parsed = PSKReporterConfigSchema.partial().parse(patch);
    await this.configManager.updatePSKReporterConfig(parsed);
    return this.getPSKReporter();
  }

  getNtp(): NtpServerListSettings {
    return NtpServerListSettingsSchema.parse({
      servers: this.configManager.getNtpServers(),
      defaultServers: this.configManager.getDefaultNtpServers(),
    });
  }

  async updateNtp(request: UpdateNtpServerListRequest): Promise<NtpServerListSettings> {
    const parsed = UpdateNtpServerListRequestSchema.parse(request);
    await this.configManager.updateNtpServers(parsed.servers);
    return this.getNtp();
  }
}
