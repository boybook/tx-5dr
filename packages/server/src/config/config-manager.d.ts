import { AudioDeviceSettings } from '@tx5dr/contracts';
export interface AppConfig {
    audio: AudioDeviceSettings;
    ft8: {
        myCallsign: string;
        myGrid: string;
        frequency: number;
        transmitPower: number;
        autoReply: boolean;
        maxQSOTimeout: number;
    };
    server: {
        port: number;
        host: string;
    };
}
export interface AudioConfig {
    inputDeviceId?: string;
    outputDeviceId?: string;
    sampleRate: number;
    bufferSize: number;
}
export declare class ConfigManager {
    private static instance;
    private config;
    private configPath;
    private constructor();
    static getInstance(): ConfigManager;
    /**
     * 初始化配置管理器
     */
    initialize(): Promise<void>;
    /**
     * 加载配置文件
     */
    private loadConfig;
    /**
     * 保存配置文件
     */
    private saveConfig;
    /**
     * 深度合并配置对象
     */
    private mergeConfig;
    /**
     * 获取完整配置
     */
    getConfig(): AppConfig;
    /**
     * 获取音频配置
     */
    getAudioConfig(): AudioDeviceSettings;
    /**
     * 更新音频配置
     */
    updateAudioConfig(audioConfig: Partial<AudioDeviceSettings>): Promise<void>;
    /**
     * 获取FT8配置
     */
    getFT8Config(): {
        myCallsign: string;
        myGrid: string;
        frequency: number;
        transmitPower: number;
        autoReply: boolean;
        maxQSOTimeout: number;
    };
    /**
     * 更新FT8配置
     */
    updateFT8Config(ft8Config: Partial<AppConfig['ft8']>): Promise<void>;
    /**
     * 获取服务器配置
     */
    getServerConfig(): {
        port: number;
        host: string;
    };
    /**
     * 更新服务器配置
     */
    updateServerConfig(serverConfig: Partial<AppConfig['server']>): Promise<void>;
    /**
     * 重置配置为默认值
     */
    resetConfig(): Promise<void>;
    /**
     * 验证配置的有效性
     */
    validateConfig(): {
        isValid: boolean;
        errors: string[];
    };
    /**
     * 获取配置文件路径
     */
    getConfigPath(): string;
    /**
     * 设置配置文件路径
     */
    setConfigPath(path: string): void;
}
//# sourceMappingURL=config-manager.d.ts.map