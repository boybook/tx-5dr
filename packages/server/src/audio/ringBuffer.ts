import { createLogger } from '../utils/logger.js';

const logger = createLogger('RingBuffer');
const OVERFLOW_LOG_INTERVAL_MS = 5000;
/** 漂移日志阈值/节流（仅用于诊断，纠偏由时钟模型闭环完成） */
const CLOCK_DRIFT_WARNING_THRESHOLD_MS = 250;
const CLOCK_DRIFT_LOG_INTERVAL_MS = 5000;
const RESYNC_LOG_INTERVAL_MS = 5000;

/**
 * 采集时钟模型常量。
 * - OFFSET_GAIN / MAX_STEP_MS：漏积分纠偏。每次写入按误差的一小步纠正锚点，
 *   单次幅度被 MAX_STEP_MS 钳制，使抖动尖峰几乎不移动窗口，而缓慢漂移会被逐步吸收。
 * - RESYNC_THRESHOLD_MS：误差超过此值视为时间线断裂（停顿/丢包/NTP 跳变），
 *   直接重锚以立即重对齐，避免漏积分在大阶跃下收敛过慢导致长时间错位。
 */
const OFFSET_GAIN = 0.05;
const MAX_STEP_MS = 5;
const RESYNC_THRESHOLD_MS = 500;

/**
 * seq 丢包补偿常量（仅当写入携带线级序列号时生效，目前为 ICOM WLAN）。
 * - MAX_GAP_FILL_MS：单次 seq 跳变最多补这么多静音；超过则视为长停顿/失步，改走重锚而非灌满静音。
 * - DUP_WINDOW：seq 回退落在该窗口内视为重复/迟到乱序包，直接丢弃（不重排）。
 * - SEQ_MODULO：协议线级序列号为 16 位，0xffff 后回绕到 0。
 */
const MAX_GAP_FILL_MS = 1000;
const DUP_WINDOW = 256;
const SEQ_MODULO = 0x10000;
const LOSS_LOG_INTERVAL_MS = 5000;

export type AudioClock = () => number;

/** readByWallClock 的返回结构（pcm 仍为裸 ArrayBuffer，供解码 worker 直接使用） */
export interface WallClockReadResult {
  pcm: ArrayBuffer;
  /** 实际填入的真实采样占请求总量的比例（1=完全命中，0=全部零填充） */
  filledRatio: number;
  requestedSamples: number;
  presentSamples: number;
  /** 落在未来（尚未到达）而零填充的采样数 */
  futureSamples: number;
  /** 落在过去（已被环形缓冲逐出）而零填充的采样数 */
  evictedSamples: number;
  /** 请求窗口起点对应的绝对采样序号 */
  startSampleIndex: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 环形缓冲区 - 存储连续 PCM 音频，并维护“绝对采样序号 ↔ 挂钟采集时间”的权威映射。
 *
 * 核心思想：
 * - `totalSamplesWritten` 是永不回绕的绝对采样序号，是权威位置；物理上只保留最近 `size` 个。
 * - 一个平滑采集时钟模型把绝对采样序号映射到挂钟时间：
 *     wallTimeOf(index) = anchorWallMs + (index - anchorSampleIndex) / estimatedRate * 1000
 *   每次写入用 chunk 到达时间对锚点做漏积分纠偏（抗抖动），大误差时重锚（应对断裂）。
 * - 读取（readByWallClock）按挂钟时间换算到绝对采样区间并精确返回，缺失部分零填充。
 *   这使解码窗口的位置不受瞬时到达延迟影响，从架构上解决“整窗偏移导致 FT8 解不出”。
 *
 * 单线程使用（音频回调/事件在同一执行上下文），无需加锁。
 */
export class RingBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private readIndex = 0;
  private storedSamples = 0;
  private size: number;
  private sampleRate: number;
  private maxDurationMs: number;
  private totalSamplesWritten = 0; // 绝对采样序号（含写入的所有到达样本）

