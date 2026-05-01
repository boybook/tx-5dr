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
    return this.configManager.getDecodeWindowSettings() ?? DEFAULT_DECODE_WINDOW_SETTINGS;
  }

  async updateDecodeWindows(settings: DecodeWindowSettings): Promise<DecodeWindowSettings> {
    const parsed = DecodeWindowSettingsSchema.parse(settings);
    await this.configManager.updateDecodeWindowSettings(parsed);
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
