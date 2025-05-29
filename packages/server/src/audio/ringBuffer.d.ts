/**
 * 环形缓冲区 - 用于存储连续的 PCM 音频数据
 * 支持多线程安全的读写操作
 */
export declare class RingBuffer {
    private buffer;
    private writeIndex;
    private readIndex;
    private size;
    private sampleRate;
    private maxDurationMs;
    private startTimestamp;
    private totalSamplesWritten;
    private lastWriteTimestamp;
    constructor(sampleRate: number, maxDurationMs?: number);
    /**
     * 写入音频数据
     * @param samples PCM 样本数据
     */
    write(samples: Float32Array): void;
    /**
     * 读取指定时间范围的音频数据
     * @param startMs 开始时间戳（毫秒）
     * @param durationMs 持续时间（毫秒）
     * @returns PCM 音频数据
     */
    read(startMs: number, durationMs: number): ArrayBuffer;
    /**
     * 基于时隙开始时间读取累积音频数据
     * @param slotStartMs 时隙开始时间戳（毫秒）
     * @param durationMs 从时隙开始到现在的累积时长（毫秒）
     * @returns PCM 音频数据
     */
    readFromSlotStart(slotStartMs: number, durationMs: number): ArrayBuffer;
    /**
     * 获取当前可用的样本数量
     */
    getAvailableSamples(): number;
    /**
     * 清空缓冲区
     */
    clear(): void;
    /**
     * 获取缓冲区状态信息
     */
    getStatus(): {
        size: number;
        writeIndex: number;
        readIndex: number;
        availableSamples: number;
        sampleRate: number;
        maxDurationMs: number;
        startTimestamp: number;
        totalSamplesWritten: number;
        uptimeMs: number;
    };
}
//# sourceMappingURL=ringBuffer.d.ts.map