  // --- 平滑采集时钟模型 ---
  private anchorWallMs: number | null = null; // 绝对序号 anchorSampleIndex 对应的挂钟时间
  private anchorSampleIndex = 0;               // 固定为 0：映射以绝对序号 0 为基准
  private estimatedRate: number;               // 平滑有效采样率（速率环初期禁用，恒等于 sampleRate）
  private lastErrMs = 0;                        // 最近一次写入的模型误差（诊断用）
  private resyncCount = 0;                      // 重锚次数（诊断用）

  // --- seq 丢包检测（仅 ICOM 提供 seq 时启用）---
  private lastSeq: number | null = null;        // 上一个已接受的线级序列号
  private lostPackets = 0;                       // 累计判定丢失的包数（诊断用）
  private dupPackets = 0;                        // 累计丢弃的重复/乱序包数（诊断用）

  // --- 日志节流 ---
  private lastOverflowLogAt = 0;
  private suppressedOverflowSamples = 0;
  private lastClockDriftLogAt = 0;
  private lastResyncLogAt = 0;
  private lastLossLogAt = 0;

  private readonly now: AudioClock;

  constructor(sampleRate: number, maxDurationMs: number = 60000, now: AudioClock = Date.now) {
    this.sampleRate = sampleRate;
    this.maxDurationMs = maxDurationMs;
    this.now = now;
    this.estimatedRate = sampleRate;
    this.size = Math.floor((sampleRate * maxDurationMs) / 1000);
    this.buffer = new Float32Array(this.size);
  }

  /**
   * 写入音频数据。
   * @param samples PCM 样本
   * @param arrivalTimeMs 该 chunk 的到达挂钟时间（缺省取当前注入时钟）。用于驱动采集时钟模型。
   * @param seq 线级序列号（仅 ICOM 提供）。提供时用于精确丢包检测：seq 跳变补等量静音，
   *            重复/乱序丢弃，超大跳变改走重锚。不提供时退化为纯到达时间模型（声卡/openwebrx）。
   */
  write(samples: Float32Array, arrivalTimeMs: number = this.now(), seq?: number): void {
    const n = samples.length;
    if (n === 0) {
      return;
    }

    // seq 连续性处理：决定本包是丢弃、需要前置补静音、还是正常写入。
    let silenceSamples = 0;
    if (seq !== undefined) {
      const decision = this.evaluateSeq(seq, n);
      if (decision.action === 'drop') {
        this.dupPackets += 1;
        return; // 重复/迟到乱序包：不写、不推进时钟模型
      }
      if (decision.action === 'gap') {
        silenceSamples = decision.lostCount * n; // 每包样本数一致（ICOM 零重采样）
        this.lostPackets += decision.lostCount;
        this.logLossIfNeeded(decision.lostCount, seq, arrivalTimeMs);
      }
      this.lastSeq = seq;
    }

    // 把“补静音 + 本包”视为同一到达时刻的一次逻辑写入：projectedTotal 与（因丢包而前移的）
    // arrival 同步增长，errMs≈0，漏积分几乎不动；超大跳变（未补静音）则由模型走重锚。
    this.updateClockModel(silenceSamples + n, arrivalTimeMs);
    if (silenceSamples > 0) {
      this.writePhysical(new Float32Array(silenceSamples), arrivalTimeMs);
    }
    this.writePhysical(samples, arrivalTimeMs);
  }

  /**
   * 评估线级序列号的连续性（纯函数，不改状态）。
   * @returns ok=正常追加；drop=重复/乱序应丢弃；gap=丢了 lostCount 个包需前置补静音。
   */
  private evaluateSeq(seq: number, perPacketSamples: number): { action: 'ok' | 'drop' | 'gap'; lostCount: number } {
    if (this.lastSeq === null) {
      return { action: 'ok', lostCount: 0 }; // 首包
    }
    const delta = (seq - this.lastSeq + SEQ_MODULO) % SEQ_MODULO;
    if (delta === 1) {
      return { action: 'ok', lostCount: 0 };
    }
    if (delta === 0 || delta > SEQ_MODULO - DUP_WINDOW) {
      return { action: 'drop', lostCount: 0 }; // 同号或小幅回退：重复/迟到乱序
    }
    const lostCount = delta - 1;
    const gapMs = (lostCount * perPacketSamples * 1000) / this.sampleRate;
    if (gapMs > MAX_GAP_FILL_MS) {
      // 跳变过大（长停顿/seq 失步）：不灌大量静音，交给到达时间模型重锚
      return { action: 'ok', lostCount: 0 };
    }
    return { action: 'gap', lostCount };
  }

