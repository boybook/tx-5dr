import { RingBufferAudioProvider } from './AudioBufferProvider.js';
import { EventEmitter } from 'eventemitter3';
export interface AudioStreamEvents {
    'audioData': (samples: Float32Array) => void;
    'error': (error: Error) => void;
    'started': () => void;
    'stopped': () => void;
}
/**
 * 音频流管理器 - 负责从音频设备捕获实时音频数据
 * 简化版本：只进行基本的数据验证和转换
 */
export declare class AudioStreamManager extends EventEmitter<AudioStreamEvents> {
    private audioInput;
    private isStreaming;
    private audioProvider;
    private deviceId;
    private sampleRate;
    private channels;
    constructor();
    /**
     * 启动音频流
     */
    startStream(deviceId?: string): Promise<void>;
    /**
     * 停止音频流
     */
    stopStream(): Promise<void>;
    /**
     * 获取音频缓冲区提供者
     */
    getAudioProvider(): RingBufferAudioProvider;
    /**
     * 获取当前采样率
     */
    getCurrentSampleRate(): number;
    /**
     * 获取流状态
     */
    getStatus(): {
        isStreaming: boolean;
        deviceId: string | null;
        sampleRate: number;
        channels: number;
        bufferStatus: {
            startTime: number;
            uptime: number;
            sampleRate: number;
            size: number;
            writeIndex: number;
            readIndex: number;
            availableSamples: number;
            maxDurationMs: number;
            startTimestamp: number;
            totalSamplesWritten: number;
            uptimeMs: number;
        };
    };
    /**
     * 将 Buffer 转换为 Float32Array
     */
    private convertBufferToFloat32;
    /**
     * 清空音频缓冲区
     */
    clearBuffer(): void;
}
//# sourceMappingURL=AudioStreamManager.d.ts.map