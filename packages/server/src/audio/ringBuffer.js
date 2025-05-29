/**
 * 环形缓冲区 - 用于存储连续的 PCM 音频数据
 * 支持多线程安全的读写操作
 */
export class RingBuffer {
    constructor(sampleRate, maxDurationMs = 60000) {
        this.writeIndex = 0;
        this.readIndex = 0;
        this.totalSamplesWritten = 0; // 总写入样本数
        this.sampleRate = sampleRate;
        this.maxDurationMs = maxDurationMs;
        this.size = Math.floor((sampleRate * maxDurationMs) / 1000);
        this.buffer = new Float32Array(this.size);
        this.startTimestamp = Date.now();
        this.lastWriteTimestamp = this.startTimestamp;
    }
    /**
     * 写入音频数据
     * @param samples PCM 样本数据
     */
    write(samples) {
        const writeTimestamp = Date.now();
        // 音频质量检查
        let validSamples = 0;
        let clippedSamples = 0;
        let maxLevel = 0;
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i] || 0;
            // 检查样本有效性
            if (isNaN(sample) || !isFinite(sample)) {
                // 无效样本，用0替换
                this.buffer[this.writeIndex] = 0;
            }
            else {
                // 限制样本范围到 [-1, 1]
                const clampedSample = Math.max(-1, Math.min(1, sample));
                this.buffer[this.writeIndex] = clampedSample;
                validSamples++;
                const absLevel = Math.abs(clampedSample);
                if (absLevel > maxLevel)
                    maxLevel = absLevel;
                if (absLevel >= 0.99)
                    clippedSamples++;
            }
            this.writeIndex = (this.writeIndex + 1) % this.size;
            this.totalSamplesWritten++;
            // 如果写入追上了读取，移动读取指针
            if (this.writeIndex === this.readIndex) {
                this.readIndex = (this.readIndex + 1) % this.size;
            }
        }
        // 音频质量日志（每1000次写入记录一次）
        if (this.totalSamplesWritten % (this.sampleRate * 10) === 0) { // 每10秒记录一次
            const validPercent = (validSamples / samples.length * 100).toFixed(1);
            const clippedPercent = (clippedSamples / samples.length * 100).toFixed(1);
            console.log(`🎵 [RingBuffer] 音频质量: 有效=${validPercent}%, 爆音=${clippedPercent}%, 峰值=${maxLevel.toFixed(3)}`);
        }
        // 更新最后写入时间（用于计算时间偏移）
        this.lastWriteTimestamp = writeTimestamp;
    }
    /**
     * 读取指定时间范围的音频数据
     * @param startMs 开始时间戳（毫秒）
     * @param durationMs 持续时间（毫秒）
     * @returns PCM 音频数据
     */
    read(startMs, durationMs) {
        const sampleCount = Math.floor((this.sampleRate * durationMs) / 1000);
        const result = new Float32Array(sampleCount);
        // 计算从当前写入位置向前回溯的样本数
        // 对于多窗口解码，我们需要从最新数据开始向前读取指定时长的数据
        const startSample = Math.max(0, this.writeIndex - sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            const bufferIndex = (startSample + i) % this.size;
            const value = this.buffer[bufferIndex];
            result[i] = (value !== undefined && !isNaN(value)) ? value : 0;
        }
        return result.buffer;
    }
    /**
     * 基于时隙开始时间读取累积音频数据
     * @param slotStartMs 时隙开始时间戳（毫秒）
     * @param durationMs 从时隙开始到现在的累积时长（毫秒）
     * @returns PCM 音频数据
     */
    readFromSlotStart(slotStartMs, durationMs) {
        const sampleCount = Math.floor((this.sampleRate * durationMs) / 1000);
        const result = new Float32Array(sampleCount);
        // 计算当前时间相对于缓冲区开始的总样本数
        const currentTime = Date.now();
        const totalTimeMs = currentTime - this.startTimestamp;
        const totalSamplesFromStart = Math.floor((this.sampleRate * totalTimeMs) / 1000);
        // 计算要读取的数据在缓冲区中的结束位置（最新数据位置）
        const endSample = Math.min(totalSamplesFromStart, this.totalSamplesWritten);
        // 计算起始位置（向前回溯 sampleCount 个样本）
        const startSample = Math.max(0, endSample - sampleCount);
        // console.log(`🔍 [RingBuffer] 时间计算: 时隙开始=${new Date(slotStartMs).toISOString()}, 请求时长=${durationMs}ms, 样本数=${sampleCount}`);
        // console.log(`🔍 [RingBuffer] 位置计算: 总样本=${totalSamplesFromStart}, 已写入=${this.totalSamplesWritten}, 起始=${startSample}, 结束=${endSample}`);
        // 从环形缓冲区读取数据
        for (let i = 0; i < sampleCount; i++) {
            const sampleIndex = startSample + i;
            const bufferIndex = sampleIndex % this.size;
            const value = this.buffer[bufferIndex];
            result[i] = (value !== undefined && !isNaN(value)) ? value : 0;
        }
        return result.buffer;
    }
    /**
     * 获取当前可用的样本数量
     */
    getAvailableSamples() {
        if (this.writeIndex >= this.readIndex) {
            return this.writeIndex - this.readIndex;
        }
        else {
            return this.size - this.readIndex + this.writeIndex;
        }
    }
    /**
     * 清空缓冲区
     */
    clear() {
        this.writeIndex = 0;
        this.readIndex = 0;
        this.buffer.fill(0);
    }
    /**
     * 获取缓冲区状态信息
     */
    getStatus() {
        return {
            size: this.size,
            writeIndex: this.writeIndex,
            readIndex: this.readIndex,
            availableSamples: this.getAvailableSamples(),
            sampleRate: this.sampleRate,
            maxDurationMs: this.maxDurationMs,
            startTimestamp: this.startTimestamp,
            totalSamplesWritten: this.totalSamplesWritten,
            uptimeMs: Date.now() - this.startTimestamp
        };
    }
}
//# sourceMappingURL=ringBuffer.js.map