  private logLossIfNeeded(lostCount: number, seq: number, now: number): void {
    if (now - this.lastLossLogAt < LOSS_LOG_INTERVAL_MS) {
      return;
    }
    logger.warn('RX/input audio packet loss (gap filled with silence)', {
      bufferKind: 'rx-input',
      lostThisGap: lostCount,
      totalLostPackets: this.lostPackets,
      dupPackets: this.dupPackets,
      seq,
      sampleRate: this.sampleRate,
    });
    this.lastLossLogAt = now;
  }

  /**
   * 用本次到达的 chunk 更新采集时钟模型（漏积分纠偏 + 大误差重锚）。
   * 必须在物理写入推进 totalSamplesWritten 之前调用。
   */
  private updateClockModel(incomingSamples: number, arrivalTimeMs: number): void {
    if (this.anchorWallMs === null) {
      // 首次写入：chunk 到达时间对应其“末尾样本”的采集时刻（缓冲填满才回调），
      // 故绝对序号 0（首样本）对应 arrival - chunk时长。否则稳态下每次写入都会出现
      // +一个 chunk 的恒定误差，使漏积分持续误纠偏。
      this.anchorWallMs = arrivalTimeMs - (incomingSamples / this.estimatedRate) * 1000;
      this.anchorSampleIndex = 0;
      this.estimatedRate = this.sampleRate;
      this.lastErrMs = 0;
      return;
    }

    // predicted = 截至 arrivalTimeMs 按模型“应已采集”的绝对样本数
    const predicted = this.anchorSampleIndex
      + ((arrivalTimeMs - this.anchorWallMs) * this.estimatedRate) / 1000;
    // 写完本 chunk 后的绝对样本数（chunk 末尾样本对应 ~arrivalTimeMs）
    const projectedTotal = this.totalSamplesWritten + incomingSamples;
    const errSamples = projectedTotal - predicted;
    const errMs = (errSamples / this.estimatedRate) * 1000;
    this.lastErrMs = errMs;

    if (Math.abs(errMs) > RESYNC_THRESHOLD_MS) {
      // 时间线断裂（停顿/丢包/时钟跳变）：重锚使 chunk 末尾对齐到达时间，立即重对齐。
      this.anchorWallMs = arrivalTimeMs - (projectedTotal / this.estimatedRate) * 1000;
      this.anchorSampleIndex = 0;
      this.resyncCount += 1;
      this.logResyncIfNeeded(errMs, arrivalTimeMs);
      return;
    }

    // 漏积分：向“消除当前误差”的方向小步移动锚点，单步幅度受 MAX_STEP_MS 钳制（抗抖动）。
    // errMs>0 表示样本多于时间预期 → 需增大 predicted → 减小 anchorWallMs。
    const correctionMs = clamp(errMs * OFFSET_GAIN, -MAX_STEP_MS, MAX_STEP_MS);
    this.anchorWallMs -= correctionMs;
    this.logClockDriftIfNeeded(errMs, arrivalTimeMs);
  }

  /** 物理写入：维护环形缓冲与绝对计数，沿用“溢出丢弃最旧”策略。 */
  private writePhysical(samples: Float32Array, arrivalTimeMs: number): void {
    let inputOffset = 0;
    const freeSpace = this.size - this.storedSamples;

    if (samples.length >= this.size) {
      // 单次写入超过容量：只保留输入块最新尾部，清掉旧内容。
      const droppedSamples = this.storedSamples + samples.length - this.size;
      if (droppedSamples > 0) {
        this.logOverflow(droppedSamples, arrivalTimeMs);
      }
      inputOffset = samples.length - this.size;
      this.readIndex = this.writeIndex;
      this.storedSamples = 0;
    } else if (samples.length > freeSpace) {
      // 空间不足：丢弃最旧的已存样本，保持新样本实时。
      const needToDrop = samples.length - freeSpace;
      this.logOverflow(needToDrop, arrivalTimeMs);
      this.readIndex = (this.readIndex + needToDrop) % this.size;
      this.storedSamples = Math.max(0, this.storedSamples - needToDrop);
    }

    // inputOffset 部分虽未物理保留，但仍是已到达样本，须计入绝对时间线。
    this.totalSamplesWritten += inputOffset;
    for (let i = inputOffset; i < samples.length; i++) {
      const sample = samples[i] || 0;
      if (isNaN(sample) || !isFinite(sample)) {
        this.buffer[this.writeIndex] = 0;
      } else {
        this.buffer[this.writeIndex] = Math.max(-1, Math.min(1, sample));
      }
      this.writeIndex = (this.writeIndex + 1) % this.size;
      this.totalSamplesWritten += 1;
      this.storedSamples = Math.min(this.size, this.storedSamples + 1);
    }
  }

