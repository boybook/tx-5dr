import { promises as fs } from 'fs';
import { join } from 'path';
import { AudioDeviceSettings, RadioOperatorConfig, HamlibConfig, WaveLogConfig } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { getConfigFilePath } from '../utils/app-paths.js';

// 应用配置接口
export interface AppConfig {
  audio: AudioDeviceSettings;
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
  radio: HamlibConfig;
  operators: RadioOperatorConfig[];
  wavelog: WaveLogConfig;
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
  audio: {
    inputDeviceName: undefined,  // 默认无设备名称，使用系统默认
    outputDeviceName: undefined, // 默认无设备名称，使用系统默认
    sampleRate: 48000,
    bufferSize: 768
  },
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
  radio: {
    type: 'none',
  },
  operators: [
    // 从空操作员列表开始，等待用户创建
  ],
  wavelog: {
    enabled: false,
    url: '',
    apiKey: '',
    stationId: '',
    radioName: 'TX5DR',
    autoUploadQSO: true,
  },
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
      console.log(`📁 [配置管理器] 配置文件路径: ${this.configPath}`);
      
      await this.loadConfig();
      console.log('✅ [配置管理器] 配置文件加载成功');
    } catch (error) {
      console.log('⚠️ [配置管理器] 配置文件不存在或格式错误，使用默认配置');
      await this.saveConfig();
      console.log('✅ [配置管理器] 默认配置文件已创建');
    }
  }

  /**
   * 加载配置文件
   */
  private async loadConfig(): Promise<void> {
    const configData = await fs.readFile(this.configPath, 'utf-8');
    const parsedConfig = JSON.parse(configData);
    
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
      if (userConfig[key] !== null && typeof userConfig[key] === 'object' && !Array.isArray(userConfig[key])) {
        result[key] = this.mergeConfig(defaultConfig[key] || {}, userConfig[key]);
      } else {
        result[key] = userConfig[key];
      }
    }
    
    return result;
  }

  /**
   * 获取完整配置
   */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * 获取音频配置
   */
  getAudioConfig(): AudioDeviceSettings {
    return { ...this.config.audio };
  }

  /**
   * 更新音频配置
   */
  async updateAudioConfig(audioConfig: Partial<AudioDeviceSettings>): Promise<void> {
    this.config.audio = { ...this.config.audio, ...audioConfig };
    await this.saveConfig();
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
   * 获取电台(Hamlib)配置
   */
  getRadioConfig(): HamlibConfig {
    return { ...this.config.radio } as HamlibConfig;
  }

  /**
   * 更新电台(Hamlib)配置
   */
  async updateRadioConfig(radioConfig: Partial<HamlibConfig>): Promise<void> {
    this.config.radio = { ...this.config.radio, ...radioConfig } as HamlibConfig;
    await this.saveConfig();
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
      throw new Error(`操作员 ${id} 不存在`);
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
      throw new Error(`操作员 ${id} 不存在`);
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
      errors.push('呼号不能为空');
    }

    if (!this.config.ft8.myGrid) {
      errors.push('网格定位不能为空');
    }

    if (this.config.ft8.frequency <= 0) {
      errors.push('频率必须大于0');
    }

    if (this.config.ft8.transmitPower <= 0 || this.config.ft8.transmitPower > 100) {
      errors.push('发射功率必须在1-100之间');
    }

    // 验证操作员配置
    this.config.operators.forEach((operator, index) => {
      if (!operator.myCallsign) {
        errors.push(`操作员 ${index + 1}: 呼号不能为空`);
      }
      if (operator.frequency < 200 || operator.frequency > 4000) {
        errors.push(`操作员 ${index + 1}: 频率必须在200-4000Hz之间`);
      }
      if (!operator.transmitCycles || operator.transmitCycles.length === 0) {
        errors.push(`操作员 ${index + 1}: 发射周期不能为空`);
      }
    });

    // 检查操作员ID唯一性
    const operatorIds = this.config.operators.map(op => op.id);
    const duplicateIds = operatorIds.filter((id, index) => operatorIds.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      errors.push(`操作员ID重复: ${duplicateIds.join(', ')}`);
    }

    // 验证服务器配置
    if (this.config.server.port <= 0 || this.config.server.port > 65535) {
      errors.push('端口号必须在1-65535之间');
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
   * 获取WaveLog配置
   */
  getWaveLogConfig(): WaveLogConfig {
    return { ...this.config.wavelog };
  }

  /**
   * 更新WaveLog配置
   */
  async updateWaveLogConfig(waveLogConfig: Partial<WaveLogConfig>): Promise<void> {
    this.config.wavelog = { ...this.config.wavelog, ...waveLogConfig };
    await this.saveConfig();
  }

  /**
   * 重置WaveLog配置为默认值
   */
  async resetWaveLogConfig(): Promise<void> {
    this.config.wavelog = { ...DEFAULT_CONFIG.wavelog };
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
    console.log(`💾 [配置管理器] 已保存最后选择的频率: ${frequencyConfig.description || frequencyConfig.frequency}Hz`);
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
    console.log(`💾 [配置管理器] 已保存最后设置的音量增益: ${gainDb.toFixed(1)}dB (${gain.toFixed(3)})`);
  }

  /**
   * 清除最后设置的音量增益
   */
  async clearLastVolumeGain(): Promise<void> {
    this.config.lastVolumeGain = null;
    await this.saveConfig();
  }
} 