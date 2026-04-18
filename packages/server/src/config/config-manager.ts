/* eslint-disable @typescript-eslint/no-explicit-any */
// ConfigManager - 配置合并和动态类型需要使用any

import { promises as fs } from 'fs';
import {
  AudioDeviceSettings,
  RadioOperatorConfig,
  HamlibConfig,
  PSKReporterConfig,
  DEFAULT_DECODE_WINDOW_SETTINGS,
  DEFAULT_RIGCTLD_BRIDGE_CONFIG,
  type LiveKitNetworkMode,
  type RealtimeTransportPolicy,
  type RigctldBridgeConfig,
} from '@tx5dr/contracts';
import type { RadioProfile, DecodeWindowSettings, PresetFrequency, StationInfo, OpenWebRXStationConfig, PluginsConfig } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { getConfigFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';
import { normalizeHamlibConfig, normalizeSerialConnectionConfig } from '../radio/hamlibConfigUtils.js';

const logger = createLogger('ConfigManager');

const LEGACY_STANDARD_QSO_SETTING_KEYS = [
  'maxQSOTimeoutCycles',
  'maxCallAttempts',
  'autoReplyToCQ',
  'autoResumeCQAfterFail',
  'autoResumeCQAfterSuccess',
  'replyToWorkedStations',
  'prioritizeNewCalls',
  'targetSelectionPriorityMode',
] as const;

// 应用配置接口
export interface AppConfig {
  // Profile 系统（取代旧的顶层 radio/audio）
  profiles: RadioProfile[];
  activeProfileId: string | null;

  ft8: {
    myCallsign: string;
    myGrid: string;
    frequency: number;
    transmitPower: number;
    autoReply: boolean;
    maxQSOTimeout: number;
    decodeWhileTransmitting: boolean; // 发射时允许解码
    spectrumWhileTransmitting: boolean; // 发射时允许频谱分析
  };
  // 最后选择的频率配置（数字模式: FT8/FT4）
  lastSelectedFrequency: {
    frequency: number;
    mode: string; // 协议模式，如 FT8, FT4
    radioMode?: string; // 电台调制模式，如 USB, LSB
    band: string;
    description?: string;
  } | null;
  // 最后选择的语音模式频率（独立于数字模式，切换时各自恢复）
  lastVoiceFrequency?: {
    frequency: number;
    radioMode?: string;
    band: string;
    description?: string;
  } | null;
  // 最后设置的音量增益（旧版全局值，保留用于迁移）
  lastVolumeGain: {
    gain: number; // 线性增益值
    gainDb: number; // dB增益值
  } | null;
  /** 按模式+频段存储的音量增益 (key: "digital_20m", "voice_40m" 等) */
  volumeGainMap?: Record<string, { gain: number; gainDb: number }> | null;
  server: {
    port: number;
    host: string;
  };
  operators: RadioOperatorConfig[];
  pskreporter: PSKReporterConfig;
  /** Override log level. Unset = use LOG_LEVEL env var (default: warn in production, info in development). */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Decode window settings per mode (preset or custom timing) */
  decodeWindowSettings?: DecodeWindowSettings;
  /** Custom frequency presets (null/undefined = use built-in defaults, includes all modes: FT8/FT4/VOICE) */
  customFrequencyPresets?: PresetFrequency[] | null;
  /** Last used engine mode ('digital' or 'voice'). Restored on startup. */
  lastEngineMode?: 'digital' | 'voice';
  /** Last used digital sub-mode name ('FT8' or 'FT4'). Restored on startup within digital mode. */
  lastDigitalModeName?: string;
  /** Voice mode operator callsign */
  voiceCallsign?: string;
  /** Voice mode operator grid */
  voiceGrid?: string;
  /** Optional externally reachable LiveKit signaling URL override. */
  livekitPublicUrl?: string | null;
  /** Realtime transport strategy preference. */
  realtimeTransportPolicy?: RealtimeTransportPolicy;
  /** LiveKit network topology mode. */
  livekitNetworkMode?: LiveKitNetworkMode;
  /** Manual LiveKit media announcement IP when auto detection is unsuitable. */
  livekitNodeIp?: string | null;
  /** Station basic information visible to all connected users */
  stationInfo?: StationInfo;
  /** OpenWebRX SDR station configurations */
  openwebrxStations?: OpenWebRXStationConfig[];
  /** Plugin system configuration */
  plugins?: PluginsConfig;
  /** rigctld-compatible TCP bridge (lets N1MM / WSJT-X / JTDX connect to this tx5dr instance). */
  rigctld?: RigctldBridgeConfig;
}

// 音频处理配置接口
export interface AudioConfig {
  inputDeviceName?: string; // 存储的设备名称
  outputDeviceName?: string; // 存储的设备名称
  sampleRate: number;
  bufferSize: number;
}

// 默认配置
const DEFAULT_CONFIG: AppConfig = {
  profiles: [],
  activeProfileId: null,
  ft8: {
    myCallsign: '',
    myGrid: '',
    frequency: 14074000, // 20m FT8频率
    transmitPower: 25,
    autoReply: false,
    maxQSOTimeout: 6, // 6个周期 = 90秒
    decodeWhileTransmitting: false, // 默认关闭,避免误解码残留信号
    spectrumWhileTransmitting: true, // 默认开启,发射时继续频谱分析
  },
  decodeWindowSettings: DEFAULT_DECODE_WINDOW_SETTINGS,
  lastSelectedFrequency: null, // 初始时没有选择过频率
  lastVolumeGain: null, // 初始时没有设置过音量增益
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  operators: [
    // 从空操作员列表开始，等待用户创建
  ],
  pskreporter: {
    enabled: false,
    receiverCallsign: '',
    receiverLocator: '',
    decodingSoftware: 'TX-5DR',
    antennaInformation: '',
    reportIntervalSeconds: 30,
    useTestServer: false,
    stats: {
      todayReportCount: 0,
      totalReportCount: 0,
      consecutiveFailures: 0,
    },
  },
  livekitNetworkMode: 'lan',
  livekitNodeIp: null,
  rigctld: { ...DEFAULT_RIGCTLD_BRIDGE_CONFIG },
};

// 默认音频配置（无 Profile 时的兜底值）
const DEFAULT_AUDIO: AudioDeviceSettings = {
  sampleRate: 48000,
  bufferSize: 768,
};

// 默认电台配置（无 Profile 时的兜底值）
const DEFAULT_RADIO: HamlibConfig = {
  type: 'none',
};

// 配置管理器
export class ConfigManager {
  private static instance: ConfigManager;
  private config: AppConfig;
  private configPath: string;

  private constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.configPath = ''; // 将在initialize中设置
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * 初始化配置管理器
   */
  async initialize(): Promise<void> {
    try {
      // 设置配置文件路径
      this.configPath = await getConfigFilePath('config.json');
      logger.info(`Config file path: ${this.configPath}`);

      await this.loadConfig();
      logger.info('Config file loaded successfully');
    } catch (error) {
      logger.info('Config file missing or invalid, using defaults');
      await this.saveConfig();
      logger.info('Default config file created');
    }
  }

  /**
   * 加载配置文件
   */
  private async loadConfig(): Promise<void> {
    const configData = await fs.readFile(this.configPath, 'utf-8');
    const parsedConfig = JSON.parse(configData);

    // 检测并迁移旧版 radio 配置格式（扁平 → 嵌套对象）
    if (parsedConfig.radio && this.needsRadioFormatMigration(parsedConfig.radio)) {
      logger.info('Detected legacy radio config format, migrating...');

      // 备份旧配置
      const backupPath = `${this.configPath}.backup`;
      await fs.writeFile(backupPath, configData, 'utf-8');
      logger.info(`Old config backed up to: ${backupPath}`);

      // 执行格式迁移
      parsedConfig.radio = this.migrateRadioConfigFormat(parsedConfig.radio);

      // 保存新格式配置
      await fs.writeFile(this.configPath, JSON.stringify(parsedConfig, null, 2), 'utf-8');
      logger.info('Radio config format migration complete');
    }

    // 迁移到 Profile 系统（旧 radio+audio → profiles）
    if (this.needsProfileMigration(parsedConfig)) {
      logger.info('Detected legacy radio/audio config, migrating to Profile system...');

      // 备份旧配置
      const backupPath = `${this.configPath}.profile-migration.backup`;
      await fs.writeFile(backupPath, configData, 'utf-8');
      logger.info(`Old config backed up to: ${backupPath}`);

      this.migrateToProfiles(parsedConfig);

      // 保存迁移后的配置
      await fs.writeFile(this.configPath, JSON.stringify(parsedConfig, null, 2), 'utf-8');
      logger.info('Profile migration complete');
    }

    if (this.migrateLegacyStandardQSOSettings(parsedConfig)) {
      logger.info('Legacy standard-qso operator settings migrated to plugin config');
      await fs.writeFile(this.configPath, JSON.stringify(parsedConfig, null, 2), 'utf-8');
    }

    // 迁移全局 lastVolumeGain → 按模式+频段的 volumeGainMap
    if (parsedConfig.lastVolumeGain && !parsedConfig.volumeGainMap) {
      logger.info('Migrating global volume gain to per-band/mode volumeGainMap...');
      const oldGain = parsedConfig.lastVolumeGain;
      const map: Record<string, { gain: number; gainDb: number }> = {};
      const bands = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m', '70cm', 'Unknown'];
      for (const band of bands) {
        map[`digital_${band}`] = { gain: oldGain.gain, gainDb: oldGain.gainDb };
        map[`voice_${band}`] = { gain: oldGain.gain, gainDb: oldGain.gainDb };
      }
      parsedConfig.volumeGainMap = map;
      parsedConfig.lastVolumeGain = null;
      await fs.writeFile(this.configPath, JSON.stringify(parsedConfig, null, 2), 'utf-8');
      logger.info('Volume gain migration complete');
    }

    // 合并默认配置和加载的配置
    this.config = this.mergeConfig(DEFAULT_CONFIG, parsedConfig);
  }

  /**
   * 保存配置文件
   */
  private async saveConfig(): Promise<void> {
    const configData = JSON.stringify(this.config, null, 2);
    await fs.writeFile(this.configPath, configData, 'utf-8');
  }

  /**
   * 深度合并配置对象
   */
  private mergeConfig(defaultConfig: any, userConfig: any): any {
    const result = { ...defaultConfig };

    for (const key in userConfig) {
      if (key === 'operators' && Array.isArray(userConfig[key])) {
        result[key] = userConfig[key].map((operator: any) => ({ ...operator }));
      // 特殊处理 volumeGainMap：直接使用用户配置（不深度合并）
      } else if (key === 'volumeGainMap' && typeof userConfig[key] === 'object') {
        result[key] = userConfig[key];
      // 特殊处理 profiles 数组：直接使用用户配置
      } else if (key === 'profiles' && Array.isArray(userConfig[key])) {
        result[key] = userConfig[key];
      } else if (userConfig[key] !== null && typeof userConfig[key] === 'object' && !Array.isArray(userConfig[key])) {
        result[key] = this.mergeConfig(defaultConfig[key] || {}, userConfig[key]);
      } else {
        result[key] = userConfig[key];
      }
    }

    return result;
  }

  private migrateLegacyStandardQSOSettings(parsedConfig: any): boolean {
    if (!Array.isArray(parsedConfig.operators) || parsedConfig.operators.length === 0) {
      return false;
    }

    let changed = false;
    parsedConfig.plugins ??= {};
    parsedConfig.plugins.configs ??= {};
    parsedConfig.plugins.operatorStrategies ??= {};
    parsedConfig.plugins.operatorSettings ??= {};

    for (const operator of parsedConfig.operators) {
      if (!operator || typeof operator !== 'object' || typeof operator.id !== 'string') {
        continue;
      }

      const migratedSettings: Record<string, unknown> = {};
      for (const key of LEGACY_STANDARD_QSO_SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(operator, key)) {
          migratedSettings[key] = operator[key];
          delete operator[key];
          changed = true;
        }
      }

      if (!parsedConfig.plugins.operatorStrategies[operator.id]) {
        parsedConfig.plugins.operatorStrategies[operator.id] = 'standard-qso';
        changed = true;
      }

      if (Object.keys(migratedSettings).length > 0) {
        parsedConfig.plugins.operatorSettings[operator.id] ??= {};
        parsedConfig.plugins.operatorSettings[operator.id]['standard-qso'] = {
          ...(parsedConfig.plugins.operatorSettings[operator.id]['standard-qso'] ?? {}),
          ...migratedSettings,
        };
      }
    }

    return changed;
  }

  // ===== Profile 迁移 =====

  /**
   * 检测是否需要从旧版 radio/audio 迁移到 Profile 系统
   */
  private needsProfileMigration(parsedConfig: any): boolean {
    // 已有 profiles 数组且非空 → 不需要迁移
    if (Array.isArray(parsedConfig.profiles) && parsedConfig.profiles.length > 0) {
      return false;
    }
    // 已有 profiles 字段（空数组）且无旧字段 → 不需要迁移（全新安装）
    if (Array.isArray(parsedConfig.profiles) && !parsedConfig.radio && !parsedConfig.audio) {
      return false;
    }
    // 存在旧的顶层 radio 或 audio → 需要迁移
    return parsedConfig.radio !== undefined || parsedConfig.audio !== undefined;
  }

  /**
   * 将旧的 radio+audio 配置迁移为 Profile
   */
  private migrateToProfiles(parsedConfig: any): void {
    const oldRadio: HamlibConfig = parsedConfig.radio || DEFAULT_RADIO;
    const oldAudio: AudioDeviceSettings = parsedConfig.audio || DEFAULT_AUDIO;

    // 根据电台类型生成默认名称
    let profileName = 'Default Configuration';
    if (oldRadio.type === 'icom-wlan') {
      profileName = `ICOM WLAN ${oldRadio.icomWlan?.ip || ''}`.trim();
    } else if (oldRadio.type === 'serial') {
      profileName = `Serial ${oldRadio.serial?.path || ''}`.trim();
    } else if (oldRadio.type === 'network') {
      profileName = `RigCtld ${oldRadio.network?.host || 'localhost'}`.trim();
    } else if (oldRadio.type === 'none') {
      profileName = 'Listening Only';
    }

    const now = Date.now();
    const defaultProfile: RadioProfile = {
      id: `profile-${now}-${Math.random().toString(36).substr(2, 9)}`,
      name: profileName,
      radio: oldRadio,
      audio: oldAudio,
      audioLockedToRadio: oldRadio.type === 'icom-wlan',
      createdAt: now,
      updatedAt: now,
      description: 'Automatically migrated from legacy configuration',
    };

    parsedConfig.profiles = [defaultProfile];
    parsedConfig.activeProfileId = defaultProfile.id;

    // 删除旧的顶层字段
    delete parsedConfig.radio;
    delete parsedConfig.audio;

    logger.info(`Created default profile: "${profileName}" (id: ${defaultProfile.id})`);
  }

  // ===== 旧版电台配置格式迁移 =====

  /**
   * 检测电台配置是否需要格式迁移（旧扁平格式 → 嵌套对象格式）
   */
  private needsRadioFormatMigration(radioConfig: any): boolean {
    const hasOldFlatFields =
      radioConfig.host !== undefined ||
      radioConfig.port !== undefined ||
      radioConfig.ip !== undefined ||
      radioConfig.wlanPort !== undefined ||
      radioConfig.path !== undefined ||
      radioConfig.rigModel !== undefined;

    const hasNewNestedFields =
      radioConfig.network !== undefined ||
      radioConfig.icomWlan !== undefined ||
      radioConfig.serial !== undefined;

    return hasOldFlatFields && !hasNewNestedFields;
  }

  /**
   * 迁移电台配置格式（旧扁平格式 → 嵌套对象格式）
   */
  private migrateRadioConfigFormat(oldConfig: any): HamlibConfig {
    const newConfig: HamlibConfig = {
      type: oldConfig.type || 'none',
      transmitCompensationMs: oldConfig.transmitCompensationMs,
    };

    logger.info(`Migrating radio config, connection type: ${newConfig.type}`);

    if (oldConfig.host !== undefined || oldConfig.port !== undefined) {
      newConfig.network = {
        host: oldConfig.host || 'localhost',
        port: oldConfig.port || 4532,
      };
      logger.info(`Migrated network config: ${newConfig.network.host}:${newConfig.network.port}`);
    }

    if (oldConfig.ip !== undefined || oldConfig.wlanPort !== undefined) {
      newConfig.icomWlan = {
        ip: oldConfig.ip || '',
        port: oldConfig.wlanPort || 50001,
        userName: oldConfig.userName,
        password: oldConfig.password,
        dataMode: true,
      };
      logger.info(`Migrated icomWlan config: ${newConfig.icomWlan.ip}:${newConfig.icomWlan.port}`);
    }

    if (oldConfig.path !== undefined || oldConfig.rigModel !== undefined) {
      newConfig.serial = normalizeSerialConnectionConfig({
        path: oldConfig.path || '',
        rigModel: oldConfig.rigModel || 0,
        serialConfig: oldConfig.serialConfig,
      });
      if (newConfig.serial) {
        logger.info(`Migrated serial config: ${newConfig.serial.path} (rigModel: ${newConfig.serial.rigModel})`);
      }
    }

    return newConfig;
  }

  // ===== Profile 管理方法 =====

  /**
   * 获取所有 Profile
   */
  getProfiles(): RadioProfile[] {
    return [...this.config.profiles];
  }

  /**
   * 获取当前激活的 Profile ID
   */
  getActiveProfileId(): string | null {
    return this.config.activeProfileId;
  }

  /**
   * 获取当前激活的 Profile
   */
  getActiveProfile(): RadioProfile | null {
    if (!this.config.activeProfileId) return null;
    return this.config.profiles.find(p => p.id === this.config.activeProfileId) || null;
  }

  /**
   * 获取指定 Profile
   */
  getProfile(id: string): RadioProfile | null {
    return this.config.profiles.find(p => p.id === id) || null;
  }

  /**
   * 添加 Profile
   */
  async addProfile(profile: RadioProfile): Promise<void> {
    this.config.profiles.push(profile);
    await this.saveConfig();
  }

  /**
   * 更新 Profile
   */
  async updateProfile(id: string, updates: Partial<Omit<RadioProfile, 'id' | 'createdAt'>>): Promise<RadioProfile> {
    const index = this.config.profiles.findIndex(p => p.id === id);
    if (index === -1) {
      throw new Error(`Profile ${id} does not exist`);
    }

    this.config.profiles[index] = {
      ...this.config.profiles[index],
      ...updates,
      updatedAt: Date.now(),
    };

    await this.saveConfig();
    return this.config.profiles[index];
  }

  /**
   * 删除 Profile
   */
  async deleteProfile(id: string): Promise<void> {
    const index = this.config.profiles.findIndex(p => p.id === id);
    if (index === -1) {
      throw new Error(`Profile ${id} does not exist`);
    }

    this.config.profiles.splice(index, 1);
    await this.saveConfig();
  }

  /**
   * 重排 Profile 顺序
   */
  async reorderProfiles(orderedIds: string[]): Promise<void> {
    const profileMap = new Map(this.config.profiles.map(p => [p.id, p]));
    const reordered = orderedIds
      .map(id => profileMap.get(id))
      .filter((p): p is RadioProfile => p !== undefined);

    if (reordered.length !== this.config.profiles.length) {
      throw new Error('Sort list does not match existing Profiles');
    }

    this.config.profiles = reordered;
    await this.saveConfig();
  }

  /**
   * 设置激活的 Profile ID
   */
  async setActiveProfileId(id: string | null): Promise<void> {
    if (id !== null && !this.config.profiles.find(p => p.id === id)) {
      throw new Error(`Profile ${id} does not exist`);
    }
    this.config.activeProfileId = id;
    await this.saveConfig();
  }

  // ===== 配置派生方法（从 activeProfile 派生，签名不变） =====

  /**
   * 获取完整配置
   */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * Internal migration helper used by plugin-layer compatibility routines.
   *
   * Accepts a fully materialized config object, including unknown legacy keys,
   * and persists it as the new in-memory/source-of-truth config.
   */
  async replaceConfigForMigration(config: AppConfig & Record<string, unknown>): Promise<void> {
    this.config = config as AppConfig;
    await this.saveConfig();
  }

  /**
   * 获取音频配置（从 activeProfile 派生）
   */
  getAudioConfig(): AudioDeviceSettings {
    const profile = this.getActiveProfile();
    return profile?.audio ? { ...profile.audio } : { ...DEFAULT_AUDIO };
  }

  /**
   * 更新音频配置（写入 activeProfile）
   */
  async updateAudioConfig(audioConfig: Partial<AudioDeviceSettings>): Promise<void> {
    const profile = this.getActiveProfile();
    if (profile) {
      profile.audio = { ...profile.audio, ...audioConfig };
      profile.updatedAt = Date.now();
      await this.saveConfig();
    }
  }

  /**
   * 获取FT8配置
   */
  getFT8Config() {
    return { ...this.config.ft8 };
  }

  /**
   * 更新FT8配置
   */
  async updateFT8Config(ft8Config: Partial<AppConfig['ft8']>): Promise<void> {
    this.config.ft8 = { ...this.config.ft8, ...ft8Config };
    await this.saveConfig();
  }

  /**
   * 获取服务器配置
   */
  getServerConfig() {
    return { ...this.config.server };
  }

  /**
   * 更新服务器配置
   */
  async updateServerConfig(serverConfig: Partial<AppConfig['server']>): Promise<void> {
    this.config.server = { ...this.config.server, ...serverConfig };
    await this.saveConfig();
  }

  /**
   * 获取电台(Hamlib)配置（从 activeProfile 派生）
   */
  getRadioConfig(): HamlibConfig {
    const profile = this.getActiveProfile();
    return profile?.radio ? normalizeHamlibConfig({ ...profile.radio } as HamlibConfig) : { ...DEFAULT_RADIO };
  }

  /**
   * 更新电台(Hamlib)配置（写入 activeProfile）
   */
  async updateRadioConfig(radioConfig: Partial<HamlibConfig>): Promise<void> {
    const profile = this.getActiveProfile();
    if (profile) {
      profile.radio = normalizeHamlibConfig({ ...profile.radio, ...radioConfig } as HamlibConfig);
      profile.updatedAt = Date.now();
      await this.saveConfig();
    }
  }

  /**
   * 重置配置为默认值
   */
  async resetConfig(): Promise<void> {
    this.config = { ...DEFAULT_CONFIG };
    await this.saveConfig();
  }

  /**
   * 获取操作员配置列表
   */
  getOperatorsConfig(): RadioOperatorConfig[] {
    return [...this.config.operators];
  }

  /**
   * 获取指定操作员配置
   */
  getOperatorConfig(id: string): RadioOperatorConfig | undefined {
    return this.config.operators.find(op => op.id === id);
  }

  /**
   * 添加操作员配置
   */
  async addOperatorConfig(operatorConfig: Omit<RadioOperatorConfig, 'id'>): Promise<RadioOperatorConfig> {
    // 生成唯一ID
    const id = `operator-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newOperator: RadioOperatorConfig = {
      ...operatorConfig,
      id,
      mode: operatorConfig.mode || MODES.FT8,
    };

    this.config.operators.push(newOperator);
    await this.saveConfig();
    return newOperator;
  }

  /**
   * 更新操作员配置
   */
  async updateOperatorConfig(id: string, updates: Partial<Omit<RadioOperatorConfig, 'id'>>): Promise<RadioOperatorConfig> {
    const operatorIndex = this.config.operators.findIndex(op => op.id === id);
    if (operatorIndex === -1) {
      throw new Error(`Operator ${id} does not exist`);
    }

    this.config.operators[operatorIndex] = {
      ...this.config.operators[operatorIndex],
      ...updates,
    };

    await this.saveConfig();
    return this.config.operators[operatorIndex];
  }

  /**
   * 删除操作员配置
   */
  async deleteOperatorConfig(id: string): Promise<void> {
    const operatorIndex = this.config.operators.findIndex(op => op.id === id);
    if (operatorIndex === -1) {
      throw new Error(`Operator ${id} does not exist`);
    }

    this.config.operators.splice(operatorIndex, 1);
    await this.saveConfig();
  }

  /**
   * 验证配置的有效性
   */
  validateConfig(): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 验证FT8配置
    if (!this.config.ft8.myCallsign) {
      errors.push('Callsign cannot be empty');
    }

    if (!this.config.ft8.myGrid) {
      errors.push('Grid locator cannot be empty');
    }

    if (this.config.ft8.frequency <= 0) {
      errors.push('Frequency must be greater than 0');
    }

    if (this.config.ft8.transmitPower <= 0 || this.config.ft8.transmitPower > 100) {
      errors.push('Transmit power must be between 1 and 100');
    }

    // 验证操作员配置
    this.config.operators.forEach((operator, index) => {
      if (!operator.myCallsign) {
        errors.push(`Operator ${index + 1}: callsign cannot be empty`);
      }
      if (operator.frequency < 200 || operator.frequency > 4000) {
        errors.push(`Operator ${index + 1}: frequency must be between 200 and 4000 Hz`);
      }
      if (!operator.transmitCycles || operator.transmitCycles.length === 0) {
        errors.push(`Operator ${index + 1}: transmit cycles cannot be empty`);
      }
    });

    // 检查操作员ID唯一性
    const operatorIds = this.config.operators.map(op => op.id);
    const duplicateIds = operatorIds.filter((id, index) => operatorIds.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      errors.push(`Duplicate operator IDs: ${duplicateIds.join(', ')}`);
    }

    // 验证服务器配置
    if (this.config.server.port <= 0 || this.config.server.port > 65535) {
      errors.push('Port number must be between 1 and 65535');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * 获取配置文件路径
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 设置配置文件路径
   */
  setConfigPath(path: string): void {
    this.configPath = path;
  }

  /**
   * 获取最后选择的频率
   */
  getLastSelectedFrequency(): AppConfig['lastSelectedFrequency'] {
    return this.config.lastSelectedFrequency ? { ...this.config.lastSelectedFrequency } : null;
  }

  /**
   * 更新最后选择的频率
   */
  async updateLastSelectedFrequency(frequencyConfig: {
    frequency: number;
    mode: string;
    radioMode?: string;
    band: string;
    description?: string;
  }): Promise<void> {
    this.config.lastSelectedFrequency = { ...frequencyConfig };
    await this.saveConfig();
    logger.debug(`Last selected frequency saved: ${frequencyConfig.description || frequencyConfig.frequency}Hz`);
  }

  /**
   * 获取最后选择的语音频率
   */
  getLastVoiceFrequency(): AppConfig['lastVoiceFrequency'] {
    return this.config.lastVoiceFrequency ? { ...this.config.lastVoiceFrequency } : null;
  }

  /**
   * 更新最后选择的语音频率
   */
  async updateLastVoiceFrequency(frequencyConfig: {
    frequency: number;
    radioMode?: string;
    band: string;
    description?: string;
  }): Promise<void> {
    this.config.lastVoiceFrequency = { ...frequencyConfig };
    await this.saveConfig();
    logger.debug(`Last voice frequency saved: ${frequencyConfig.description || frequencyConfig.frequency}Hz`);
  }

  /**
   * 清除最后选择的频率
   */
  async clearLastSelectedFrequency(): Promise<void> {
    this.config.lastSelectedFrequency = null;
    await this.saveConfig();
  }

  /**
   * 获取最后设置的音量增益
   */
  getLastVolumeGain(): AppConfig['lastVolumeGain'] {
    return this.config.lastVolumeGain ? { ...this.config.lastVolumeGain } : null;
  }

  /**
   * 更新最后设置的音量增益
   */
  async updateLastVolumeGain(gain: number, gainDb: number): Promise<void> {
    this.config.lastVolumeGain = { gain, gainDb };
    await this.saveConfig();
    logger.debug(`Last volume gain saved: ${gainDb.toFixed(1)}dB (${gain.toFixed(3)})`);
  }

  /**
   * 清除最后设置的音量增益
   */
  async clearLastVolumeGain(): Promise<void> {
    this.config.lastVolumeGain = null;
    await this.saveConfig();
  }

  /**
   * 获取指定模式+频段的音量增益
   */
  getVolumeGainForSlot(modeCategory: string, band: string): { gain: number; gainDb: number } | null {
    const key = `${modeCategory}_${band}`;
    const map = this.config.volumeGainMap;
    if (!map || !map[key]) return null;
    return { ...map[key] };
  }

  /**
   * 更新指定模式+频段的音量增益
   */
  async updateVolumeGainForSlot(modeCategory: string, band: string, gain: number, gainDb: number): Promise<void> {
    const key = `${modeCategory}_${band}`;
    if (!this.config.volumeGainMap) {
      this.config.volumeGainMap = {};
    }
    this.config.volumeGainMap[key] = { gain, gainDb };
    await this.saveConfig();
    logger.debug(`Volume gain saved for ${key}: ${gainDb.toFixed(1)}dB (${gain.toFixed(3)})`);
  }

  /**
   * 获取 PSKReporter 配置
   */
  getPSKReporterConfig(): PSKReporterConfig {
    return { ...this.config.pskreporter };
  }

  /**
   * 更新 PSKReporter 配置
   */
  async updatePSKReporterConfig(config: Partial<PSKReporterConfig>): Promise<void> {
    this.config.pskreporter = { ...this.config.pskreporter, ...config };
    await this.saveConfig();
  }

  /**
   * 更新 PSKReporter 统计信息（不触发完整保存，仅更新统计）
   */
  async updatePSKReporterStats(stats: Partial<PSKReporterConfig['stats']>): Promise<void> {
    this.config.pskreporter.stats = { ...this.config.pskreporter.stats, ...stats };
    await this.saveConfig();
  }

  /**
   * 重置 PSKReporter 配置为默认值
   */
  async resetPSKReporterConfig(): Promise<void> {
    this.config.pskreporter = { ...DEFAULT_CONFIG.pskreporter };
    await this.saveConfig();
  }

  /**
   * rigctld-compatible bridge: read configuration. Env overrides (RIGCTLD_ENABLED /
   * RIGCTLD_BIND / RIGCTLD_PORT) take precedence over the stored value, so Docker
   * and headless deployments can enable the bridge without touching the UI.
   */
  getRigctldConfig(): RigctldBridgeConfig {
    const stored = this.config.rigctld ?? { ...DEFAULT_RIGCTLD_BRIDGE_CONFIG };
    const envEnabled = process.env.RIGCTLD_ENABLED;
    const envBind = process.env.RIGCTLD_BIND;
    const envPort = process.env.RIGCTLD_PORT;
    const envReadOnly = process.env.RIGCTLD_READ_ONLY;
    return {
      enabled:
        envEnabled !== undefined
          ? envEnabled === '1' || envEnabled.toLowerCase() === 'true'
          : stored.enabled,
      bindAddress: envBind ?? stored.bindAddress,
      port: envPort !== undefined && Number.isFinite(Number(envPort)) ? Number(envPort) : stored.port,
      readOnly:
        envReadOnly !== undefined
          ? envReadOnly === '1' || envReadOnly.toLowerCase() === 'true'
          : stored.readOnly ?? true,
    };
  }

  /**
   * Update and persist the rigctld bridge configuration. The subsystem restart
   * is driven by whoever calls this (typically `DigitalRadioEngine.setRigctldConfig`).
   */
  async updateRigctldConfig(patch: Partial<RigctldBridgeConfig>): Promise<RigctldBridgeConfig> {
    const current = this.config.rigctld ?? { ...DEFAULT_RIGCTLD_BRIDGE_CONFIG };
    this.config.rigctld = { ...current, ...patch };
    await this.saveConfig();
    return { ...this.config.rigctld };
  }

  // ===== 按呼号的同步配置 =====

  /**
   * 从呼号中提取基础呼号（去除前后缀）
   */
  private normalizeCallsign(callsign: string): string {
    const upper = callsign.toUpperCase().trim();
    if (!upper.includes('/')) return upper;
    const parts = upper.split('/');
    let best = parts[0];
    for (const part of parts) {
      if (part.length > best.length && /[A-Z]/.test(part) && /\d/.test(part)) {
        best = part;
      }
    }
    return best;
  }

  // ===== 解码窗口设置 =====

  /**
   * 获取解码窗口设置
   */
  getDecodeWindowSettings(): DecodeWindowSettings | undefined {
    return this.config.decodeWindowSettings ?? DEFAULT_DECODE_WINDOW_SETTINGS;
  }

  /**
   * 更新解码窗口设置
   */
  async updateDecodeWindowSettings(settings: DecodeWindowSettings): Promise<void> {
    this.config.decodeWindowSettings = settings;
    await this.saveConfig();
  }

  getLiveKitPublicUrl(): string | null {
    return this.config.livekitPublicUrl ?? null;
  }

  async updateLiveKitPublicUrl(url: string | null): Promise<void> {
    this.config.livekitPublicUrl = url;
    await this.saveConfig();
  }

  getRealtimeTransportPolicy(): RealtimeTransportPolicy {
    return this.config.realtimeTransportPolicy ?? 'auto';
  }

  async updateRealtimeTransportPolicy(policy: RealtimeTransportPolicy): Promise<void> {
    this.config.realtimeTransportPolicy = policy;
    await this.saveConfig();
  }

  getLiveKitNetworkMode(): LiveKitNetworkMode {
    return this.config.livekitNetworkMode ?? 'lan';
  }

  async updateLiveKitNetworkMode(mode: LiveKitNetworkMode): Promise<void> {
    this.config.livekitNetworkMode = mode;
    await this.saveConfig();
  }

  getLiveKitNodeIp(): string | null {
    return this.config.livekitNodeIp?.trim() || null;
  }

  async updateLiveKitNodeIp(nodeIp: string | null): Promise<void> {
    this.config.livekitNodeIp = nodeIp?.trim() || null;
    await this.saveConfig();
  }

  // ==================== 频率预设管理 ====================

  getCustomFrequencyPresets(): PresetFrequency[] | null {
    return this.config.customFrequencyPresets ?? null;
  }

  async updateCustomFrequencyPresets(presets: PresetFrequency[]): Promise<void> {
    this.config.customFrequencyPresets = presets;
    await this.saveConfig();
  }

  async resetCustomFrequencyPresets(): Promise<void> {
    this.config.customFrequencyPresets = null;
    await this.saveConfig();
  }

  // ==================== Engine mode persistence ====================

  getLastEngineMode(): 'digital' | 'voice' {
    return this.config.lastEngineMode ?? 'digital';
  }

  async setLastEngineMode(mode: 'digital' | 'voice'): Promise<void> {
    this.config.lastEngineMode = mode;
    await this.saveConfig();
  }

  getLastDigitalModeName(): string {
    return this.config.lastDigitalModeName ?? 'FT8';
  }

  async setLastDigitalModeName(modeName: string): Promise<void> {
    this.config.lastDigitalModeName = modeName;
    await this.saveConfig();
  }

  // ===== Voice mode config =====

  getVoiceCallsign(): string {
    return this.config.voiceCallsign ?? '';
  }

  async setVoiceCallsign(callsign: string): Promise<void> {
    this.config.voiceCallsign = callsign;
    await this.saveConfig();
  }

  getVoiceGrid(): string {
    return this.config.voiceGrid ?? '';
  }

  async setVoiceGrid(grid: string): Promise<void> {
    this.config.voiceGrid = grid;
    await this.saveConfig();
  }

  getStationInfo(): StationInfo {
    return this.config.stationInfo ?? {};
  }

  async updateStationInfo(info: StationInfo): Promise<void> {
    this.config.stationInfo = { ...this.config.stationInfo, ...info };
    await this.saveConfig();
    logger.info('Station info updated', { callsign: info.callsign });
  }

  // ===== OpenWebRX 站点管理 =====

  getOpenWebRXStations(): OpenWebRXStationConfig[] {
    return this.config.openwebrxStations ?? [];
  }

  getOpenWebRXStationById(id: string): OpenWebRXStationConfig | undefined {
    return this.getOpenWebRXStations().find(s => s.id === id);
  }

  async addOpenWebRXStation(station: OpenWebRXStationConfig): Promise<void> {
    const stations = this.getOpenWebRXStations();
    stations.push(station);
    this.config.openwebrxStations = stations;
    await this.saveConfig();
    logger.info('OpenWebRX station added', { id: station.id, name: station.name });
  }

  async updateOpenWebRXStation(id: string, updates: Partial<Omit<OpenWebRXStationConfig, 'id'>>): Promise<void> {
    const stations = this.getOpenWebRXStations();
    const index = stations.findIndex(s => s.id === id);
    if (index === -1) {
      throw new Error(`OpenWebRX station not found: ${id}`);
    }
    stations[index] = { ...stations[index], ...updates };
    this.config.openwebrxStations = stations;
    await this.saveConfig();
    logger.info('OpenWebRX station updated', { id });
  }

  async removeOpenWebRXStation(id: string): Promise<void> {
    const stations = this.getOpenWebRXStations();
    this.config.openwebrxStations = stations.filter(s => s.id !== id);
    await this.saveConfig();
    logger.info('OpenWebRX station removed', { id });
  }

  // ===== 插件配置 =====

  getPluginsConfig(): PluginsConfig {
    return this.config.plugins ?? { configs: {}, operatorStrategies: {}, operatorSettings: {} };
  }

  async setPluginConfig(name: string, entry: { enabled: boolean; settings: Record<string, unknown> }): Promise<void> {
    if (!this.config.plugins) {
      this.config.plugins = { configs: {}, operatorStrategies: {}, operatorSettings: {} };
    }
    this.config.plugins.configs = { ...(this.config.plugins.configs ?? {}), [name]: entry };
    await this.saveConfig();
  }

  getOperatorStrategy(operatorId: string): string {
    return this.config.plugins?.operatorStrategies?.[operatorId] ?? 'standard-qso';
  }

  async setOperatorStrategy(operatorId: string, pluginName: string): Promise<void> {
    if (!this.config.plugins) {
      this.config.plugins = { configs: {}, operatorStrategies: {}, operatorSettings: {} };
    }
    this.config.plugins.operatorStrategies = {
      ...this.config.plugins.operatorStrategies,
      [operatorId]: pluginName,
    };
    await this.saveConfig();
    logger.info('Operator strategy updated', { operatorId, pluginName });
  }

  /** 获取某操作员某插件的 operator-scope 设置 */
  getOperatorPluginSettings(operatorId: string, pluginName: string): Record<string, unknown> {
    return this.config.plugins?.operatorSettings?.[operatorId]?.[pluginName] ?? {};
  }

  /** 保存某操作员某插件的 operator-scope 设置 */
  async setOperatorPluginSettings(
    operatorId: string,
    pluginName: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.plugins) {
      this.config.plugins = { configs: {}, operatorStrategies: {}, operatorSettings: {} };
    }
    if (!this.config.plugins.operatorSettings) {
      this.config.plugins.operatorSettings = {};
    }
    if (!this.config.plugins.operatorSettings[operatorId]) {
      this.config.plugins.operatorSettings[operatorId] = {};
    }
    this.config.plugins.operatorSettings[operatorId][pluginName] = settings;
    await this.saveConfig();
    logger.info('Operator plugin settings updated', { operatorId, pluginName });
  }
}