  private logOverflow(droppedSamples: number, now: number): void {
    this.suppressedOverflowSamples += droppedSamples;
    if (now - this.lastOverflowLogAt < OVERFLOW_LOG_INTERVAL_MS) {
      return;
    }
    // 满缓冲后每次写入都会淘汰等量最旧样本，这是 60s 滑动窗口的正常稳态（解码只用最近 ~15s，
    // 被淘汰的是更早的历史），不是数据丢失。降为 debug 避免误导性噪声；真正的问题由
    // 丢包(seq)/重锚/漂移等专用告警反映。
    logger.debug('RX/input ring buffer evicted oldest samples (sliding window full)', {
      bufferKind: 'rx-input',
      droppedSamples,
      suppressedDroppedSamples: this.suppressedOverflowSamples - droppedSamples,
      availableSamples: this.getAvailableSamples(),
      capacitySamples: this.size,
      sampleRate: this.sampleRate,
    });
    this.lastOverflowLogAt = now;
    this.suppressedOverflowSamples = 0;
  }

  private logClockDriftIfNeeded(errMs: number, now: number): void {
    if (Math.abs(errMs) < CLOCK_DRIFT_WARNING_THRESHOLD_MS) {
      return;
    }
    if (now - this.lastClockDriftLogAt < CLOCK_DRIFT_LOG_INTERVAL_MS) {
      return;
    }
    logger.warn('RX/input audio sample clock drift detected', {
      bufferKind: 'rx-input',
      modelErrMs: Number(errMs.toFixed(1)),
      totalSamplesWritten: this.totalSamplesWritten,
      availableSamples: this.getAvailableSamples(),
      sampleRate: this.sampleRate,
    });
    this.lastClockDriftLogAt = now;
  }

  private logResyncIfNeeded(errMs: number, now: number): void {
    if (now - this.lastResyncLogAt < RESYNC_LOG_INTERVAL_MS) {
      return;
    }
    logger.warn('RX/input audio timeline resynced (gap/stall/clock-step)', {
      bufferKind: 'rx-input',
      modelErrMs: Number(errMs.toFixed(1)),
      resyncCount: this.resyncCount,
      totalSamplesWritten: this.totalSamplesWritten,
      sampleRate: this.sampleRate,
    });
    this.lastResyncLogAt = now;
  }

  /** 挂钟时间 → 绝对采样序号（采集时钟模型的核心映射）。 */
  private sampleIndexAtWall(wallMs: number): number {
    if (this.anchorWallMs === null) {
      return 0;
    }
    return this.anchorSampleIndex + ((wallMs - this.anchorWallMs) * this.estimatedRate) / 1000;
  }

  /** 绝对采样序号 → 物理槽位（仅对处于保留区间内的序号有效）。 */
  private physicalIndex(absIndex: number): number {
    const offsetFromWrite = this.totalSamplesWritten - absIndex;
    return ((this.writeIndex - offsetFromWrite) % this.size + this.size) % this.size;
  }

