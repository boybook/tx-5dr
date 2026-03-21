/**
 * 音频监听节点的统一接口与 ScriptProcessorNode 回退实现
 *
 * AudioWorklet 需要 Secure Context（HTTPS/localhost），通过局域网 IP 以 HTTP 访问时不可用。
 * 此模块提供 ScriptProcessorNode 回退方案，复刻 audio-monitor-worklet.js 的环形缓冲区逻辑。
 */

export interface MonitorStatsData {
  latencyMs: number;
  bufferFillPercent: number;
  isActive: boolean;
  audioLevel: number;
  droppedSamples: number;
  availableSamples: number;
  sampleRate: number;
}

/**
 * 统一的音频监听节点接口，屏蔽 AudioWorklet / ScriptProcessorNode 差异
 */
export interface AudioMonitorNode {
  /** 写入音频数据到环形缓冲区 */
  postAudioData(buffer: ArrayBuffer, sampleRate: number, clientTimestamp: number): void;
  /** 获取底层 AudioNode，用于连接 gain 节点 */
  getOutputNode(): AudioNode;
  /** 设置统计信息回调 */
  onStats(callback: (stats: MonitorStatsData) => void): void;
  /** 释放资源 */
  dispose(): void;
}

/**
 * 将 AudioWorkletNode 包装为统一接口
 */
export function createWorkletMonitorNode(workletNode: AudioWorkletNode): AudioMonitorNode {
  let statsCallback: ((stats: MonitorStatsData) => void) | null = null;

  workletNode.port.onmessage = (e) => {
    if (e.data.type === 'stats' && statsCallback) {
      statsCallback(e.data.data);
    }
  };

  return {
    postAudioData(buffer: ArrayBuffer, sampleRate: number, clientTimestamp: number) {
      workletNode.port.postMessage(
        { type: 'audioData', buffer, sampleRate, clientTimestamp },
        [buffer]
      );
    },
    getOutputNode() {
      return workletNode;
    },
    onStats(callback) {
      statsCallback = callback;
    },
    dispose() {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    },
  };
}

/**
 * ScriptProcessorNode 回退实现，复刻 audio-monitor-worklet.js 的环形缓冲区逻辑
 */
export class ScriptProcessorFallbackNode implements AudioMonitorNode {
  private scriptNode: ScriptProcessorNode;
  private statsCallback: ((stats: MonitorStatsData) => void) | null = null;

  // 环形缓冲区（与 worklet 一致：1 秒缓冲）
  private ringBufferSize = 48000;
  private ringBuffer = new Float32Array(this.ringBufferSize);
  private writeIndex = 0;
  private readIndex = 0;
  private availableSamples = 0;

  // 采样率
  private currentSampleRate = 48000;

  // 统计
  private totalDroppedSamples = 0;
  private audioLevel = 0;
  private lastStatsTime = 0;
  private underrunCount = 0;
  private consecutiveUnderrunFrames = 0;

  // 播放控制（与 worklet 一致）
  private isPlaying = false;
  private readonly PREFILL_MS = 80;

  constructor(audioContext: AudioContext) {
    // bufferSize=4096: ~85ms @48kHz，减少主线程回调频率
    this.scriptNode = audioContext.createScriptProcessor(4096, 0, 1);
    this.scriptNode.onaudioprocess = (e) => this.process(e);
  }

  postAudioData(buffer: ArrayBuffer, sampleRate: number, _clientTimestamp: number): void {
    // 更新采样率
    if (sampleRate && sampleRate !== this.currentSampleRate) {
      this.currentSampleRate = sampleRate;
    }

    const audioData = new Float32Array(buffer);
    const samples = audioData.length;

    // 缓冲区溢出时丢弃最旧数据
    const freeSpace = this.ringBufferSize - this.availableSamples;
    if (samples > freeSpace) {
      const dropCount = samples - freeSpace;
      this.totalDroppedSamples += dropCount;
      this.readIndex = (this.readIndex + dropCount) % this.ringBufferSize;
      this.availableSamples -= dropCount;
    }

    // 写入环形缓冲区
    for (let i = 0; i < samples; i++) {
      this.ringBuffer[this.writeIndex] = audioData[i];
      this.writeIndex = (this.writeIndex + 1) % this.ringBufferSize;
    }

    this.availableSamples = Math.min(this.availableSamples + samples, this.ringBufferSize);
  }

  getOutputNode(): AudioNode {
    return this.scriptNode;
  }

  onStats(callback: (stats: MonitorStatsData) => void): void {
    this.statsCallback = callback;
  }

  dispose(): void {
    this.scriptNode.onaudioprocess = null;
    this.scriptNode.disconnect();
    this.statsCallback = null;
  }

  private process(e: AudioProcessingEvent): void {
    const output = e.outputBuffer.getChannelData(0);
    this.readAudioData(output);
    this.sendStats(e.playbackTime);
  }

  private readAudioData(output: Float32Array): void {
    const samples = output.length;
    const bufferMs = this.availableSamples / (this.currentSampleRate / 1000);

    // 预填充检查
    if (!this.isPlaying) {
      if (bufferMs >= this.PREFILL_MS) {
        this.isPlaying = true;
        this.consecutiveUnderrunFrames = 0;
      } else {
        output.fill(0);
        return;
      }
    }

    // 正常播放
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
        // 平滑衰减，避免爆音
        output[i] = lastValidSample * 0.9;
        lastValidSample *= 0.9;
        hadUnderrun = true;
      }
    }

    if (hadUnderrun) {
      this.underrunCount++;
      this.consecutiveUnderrunFrames++;
      if (this.consecutiveUnderrunFrames > 10) {
        this.isPlaying = false;
        this.consecutiveUnderrunFrames = 0;
      }
    } else {
      this.consecutiveUnderrunFrames = 0;
    }

    if (samples > 0) {
      this.audioLevel = Math.sqrt(totalSquare / samples);
    }
  }

  private sendStats(playbackTime: number): void {
    if (playbackTime - this.lastStatsTime < 1.0) return;
    this.lastStatsTime = playbackTime;

    if (!this.statsCallback) return;

    this.statsCallback({
      latencyMs: this.availableSamples / (this.currentSampleRate / 1000),
      bufferFillPercent: (this.availableSamples / this.ringBufferSize) * 100,
      isActive: this.audioLevel > 0.001,
      audioLevel: this.audioLevel,
      droppedSamples: this.totalDroppedSamples,
      availableSamples: this.availableSamples,
      sampleRate: this.currentSampleRate,
    });
  }
}
