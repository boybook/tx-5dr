export declare function getLibSampleRate(): Promise<any>;
/**
 * 保存音频数据为 WAV 文件
 * @param audioData Float32Array 音频数据
 * @param filename 文件名（不包含扩展名）
 * @param outputDir 输出目录路径
 * @param sampleRate 采样率，默认 12000Hz
 * @returns Promise<string> 返回保存的文件路径
 */
export declare function saveAudioToWav(audioData: Float32Array, filename: string, outputDir: string, sampleRate?: number): Promise<string>;
/**
 * 生成带时间戳的音频文件名
 * @param slotId 时隙ID
 * @param windowIdx 窗口索引
 * @param prefix 文件名前缀，默认为空
 * @returns 生成的文件名（不包含扩展名）
 */
export declare function generateAudioFilename(slotId: string, windowIdx: number, prefix?: string): string;
/**
 * 音频音量标准化
 * 将音频数据的振幅标准化，使最大振幅达到 ±1
 * @param samples 输入音频样本
 * @param targetPeak 目标峰值，默认 0.95（留一点余量避免削波）
 * @param minGain 最小增益，避免过度放大噪声，默认 0.1
 * @param maxGain 最大增益，避免过度放大，默认 10.0
 * @returns 标准化后的音频数据
 */
export declare function normalizeAudioVolume(samples: Float32Array, targetPeak?: number, minGain?: number, maxGain?: number): Float32Array;
/**
 * 音频质量分析（增强版）
 * @param samples 音频样本
 * @param sampleRate 采样率
 * @returns 详细的音频质量分析结果
 */
export declare function analyzeAudioQualityDetailed(samples: Float32Array, sampleRate?: number): {
    validSamples: number;
    invalidSamples: number;
    clippedSamples: number;
    peakLevel: number;
    rmsLevel: number;
    dcOffset: number;
    dynamicRange: number;
    snrEstimate: number;
    durationSeconds: number;
};
/**
 * 创建音频输出目录
 * @param baseDir 基础目录
 * @param subDir 子目录名称，默认为 'audio_captures'
 * @returns 创建的目录路径
 */
export declare function createAudioOutputDir(baseDir?: string, subDir?: string): string;
/**
 * 清理旧的音频文件
 * @param outputDir 输出目录
 * @param maxAgeMs 最大文件年龄（毫秒），默认24小时
 * @returns 清理的文件数量
 */
export declare function cleanupOldAudioFiles(outputDir: string, maxAgeMs?: number): number;
/**
 * 使用 libsamplerate 进行高质量重采样
 * @param samples 输入音频样本
 * @param inputSampleRate 输入采样率
 * @param outputSampleRate 输出采样率
 * @param channels 声道数，默认 1
 * @param quality 重采样质量，默认最高质量
 * @returns 重采样后的音频数据
 */
export declare function resampleAudioProfessional(samples: Float32Array, inputSampleRate: number, outputSampleRate: number, channels?: number, quality?: number): Promise<Float32Array>;
/**
 * 专门用于 FT8/FT4 的重采样函数（48kHz -> 12kHz）
 * @param samples 输入音频样本（48kHz）
 * @param quality 重采样质量，默认中等质量（平衡性能和质量）
 * @returns 重采样后的音频数据（12kHz）
 */
export declare function resampleTo12kHz(samples: Float32Array, quality?: number): Promise<Float32Array>;
/**
 * 清理重采样器缓存
 */
export declare function clearResamplerCache(): void;
/**
 * 批量重采样函数，支持多种目标采样率
 * @param samples 输入音频样本
 * @param inputSampleRate 输入采样率
 * @param targetRates 目标采样率数组
 * @returns 重采样结果的映射
 */
export declare function batchResample(samples: Float32Array, inputSampleRate: number, targetRates: number[]): Promise<Map<number, Float32Array>>;
//# sourceMappingURL=audioUtils.d.ts.map