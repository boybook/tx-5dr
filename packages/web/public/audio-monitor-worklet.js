/**
 * 音频监听AudioWorklet处理器
 * 负责在独立的音频线程中处理从服务器接收的音频数据
 *
 * 架构：
 * - 环形缓冲区：存储从WebSocket接收的音频数据
 * - 播放逻辑：从环形缓冲区读取数据并输出到扬声器
 * - 状态统计：计算延迟、缓冲区填充率、音频活动等
 */

class AudioMonitorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 环形缓冲区配置（1秒缓冲）
    this.ringBufferSize = 48000; // 假设最大采样率48kHz
    this.ringBuffer = new Float32Array(this.ringBufferSize);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.availableSamples = 0;

    // 采样率（动态更新）
    this.currentSampleRate = 48000; // 默认值，会在接收数据时更新

    // 统计信息
    this.lastStatsTime = 0;
    this.statsIntervalMs = 1000; // 每秒发送一次统计信息
    this.totalDroppedSamples = 0;
    this.audioLevel = 0;

    // 调试：缓冲区状态监控
    this.underrunCount = 0; // 欠载（缓冲区空）次数
    this.overflowCount = 0; // 溢出次数
    this.frameCount = 0; // 帧计数器
    this.consecutiveUnderrunFrames = 0; // 连续欠载帧计数

    // 播放状态控制
    this.isPlaying = false;
    this.PREFILL_MS = 80;       // 预填充目标：80ms（约4个20ms包）
    this.MIN_BUFFER_MS = 30;    // 低水位阈值：30ms（仅用于日志）
    this.prefillComplete = false;

    // 接收来自主线程的消息
    this.port.onmessage = (e) => {
      if (e.data.type === 'audioData') {
        this.writeAudioData(e.data.buffer, e.data.sampleRate, e.data.clientTimestamp);
      } else if (e.data.type === 'reset') {
        this.reset();
      }
    };
  }

  /**
   * 写入音频数据到环形缓冲区
   */
  writeAudioData(buffer, sampleRate, clientTimestamp) {
    const t_worklet_receive = currentTime * 1000; // AudioContext时间（秒转毫秒）

    // 更新当前采样率
    if (sampleRate && sampleRate !== this.currentSampleRate) {
      console.log(`[AudioWorklet] 采样率更新: ${this.currentSampleRate} → ${sampleRate} Hz`);
      this.currentSampleRate = sampleRate;
    }

    const audioData = new Float32Array(buffer);
    const samples = audioData.length;

    // 每秒输出一次简化日志
    this.frameCount++;
    if (this.frameCount % 20 === 0) {
      const bufferMs = (this.availableSamples / (this.currentSampleRate / 1000)).toFixed(1);
      console.log(
        `🎧 [Worklet] 缓冲区=${bufferMs}ms (${this.availableSamples}样本), ` +
        `播放=${this.isPlaying ? '▶️' : '⏸️'}, ` +
        `欠载=${this.underrunCount}`
      );
    }

    // 检查缓冲区是否有足够空间
    const freeSpace = this.ringBufferSize - this.availableSamples;
    if (samples > freeSpace) {
      // 缓冲区溢出，丢弃最旧的数据
      const dropCount = samples - freeSpace;
      this.totalDroppedSamples += dropCount;
      this.overflowCount++;
      this.readIndex = (this.readIndex + dropCount) % this.ringBufferSize;
      this.availableSamples -= dropCount;
    }

    // 写入数据
    for (let i = 0; i < samples; i++) {
      this.ringBuffer[this.writeIndex] = audioData[i];
      this.writeIndex = (this.writeIndex + 1) % this.ringBufferSize;
    }

    this.availableSamples = Math.min(
      this.availableSamples + samples,
      this.ringBufferSize
    );
  }

  /**
   * 从环形缓冲区读取音频数据
   */
  readAudioData(output) {
    const samples = output.length;
    const bufferMs = this.availableSamples / (this.currentSampleRate / 1000);

    // 预填充检查
    if (!this.isPlaying) {
      if (bufferMs >= this.PREFILL_MS) {
        this.isPlaying = true;
        this.prefillComplete = true;
        this.consecutiveUnderrunFrames = 0;
        console.log(`▶️ [Worklet] 预填充完成 (${bufferMs.toFixed(1)}ms)，开始播放`);
      } else {
        // 继续静音，等待预填充
        for (let i = 0; i < samples; i++) {
          output[i] = 0;
        }
        return;
      }
    }

    // 正常播放 — 不再有低水位硬暂停，缓冲区有数据就读，没数据用衰减填充
    let totalSquare = 0;
    let hadUnderrun = false;
    let lastValidSample = 0;

    for (let i = 0; i < samples; i++) {
      if (this.availableSamples > 0) {
        const sample = this.ringBuffer[this.readIndex];
        output[i] = sample;
        lastValidSample = sample;
        totalSquare += sample * sample;
        this.readIndex = (this.readIndex + 1) % this.ringBufferSize;
        this.availableSamples--;
      } else {
        // 平滑衰减，避免波形突变导致爆音
        output[i] = lastValidSample * 0.9;
        lastValidSample *= 0.9;
        hadUnderrun = true;
      }
    }

    if (hadUnderrun) {
      this.underrunCount++;
      this.consecutiveUnderrunFrames++;
      // 极端保护：连续欠载超过10帧（~27ms），暂停等待预填充
      if (this.consecutiveUnderrunFrames > 10) {
        this.isPlaying = false;
        this.consecutiveUnderrunFrames = 0;
        console.warn(`⏸️ [Worklet] 连续欠载，暂停等待预填充`);
      }
    } else {
      this.consecutiveUnderrunFrames = 0;
    }

    if (samples > 0) {
      this.audioLevel = Math.sqrt(totalSquare / samples);
    }
  }

  /**
   * 计算并发送统计信息
   */
  sendStats(currentTime) {
    if (currentTime - this.lastStatsTime >= this.statsIntervalMs / 1000) {
      const bufferFillPercent = (this.availableSamples / this.ringBufferSize) * 100;
      const isActive = this.audioLevel > 0.001; // 音频活动阈值

      // 估算延迟（基于缓冲区填充量和当前采样率）
      const latencyMs = (this.availableSamples / (this.currentSampleRate / 1000));

      this.port.postMessage({
        type: 'stats',
        data: {
          latencyMs,
          bufferFillPercent,
          isActive,
          audioLevel: this.audioLevel,
          droppedSamples: this.totalDroppedSamples,
          availableSamples: this.availableSamples,
          sampleRate: this.currentSampleRate, // 包含当前采样率信息
        }
      });

      this.lastStatsTime = currentTime;
    }
  }

  /**
   * 重置缓冲区
   */
  reset() {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.availableSamples = 0;
    this.totalDroppedSamples = 0;
    this.audioLevel = 0;
  }

  /**
   * 音频处理主循环（在音频线程中调用）
   */
  process(inputs, outputs, parameters) {
    const output = outputs[0];

    if (output.length > 0) {
      const channelData = output[0]; // 单声道
      this.readAudioData(channelData);
    }

    // 发送统计信息
    this.sendStats(currentTime);

    // 保持处理器运行
    return true;
  }
}

// 注册处理器
registerProcessor('audio-monitor-processor', AudioMonitorProcessor);
