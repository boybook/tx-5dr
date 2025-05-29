import type { AudioBufferProvider } from '@tx5dr/core';
/**
 * 基于环形缓冲区的音频缓冲区提供者实现
 */
export declare class RingBufferAudioProvider implements AudioBufferProvider {
    private ringBuffer;
    private startTime;
    private sampleRate;
    constructor(sampleRate?: number, maxDurationMs?: number);
    /**
     * 获取当前采样率
     */
    getSampleRate(): number;
    /**
     * 获取指定时间范围的音频数据
     */
    getBuffer(startMs: number, durationMs: number): Promise<ArrayBuffer>;
    /**
     * 写入音频数据到缓冲区
     */
    writeAudio(samples: Float32Array): void;
    /**
     * 获取缓冲区状态
     */
    getStatus(): {
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
    /**
     * 清空缓冲区
     */
    clear(): void;
}
//# sourceMappingURL=AudioBufferProvider.d.ts.map