  /**
   * 按挂钟时间窗口读取音频。已到达的样本放到窗口内正确相对位置，
   * 落在未来（未到达）或过去（已逐出）的部分零填充。不等待。
   */
  readByWallClock(startMs: number, durationMs: number): WallClockReadResult {
    const requestedSamples = Math.floor((this.sampleRate * Math.max(0, durationMs)) / 1000);
    const result = new Float32Array(requestedSamples);

    if (requestedSamples === 0 || this.anchorWallMs === null || this.storedSamples === 0) {
      return {
        pcm: result.buffer,
        filledRatio: requestedSamples === 0 ? 1 : 0,
        requestedSamples,
        presentSamples: 0,
        futureSamples: this.anchorWallMs === null ? requestedSamples : 0,
        evictedSamples: 0,
        startSampleIndex: 0,
      };
    }

    const startIdx = Math.round(this.sampleIndexAtWall(startMs));
    const endIdx = startIdx + requestedSamples;

    // 物理保留的绝对序号区间 [lo, hi)
    const hi = this.totalSamplesWritten;
    const lo = this.totalSamplesWritten - this.storedSamples;

    const copyStart = Math.max(startIdx, lo);
    const copyEnd = Math.min(endIdx, hi);

    let presentSamples = 0;
    for (let a = copyStart; a < copyEnd; a++) {
      const value = this.buffer[this.physicalIndex(a)];
      result[a - startIdx] = (value !== undefined && !isNaN(value)) ? value : 0;
      presentSamples += 1;
    }

    const evictedSamples = Math.max(0, Math.min(endIdx, lo) - startIdx);
    const futureSamples = Math.max(0, endIdx - Math.max(startIdx, hi));

    return {
      pcm: result.buffer,
      filledRatio: requestedSamples > 0 ? presentSamples / requestedSamples : 1,
      requestedSamples,
      presentSamples,
      futureSamples,
      evictedSamples,
      startSampleIndex: startIdx,
    };
  }

  /**
   * 基于时隙开始时间读取（解码路径）。委托给 readByWallClock 做挂钟寻址。
   */
  readFromSlotStart(slotStartMs: number, durationMs: number): ArrayBuffer {
    return this.readByWallClock(slotStartMs, durationMs).pcm;
  }

  /**
   * 连续读取音频数据（流式播放专用，如 OpenWebRX 预览）。
   * 自动推进读指针，确保音频连续；不影响 readByWallClock 的随机寻址。
   */
  readNext(sampleCount: number): ArrayBuffer {
    const result = new Float32Array(sampleCount);
    const available = this.getAvailableSamples();
    const samplesToRead = Math.min(sampleCount, available);

    for (let i = 0; i < samplesToRead; i++) {
      result[i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.size;
    }
    this.storedSamples = Math.max(0, this.storedSamples - samplesToRead);

    for (let i = samplesToRead; i < sampleCount; i++) {
      result[i] = 0;
    }

    return result.buffer;
  }

  /** 获取当前可用的样本数量 */
  getAvailableSamples(): number {
    return this.storedSamples;
  }

  /** 清空缓冲区（重置物理状态与采集时钟模型；下次写入重新锚定） */
  clear(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.storedSamples = 0;
    this.totalSamplesWritten = 0;
    this.buffer.fill(0);
    this.anchorWallMs = null;
    this.anchorSampleIndex = 0;
    this.estimatedRate = this.sampleRate;
    this.lastErrMs = 0;
    this.lastSeq = null;
    this.lostPackets = 0;
    this.dupPackets = 0;
    this.lastOverflowLogAt = 0;
    this.suppressedOverflowSamples = 0;
    this.lastClockDriftLogAt = 0;
    this.lastResyncLogAt = 0;
    this.lastLossLogAt = 0;
  }

  /** 获取缓冲区状态信息（含采集时钟模型诊断） */
  getStatus() {
    return {
      size: this.size,
      writeIndex: this.writeIndex,
      readIndex: this.readIndex,
      storedSamples: this.storedSamples,
      availableSamples: this.getAvailableSamples(),
      sampleRate: this.sampleRate,
      maxDurationMs: this.maxDurationMs,
      totalSamplesWritten: this.totalSamplesWritten,
      anchorWallMs: this.anchorWallMs,
      anchorSampleIndex: this.anchorSampleIndex,
      estimatedRate: this.estimatedRate,
      modelErrMs: this.lastErrMs,
      resyncCount: this.resyncCount,
      lastSeq: this.lastSeq,
      lostPackets: this.lostPackets,
      dupPackets: this.dupPackets,
    };
  }
}
