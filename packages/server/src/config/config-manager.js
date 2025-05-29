import { promises as fs } from 'fs';
import { join } from 'path';
// 默认配置
const DEFAULT_CONFIG = {
    audio: {
        inputDeviceId: undefined,
        outputDeviceId: undefined,
        sampleRate: 48000,
        bufferSize: 1024
    },
    ft8: {
        myCallsign: '',
        myGrid: '',
        frequency: 14074000, // 20m FT8频率
        transmitPower: 25,
        autoReply: false,
        maxQSOTimeout: 6, // 6个周期 = 90秒
    },
    server: {
        port: 3000,
        host: '0.0.0.0',
    },
};
// 配置管理器
export class ConfigManager {
    constructor() {
        this.config = { ...DEFAULT_CONFIG };
        this.configPath = join(process.cwd(), 'config.json');
    }
    static getInstance() {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }
    /**
     * 初始化配置管理器
     */
    async initialize() {
        try {
            await this.loadConfig();
            console.log('配置文件加载成功');
        }
        catch (error) {
            console.log('配置文件不存在或格式错误，使用默认配置');
            await this.saveConfig();
        }
    }
    /**
     * 加载配置文件
     */
    async loadConfig() {
        const configData = await fs.readFile(this.configPath, 'utf-8');
        const parsedConfig = JSON.parse(configData);
        // 合并默认配置和加载的配置
        this.config = this.mergeConfig(DEFAULT_CONFIG, parsedConfig);
    }
    /**
     * 保存配置文件
     */
    async saveConfig() {
        const configData = JSON.stringify(this.config, null, 2);
        await fs.writeFile(this.configPath, configData, 'utf-8');
    }
    /**
     * 深度合并配置对象
     */
    mergeConfig(defaultConfig, userConfig) {
        const result = { ...defaultConfig };
        for (const key in userConfig) {
            if (userConfig[key] !== null && typeof userConfig[key] === 'object' && !Array.isArray(userConfig[key])) {
                result[key] = this.mergeConfig(defaultConfig[key] || {}, userConfig[key]);
            }
            else {
                result[key] = userConfig[key];
            }
        }
        return result;
    }
    /**
     * 获取完整配置
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * 获取音频配置
     */
    getAudioConfig() {
        return { ...this.config.audio };
    }
    /**
     * 更新音频配置
     */
    async updateAudioConfig(audioConfig) {
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
    async updateFT8Config(ft8Config) {
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
    async updateServerConfig(serverConfig) {
        this.config.server = { ...this.config.server, ...serverConfig };
        await this.saveConfig();
    }
    /**
     * 重置配置为默认值
     */
    async resetConfig() {
        this.config = { ...DEFAULT_CONFIG };
        await this.saveConfig();
    }
    /**
     * 验证配置的有效性
     */
    validateConfig() {
        const errors = [];
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
    getConfigPath() {
        return this.configPath;
    }
    /**
     * 设置配置文件路径
     */
    setConfigPath(path) {
        this.configPath = path;
    }
}
//# sourceMappingURL=config-manager.js.map