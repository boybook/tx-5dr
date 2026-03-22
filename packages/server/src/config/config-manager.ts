/* eslint-disable @typescript-eslint/no-explicit-any */
// ConfigManager - 配置合并和动态类型需要使用any

import { promises as fs } from 'fs';
import { AudioDeviceSettings, RadioOperatorConfig, HamlibConfig, WaveLogConfig, PSKReporterConfig, QRZConfig, LoTWConfig, CallsignSyncConfig, SyncSummary } from '@tx5dr/contracts';
import type { RadioProfile } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { getConfigFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ConfigManager');

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
  // 最后选择的频率配置
  lastSelectedFrequency: {
    frequency: number;
    mode: string; // 协议模式，如 FT8, FT4
    radioMode?: string; // 电台调制模式，如 USB, LSB
    band: string;
    description?: string;
  } | null;
  // 最后设置的音量增益
  lastVolumeGain: {
    gain: number; // 线性增益值
    gainDb: number; // dB增益值
  } | null;
  server: {
    port: number;
    host: string;
  };
  operators: RadioOperatorConfig[];
  // 按呼号绑定的同步配置（替代旧的全局 wavelog/qrz/lotw）
  callsignSyncConfigs: Record<string, CallsignSyncConfig>;
  wavelog: WaveLogConfig;
  qrz: QRZConfig;
  lotw: LoTWConfig;
  pskreporter: PSKReporterConfig;
  /** Override log level. Unset = use LOG_LEVEL env var (default: warn in production, info in development). */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
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
  lastSelectedFrequency: null, // 初始时没有选择过频率
  lastVolumeGain: null, // 初始时没有设置过音量增益
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  operators: [
    // 从空操作员列表开始，等待用户创建
  ],
  callsignSyncConfigs: {},
  wavelog: {
    url: '',
    apiKey: '',
    stationId: '',
    radioName: 'TX5DR',
    autoUploadQSO: true,
  },
  qrz: {
    apiKey: '',
    autoUploadQSO: false,
  },
  lotw: {
    username: '',
    password: '',
    tqslPath: '',
    stationCallsign: '',
    autoUploadQSO: false,
  },
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

    // 迁移全局同步配置到按呼号的 callsignSyncConfigs
    if (this.needsSyncConfigMigration(parsedConfig)) {
      logger.info('Detected global sync config, migrating to per-callsign sync config...');
      this.migrateSyncConfigs(parsedConfig);
      await fs.writeFile(this.configPath, JSON.stringify(parsedConfig, null, 2), 'utf-8');
      logger.info('Sync config migration complete');
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
      // 特殊处理 operators 数组：为每个操作员对象补全默认值
      if (key === 'operators' && Array.isArray(userConfig[key])) {
        result[key] = userConfig[key].map((operator: any) => {
          // 为每个操作员对象补全所有字段的默认值
          return {
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 3,
            autoReplyToCQ: false,
            autoResumeCQAfterFail: false,
            autoResumeCQAfterSuccess: false,
            replyToWorkedStations: false,
            prioritizeNewCalls: true,
            ...operator,  // 用户配置覆盖默认值
          };
        });
      // 特殊处理 callsignSyncConfigs：直接使用用户配置（不深度合并）
      } else if (key === 'callsignSyncConfigs' && typeof userConfig[key] === 'object') {
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
      newConfig.serial = {
        path: oldConfig.path || '',
        rigModel: oldConfig.rigModel || 0,
        serialConfig: oldConfig.serialConfig,
      };
      logger.info(`Migrated serial config: ${newConfig.serial.path} (rigModel: ${newConfig.serial.rigModel})`);
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
    return profile?.radio ? { ...profile.radio } as HamlibConfig : { ...DEFAULT_RADIO };
  }

  /**
   * 更新电台(Hamlib)配置（写入 activeProfile）
   */
  async updateRadioConfig(radioConfig: Partial<HamlibConfig>): Promise<void> {
    const profile = this.getActiveProfile();
    if (profile) {
      profile.radio = { ...profile.radio, ...radioConfig } as HamlibConfig;
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
   * 获取QRZ配置
   */
  getQRZConfig(): QRZConfig {
    return { ...this.config.qrz };
  }

  /**
   * 更新QRZ配置
   */
  async updateQRZConfig(qrzConfig: Partial<QRZConfig>): Promise<void> {
    this.config.qrz = { ...this.config.qrz, ...qrzConfig };
    await this.saveConfig();
  }

  /**
   * 重置QRZ配置为默认值
   */
  async resetQRZConfig(): Promise<void> {
    this.config.qrz = { ...DEFAULT_CONFIG.qrz };
    await this.saveConfig();
  }

  /**
   * 获取LoTW配置
   */
  getLoTWConfig(): LoTWConfig {
    return { ...this.config.lotw };
  }

  /**
   * 更新LoTW配置
   */
  async updateLoTWConfig(lotwConfig: Partial<LoTWConfig>): Promise<void> {
    this.config.lotw = { ...this.config.lotw, ...lotwConfig };
    await this.saveConfig();
  }

  /**
   * 重置LoTW配置为默认值
   */
  async resetLoTWConfig(): Promise<void> {
    this.config.lotw = { ...DEFAULT_CONFIG.lotw };
    await this.saveConfig();
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

  /**
   * 检测是否需要从全局同步配置迁移到按呼号配置
   */
  private needsSyncConfigMigration(parsedConfig: any): boolean {
    // 已有 callsignSyncConfigs → 不需要迁移
    if (parsedConfig.callsignSyncConfigs && Object.keys(parsedConfig.callsignSyncConfigs).length > 0) {
      return false;
    }
    // 有全局同步配置且至少一个启用了 → 需要迁移
    const hasWavelog = parsedConfig.wavelog?.url && parsedConfig.wavelog?.apiKey;
    const hasQrz = parsedConfig.qrz?.apiKey;
    const hasLotw = parsedConfig.lotw?.username || parsedConfig.lotw?.tqslPath;
    return !!(hasWavelog || hasQrz || hasLotw);
  }

  /**
   * 将全局同步配置迁移到按呼号配置
   */
  private migrateSyncConfigs(parsedConfig: any): void {
    const callsignSyncConfigs: Record<string, any> = {};

    // 收集所有操作员的唯一基础呼号
    const callsigns = new Set<string>();
    if (Array.isArray(parsedConfig.operators)) {
      for (const op of parsedConfig.operators) {
        if (op.myCallsign) {
          callsigns.add(this.normalizeCallsign(op.myCallsign));
        }
      }
    }

    // 如果没有操作员，不迁移
    if (callsigns.size === 0) return;

    // 将全局配置复制到每个呼号
    for (const callsign of callsigns) {
      const config: any = { callsign };
      if (parsedConfig.wavelog) {
        config.wavelog = { ...parsedConfig.wavelog };
      }
      if (parsedConfig.qrz) {
        config.qrz = { ...parsedConfig.qrz };
      }
      if (parsedConfig.lotw) {
        config.lotw = { ...parsedConfig.lotw, stationCallsign: callsign };
      }
      callsignSyncConfigs[callsign] = config;
    }

    parsedConfig.callsignSyncConfigs = callsignSyncConfigs;

    // 清除旧的全局同步配置
    delete parsedConfig.wavelog;
    delete parsedConfig.qrz;
    delete parsedConfig.lotw;

    logger.info(`Sync config migrated for ${callsigns.size} callsign(s): ${[...callsigns].join(', ')}`);
  }

  /**
   * 获取指定呼号的同步配置
   */
  getCallsignSyncConfig(callsign: string): CallsignSyncConfig | null {
    const key = this.normalizeCallsign(callsign);
    return this.config.callsignSyncConfigs[key] || null;
  }

  /**
   * 更新指定呼号的同步配置
   */
  async updateCallsignSyncConfig(callsign: string, updates: Partial<CallsignSyncConfig>): Promise<void> {
    const key = this.normalizeCallsign(callsign);
    const existing = this.config.callsignSyncConfigs[key] || { callsign: key };
    this.config.callsignSyncConfigs[key] = { ...existing, ...updates, callsign: key };
    await this.saveConfig();
  }

  /**
   * 删除指定呼号的同步配置
   */
  async deleteCallsignSyncConfig(callsign: string): Promise<void> {
    const key = this.normalizeCallsign(callsign);
    delete this.config.callsignSyncConfigs[key];
    await this.saveConfig();
  }

  /**
   * 获取所有呼号的同步配置
   */
  getAllCallsignSyncConfigs(): Record<string, CallsignSyncConfig> {
    return { ...this.config.callsignSyncConfigs };
  }

  /**
   * 获取指定呼号的同步摘要（哪些服务已启用）
   */
  getCallsignSyncSummary(callsign: string): SyncSummary {
    const config = this.getCallsignSyncConfig(callsign);
    return {
      wavelog: !!(config?.wavelog?.url && config?.wavelog?.apiKey),
      qrz: !!(config?.qrz?.apiKey),
      lotw: !!(config?.lotw?.username || config?.lotw?.tqslPath),
    };
  }
}
