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

    // 环形缓冲区按实际输出采样率建模，避免把16k输入直接按48k设备时钟消费。
    this.outputSampleRate = sampleRate;
    this.inputSampleRate = sampleRate;
    this.ringBufferSize = Math.max(Math.ceil(this.outputSampleRate * 2), 48000);
    this.ringBuffer = new Float32Array(this.ringBufferSize);
    this.timestampBuffer = new Float64Array(this.ringBufferSize);
    this.timestampBuffer.fill(Number.NaN);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.availableSamples = 0;
    this.resampleInputBuffer = new Float32Array(0);
    this.resampleSourcePosition = 0;
    this.resampleInputRate = this.outputSampleRate;

    // 统计信息
    this.lastStatsTime = 0;
    this.statsIntervalMs = 250; // 更高频率上报，避免端到端估算使用陈旧播放时间戳
    this.totalDroppedSamples = 0;
    this.audioLevel = 0;

    // 调试：缓冲区状态监控
    this.underrunCount = 0; // 欠载（缓冲区空）次数
    this.overflowCount = 0; // 溢出次数
    this.frameCount = 0; // 帧计数器
    this.consecutiveUnderrunFrames = 0; // 连续欠载帧计数
    this.lastOutputSourceTimestampMs = null;
    this.lastMainToWorkletMs = null;
    this.plcTailMs = 8;
    this.plcRestoreCrossfadeMs = 3;
    this.plcHistory = new Float32Array(0);
    this.restoreCrossfadePending = false;

    // 播放状态控制
    this.isPlaying = false;
    this.isRecovering = false;
    this.bufferPolicy = this.createDefaultBufferPolicy();
    this.adaptiveTargetMs = this.bufferPolicy.initialTargetMs;
    this.jitterEstimator = null;
    this.jitterEstimatorSource = null;
    this.lastJitterSnapshot = null;
    this.lastLoggedJitterTargetMs = null;
    this.lastLoggedJitterMaxAtMs = 0;
    const now = Date.now();
    this.recreateJitterEstimator(now);
    this.lastUnderrunAt = now;
    this.lastTargetChangeAt = now;
    this.MIN_BUFFER_MS = 30;    // 低水位阈值：30ms（仅用于日志）
    this.prefillComplete = false;

    // 接收来自主线程的消息
    this.port.onmessage = (e) => {
      if (e.data.type === 'audioData') {
        this.writeAudioData(e.data.buffer, e.data.sampleRate, e.data.clientTimestamp, e.data.clientReceivedAtMs, e.data.sequence, e.data.frameDurationMs);
      } else if (e.data.type === 'timingProbe') {
        this.recordTimingProbe(e.data.probe, e.data.receivedAtMs);
      } else if (e.data.type === 'setBufferPolicy') {
        this.setBufferPolicy(e.data.policy);
      } else if (e.data.type === 'reset') {
        this.reset();
      }
    };
  }

  createDefaultBufferPolicy() {
    return {
      adaptive: true,
      targetBufferMs: 80,
      initialTargetMs: 80,
      minTargetMs: 60,
      maxTargetMs: 400,
      queueHeadroomMs: 20,
      targetIncreaseMs: 15,
      targetDecreaseMs: 5,
      underrunRecoveryFrames: 3,
      adaptIncreaseCooldownMs: 2500,
      adaptDecreaseAfterMs: 10000,
      adaptDecreaseCooldownMs: 15000,
    };
  }

  setBufferPolicy(policy) {
    const defaults = this.createDefaultBufferPolicy();
    const next = policy && typeof policy === 'object' ? policy : defaults;
    const numberOrDefault = (value, fallback) => (
      Number.isFinite(Number(value)) ? Number(value) : fallback
    );
    const initialTargetMs = Math.max(1, numberOrDefault(next.initialTargetMs, defaults.initialTargetMs));

    this.bufferPolicy = {
      adaptive: next.adaptive === true,
      targetBufferMs: Math.max(1, numberOrDefault(next.targetBufferMs, initialTargetMs)),
      initialTargetMs,
      minTargetMs: Math.max(1, numberOrDefault(next.minTargetMs, defaults.minTargetMs)),
      maxTargetMs: Math.max(1, numberOrDefault(next.maxTargetMs, defaults.maxTargetMs)),
      queueHeadroomMs: Math.max(0, numberOrDefault(next.queueHeadroomMs, defaults.queueHeadroomMs)),
      targetIncreaseMs: Math.max(0, numberOrDefault(next.targetIncreaseMs, defaults.targetIncreaseMs)),
      targetDecreaseMs: Math.max(0, numberOrDefault(next.targetDecreaseMs, defaults.targetDecreaseMs)),
      underrunRecoveryFrames: Math.max(1, Math.round(numberOrDefault(next.underrunRecoveryFrames, defaults.underrunRecoveryFrames))),
      adaptIncreaseCooldownMs: Math.max(0, numberOrDefault(next.adaptIncreaseCooldownMs, defaults.adaptIncreaseCooldownMs)),
      adaptDecreaseAfterMs: Math.max(0, numberOrDefault(next.adaptDecreaseAfterMs, defaults.adaptDecreaseAfterMs)),
      adaptDecreaseCooldownMs: Math.max(0, numberOrDefault(next.adaptDecreaseCooldownMs, defaults.adaptDecreaseCooldownMs)),
    };
    this.reset();
  }

  /**
   * 写入音频数据到环形缓冲区
   */
  writeAudioData(buffer, sampleRate, clientTimestamp, clientReceivedAtMs, sequence, frameDurationMs) {
    const audioData = new Float32Array(buffer);
    this.lastMainToWorkletMs = typeof clientReceivedAtMs === 'number'
      ? Math.max(0, Date.now() - clientReceivedAtMs)
      : null;
    const frameSampleRate = Number(sampleRate) > 0 ? Number(sampleRate) : this.outputSampleRate;
    this.inputSampleRate = frameSampleRate;
    const resampledData = this.resampleToOutputRate(audioData, frameSampleRate);
    const samples = resampledData.length;

    this.notePacketJitter({
      sequence,
      arrivalTimeMs: typeof clientReceivedAtMs === 'number' ? clientReceivedAtMs : Date.now(),
      frameDurationMs,
    });
    this.frameCount++;
    this.enqueueSamples(resampledData, samples, Number(clientTimestamp));
  }

  enqueueSamples(samplesData, sampleCount = samplesData.length, sourceTimestampMs = Number.NaN) {
    if (!samplesData || sampleCount <= 0) {
      return;
    }

    // 检查缓冲区是否有足够空间
    const freeSpace = this.ringBufferSize - this.availableSamples;
    if (sampleCount > freeSpace) {
      // 缓冲区溢出，丢弃最旧的数据
      const dropCount = sampleCount - freeSpace;
      this.totalDroppedSamples += dropCount;
      this.overflowCount++;
      this.readIndex = (this.readIndex + dropCount) % this.ringBufferSize;
      this.availableSamples -= dropCount;
    }

    // 写入数据
    for (let i = 0; i < sampleCount; i++) {
      this.ringBuffer[this.writeIndex] = samplesData[i];
      this.timestampBuffer[this.writeIndex] = Number.isFinite(sourceTimestampMs)
        ? sourceTimestampMs + ((i / this.outputSampleRate) * 1000)
        : Number.NaN;
      this.writeIndex = (this.writeIndex + 1) % this.ringBufferSize;
    }

    this.availableSamples = Math.min(
      this.availableSamples + sampleCount,
      this.ringBufferSize
    );
    this.trimExcessQueue();
  }

  trimExcessQueue() {
    const maxQueueSamples = Math.ceil(((this.adaptiveTargetMs + this.bufferPolicy.queueHeadroomMs) / 1000) * this.outputSampleRate);
    if (this.availableSamples <= maxQueueSamples) {
      return;
    }

    const trimToSamples = Math.ceil((this.adaptiveTargetMs / 1000) * this.outputSampleRate);
    const dropCount = Math.max(0, this.availableSamples - trimToSamples);
    if (dropCount <= 0) {
      return;
    }

    this.readIndex = (this.readIndex + dropCount) % this.ringBufferSize;
    this.availableSamples -= dropCount;
    this.totalDroppedSamples += dropCount;
    this.overflowCount++;
  }

  /**
   * 从环形缓冲区读取音频数据
   */
  readAudioData(output) {
    const samples = output.length;
    const bufferMs = this.availableSamples / (this.outputSampleRate / 1000);

    // 预填充检查
    if (!this.isPlaying || this.isRecovering) {
      if (bufferMs >= this.adaptiveTargetMs) {
        this.isPlaying = true;
        this.isRecovering = false;
        this.prefillComplete = true;
        this.consecutiveUnderrunFrames = 0;
      } else {
        // 继续静音，等待预填充
        for (let i = 0; i < samples; i++) {
          output[i] = 0;
        }
        return;
      }
    }

    // 正常播放：缓冲区有数据就读；欠载时只做一次短尾段PLC，之后静音。
    let totalSquare = 0;
    let hadUnderrun = false;
    let outputSourceTimestampMs = null;
    let realSamples = 0;

    while (realSamples < samples && this.availableSamples > 0) {
      const sample = this.ringBuffer[this.readIndex];
      const sourceTimestampMs = this.timestampBuffer[this.readIndex];
      output[realSamples] = sample;
      outputSourceTimestampMs = Number.isFinite(sourceTimestampMs) ? sourceTimestampMs : null;
      this.readIndex = (this.readIndex + 1) % this.ringBufferSize;
      this.availableSamples--;
      realSamples++;
    }
    if (realSamples > 0) {
      this.applyRestoreCrossfade(output, realSamples);
      this.recordRealOutput(output.subarray(0, realSamples));
    }
    if (realSamples < samples) {
      output.fill(0, realSamples);
      this.fillTailPlc(output, realSamples);
      hadUnderrun = true;
    }
    for (let i = 0; i < samples; i++) {
      totalSquare += output[i] * output[i];
    }

    if (hadUnderrun) {
      this.underrunCount++;
      this.consecutiveUnderrunFrames++;
      this.noteUnderrun(Date.now());
    } else {
      this.consecutiveUnderrunFrames = 0;
    }
    this.lastOutputSourceTimestampMs = outputSourceTimestampMs;

    if (samples > 0) {
      this.audioLevel = Math.sqrt(totalSquare / samples);
    }
  }

  /**
   * 计算并发送统计信息
   */
  sendStats(currentTime) {
    this.maybeReduceTarget(Date.now());
    if (currentTime - this.lastStatsTime >= this.statsIntervalMs / 1000) {
      const bufferFillPercent = (this.availableSamples / this.ringBufferSize) * 100;
      const isActive = this.audioLevel > 0.001; // 音频活动阈值

      // 延迟按实际输出采样率估算，否则16k输入会被错误放大。
      const latencyMs = (this.availableSamples / (this.outputSampleRate / 1000));
      const nextOutputSourceTimestampMs = this.availableSamples > 0 && Number.isFinite(this.timestampBuffer[this.readIndex])
        ? this.timestampBuffer[this.readIndex]
        : null;

      this.port.postMessage({
        type: 'stats',
        data: {
          latencyMs,
          queueDurationMs: latencyMs,
          targetBufferMs: this.adaptiveTargetMs,
          bufferFillPercent: Math.max(0, Math.min(100, (latencyMs / Math.max(this.adaptiveTargetMs, 1)) * 100)),
          isActive,
          audioLevel: this.audioLevel,
          droppedSamples: this.totalDroppedSamples,
          underrunCount: this.underrunCount,
          outputSourceTimestampMs: this.lastOutputSourceTimestampMs,
          nextOutputSourceTimestampMs,
          mainToWorkletMs: this.lastMainToWorkletMs,
          statsGeneratedAtMs: Date.now(),
          availableSamples: this.availableSamples,
          sampleRate: this.outputSampleRate,
          inputSampleRate: this.inputSampleRate,
          jitterP95Ms: this.lastJitterSnapshot?.relativeDelayP95Ms,
          jitterEwmaMs: this.lastJitterSnapshot?.jitterEwmaMs,
        }
      });

      this.lastStatsTime = currentTime;
    }
  }

  noteUnderrun(now) {
    this.lastUnderrunAt = now;
    if (this.bufferPolicy.adaptive) {
      this.lastJitterSnapshot = this.noteEstimatorUnderrun(now);
      this.adaptiveTargetMs = this.lastJitterSnapshot?.activeTargetMs ?? Math.min(this.bufferPolicy.maxTargetMs, this.adaptiveTargetMs + 20);
      this.lastTargetChangeAt = now;
    }
    if (this.consecutiveUnderrunFrames >= this.bufferPolicy.underrunRecoveryFrames) {
      this.isRecovering = true;
    }
  }

  maybeReduceTarget(now) {
    if (!this.bufferPolicy.adaptive || !this.jitterEstimator) {
      return;
    }
    this.lastJitterSnapshot = this.updateEstimatorTarget(now);
    this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
  }

  recordTimingProbe(probe, receivedAtMs = Date.now()) {
    if (!this.bufferPolicy.adaptive || !this.jitterEstimator || !probe) {
      return;
    }
    if (this.jitterEstimatorSource === 'packet') {
      return;
    }
    this.jitterEstimatorSource = 'probe';
    this.lastJitterSnapshot = this.recordEstimatorSample({
      sequence: Number(probe.sequence),
      senderMs: Number(probe.sentAtMs),
      arrivalMs: Number(receivedAtMs),
      stepMs: Number(probe.intervalMs) || 200,
    });
    this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
    this.logJitterSnapshot('probe');
  }

  notePacketJitter(sample) {
    if (!this.bufferPolicy.adaptive || !this.jitterEstimator) {
      return;
    }
    if (this.jitterEstimatorSource !== 'packet') {
      this.recreateJitterEstimator(Number(sample.arrivalTimeMs) || Date.now(), this.adaptiveTargetMs);
      this.jitterEstimatorSource = 'packet';
    }
    const stepMs = Number(sample.frameDurationMs) > 0 ? Number(sample.frameDurationMs) : 20;
    const sequence = Number.isFinite(Number(sample.sequence)) ? Number(sample.sequence) : null;
    this.lastJitterSnapshot = this.recordEstimatorSample({
      sequence,
      senderMs: this.deriveEstimatorSenderMs(sequence, stepMs),
      arrivalMs: Number(sample.arrivalTimeMs),
      stepMs,
    });
    this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
    this.logJitterSnapshot('packet');
  }

  recreateJitterEstimator(now, initialTargetMs = this.bufferPolicy.initialTargetMs) {
    if (!this.bufferPolicy.adaptive) {
      this.jitterEstimator = null;
      this.jitterEstimatorSource = null;
      this.lastJitterSnapshot = null;
      return;
    }
    this.adaptiveTargetMs = Math.max(
      this.bufferPolicy.minTargetMs,
      Math.min(this.bufferPolicy.maxTargetMs, Math.round(Number(initialTargetMs) || this.bufferPolicy.initialTargetMs))
    );
    this.jitterEstimator = {
      firstArrivalMs: null,
      firstSenderMs: null,
      minRelativeTransitMs: 0,
      lastSample: null,
      samples: [],
      jitterEwmaMs: 0,
      lastImpairmentAtMs: now,
      lastTargetChangeAtMs: now,
    };
    this.jitterEstimatorSource = null;
    this.lastJitterSnapshot = this.getEstimatorSnapshot(now);
    this.lastLoggedJitterTargetMs = null;
  }

  deriveEstimatorSenderMs(sequence, stepMs) {
    if (typeof sequence === 'number' && Number.isFinite(sequence)) {
      return sequence * stepMs;
    }
    return this.jitterEstimator?.lastSample ? this.jitterEstimator.lastSample.senderMs + stepMs : 0;
  }

  recordEstimatorSample(sample) {
    if (!this.jitterEstimator || !Number.isFinite(sample.arrivalMs)) {
      return this.getEstimatorSnapshot(Date.now());
    }
    const estimator = this.jitterEstimator;
    let arrivalDeltaMs = null;
    let senderDeltaMs = null;
    let jitterSampleMs = null;
    if (estimator.lastSample) {
      arrivalDeltaMs = sample.arrivalMs - estimator.lastSample.arrivalMs;
      senderDeltaMs = sample.senderMs - estimator.lastSample.senderMs;
      if (!(senderDeltaMs > 0) && typeof sample.sequence === 'number' && typeof estimator.lastSample.sequence === 'number' && sample.sequence > estimator.lastSample.sequence) {
        senderDeltaMs = (sample.sequence - estimator.lastSample.sequence) * sample.stepMs;
      }
      if (arrivalDeltaMs >= 0 && senderDeltaMs > 0 && senderDeltaMs < 5000) {
        jitterSampleMs = Math.abs(arrivalDeltaMs - senderDeltaMs);
        estimator.jitterEwmaMs += (jitterSampleMs - estimator.jitterEwmaMs) / 16;
      }
    }
    if (estimator.firstArrivalMs === null || estimator.firstSenderMs === null) {
      estimator.firstArrivalMs = sample.arrivalMs;
      estimator.firstSenderMs = sample.senderMs;
      estimator.minRelativeTransitMs = 0;
    }
    const relativeTransitMs = (sample.arrivalMs - estimator.firstArrivalMs) - (sample.senderMs - estimator.firstSenderMs);
    estimator.minRelativeTransitMs = Math.min(estimator.minRelativeTransitMs, relativeTransitMs);
    const relativeDelayMs = Math.max(0, relativeTransitMs - estimator.minRelativeTransitMs);
    estimator.lastSampleDiagnostics = {
      sequence: sample.sequence,
      senderMs: sample.senderMs,
      arrivalMs: sample.arrivalMs,
      stepMs: sample.stepMs,
      arrivalDeltaMs,
      senderDeltaMs,
      jitterSampleMs,
      relativeTransitMs,
      minRelativeTransitMs: estimator.minRelativeTransitMs,
      relativeDelayMs,
    };
    estimator.samples.push({ at: sample.arrivalMs, delayMs: relativeDelayMs });
    while (estimator.samples.length > 0 && (sample.arrivalMs - estimator.samples[0].at) > 10000) {
      estimator.samples.shift();
    }
    while (estimator.samples.length > 160) {
      estimator.samples.shift();
    }
    estimator.lastSample = sample;
    return this.updateEstimatorTarget(sample.arrivalMs);
  }

  updateEstimatorTarget(now) {
    const snapshot = this.getEstimatorSnapshot(now);
    if (!this.jitterEstimator) {
      return snapshot;
    }
    if (snapshot.recommendedTargetMs > this.adaptiveTargetMs) {
      this.adaptiveTargetMs = snapshot.recommendedTargetMs;
      this.jitterEstimator.lastImpairmentAtMs = now;
      this.jitterEstimator.lastTargetChangeAtMs = now;
      const nextSnapshot = this.getEstimatorSnapshot(now);
      this.lastJitterSnapshot = nextSnapshot;
      this.logJitterSnapshot('timer');
      return nextSnapshot;
    } else if (snapshot.recommendedTargetMs < this.adaptiveTargetMs
      && (now - this.jitterEstimator.lastImpairmentAtMs) >= this.bufferPolicy.adaptDecreaseAfterMs
      && (now - this.jitterEstimator.lastTargetChangeAtMs) >= this.bufferPolicy.adaptDecreaseAfterMs) {
      this.adaptiveTargetMs = Math.max(snapshot.recommendedTargetMs, this.adaptiveTargetMs - 20, this.bufferPolicy.minTargetMs);
      this.jitterEstimator.lastTargetChangeAtMs = now;
      this.jitterEstimator.lastImpairmentAtMs = now;
      const nextSnapshot = this.getEstimatorSnapshot(now);
      this.lastJitterSnapshot = nextSnapshot;
      this.logJitterSnapshot('timer');
      return nextSnapshot;
    }
    return this.getEstimatorSnapshot(now);
  }

  noteEstimatorUnderrun(now) {
    if (!this.jitterEstimator) {
      return null;
    }
    this.adaptiveTargetMs = Math.min(this.bufferPolicy.maxTargetMs, Math.ceil((this.adaptiveTargetMs + 20) / 20) * 20);
    this.jitterEstimator.lastImpairmentAtMs = now;
    this.jitterEstimator.lastTargetChangeAtMs = now;
    const snapshot = this.getEstimatorSnapshot(now);
    this.logJitterSnapshot('underrun');
    return snapshot;
  }

  getEstimatorSnapshot(now) {
    const delays = this.jitterEstimator?.samples.map((sample) => sample.delayMs).sort((a, b) => a - b) ?? [];
    const p95Index = delays.length === 0 ? -1 : Math.min(delays.length - 1, Math.max(0, Math.ceil(delays.length * 0.95) - 1));
    const p95 = p95Index >= 0 ? delays[p95Index] : 0;
    const recommended = Math.max(
      this.bufferPolicy.targetBufferMs,
      Math.min(this.bufferPolicy.maxTargetMs, Math.max(this.bufferPolicy.minTargetMs, Math.ceil((60 + p95 + 10) / 20) * 20))
    );
    return {
      activeTargetMs: this.adaptiveTargetMs,
      recommendedTargetMs: recommended,
      relativeDelayP95Ms: p95,
      jitterEwmaMs: this.jitterEstimator?.jitterEwmaMs ?? 0,
      sampleCount: delays.length,
      lastUpdatedAtMs: now,
      lastSample: this.jitterEstimator?.lastSampleDiagnostics ?? null,
    };
  }

  logJitterSnapshot(reason) {
    if (!this.lastJitterSnapshot) {
      return;
    }
    const targetChanged = this.lastLoggedJitterTargetMs !== this.lastJitterSnapshot.activeTargetMs;
    const isAtMax = this.lastJitterSnapshot.activeTargetMs >= this.bufferPolicy.maxTargetMs;
    const now = Date.now();
    const shouldRepeatMaxLog = isAtMax && (now - this.lastLoggedJitterMaxAtMs) >= 2000;
    if (!targetChanged && !shouldRepeatMaxLog) {
      return;
    }
    this.lastLoggedJitterTargetMs = this.lastJitterSnapshot.activeTargetMs;
    if (isAtMax) {
      this.lastLoggedJitterMaxAtMs = now;
    }
    this.port.postMessage({
      type: 'jitterDebug',
      data: {
        reason,
        backend: 'audio-worklet',
        source: this.jitterEstimatorSource,
        targetMs: this.lastJitterSnapshot.activeTargetMs,
        recommendedMs: this.lastJitterSnapshot.recommendedTargetMs,
        p95Ms: this.lastJitterSnapshot.relativeDelayP95Ms,
        jitterEwmaMs: this.lastJitterSnapshot.jitterEwmaMs,
        sampleCount: this.lastJitterSnapshot.sampleCount,
        lastSample: this.lastJitterSnapshot.lastSample,
        queueMs: this.availableSamples / (this.outputSampleRate / 1000),
        underruns: this.underrunCount,
        policy: this.bufferPolicy,
        isAtMax,
      }
    });
  }

  fillTailPlc(output, offset) {
    if (this.consecutiveUnderrunFrames > 0 || this.plcHistory.length === 0 || offset >= output.length) {
      return;
    }
    const maxPlcSamples = Math.ceil((this.plcTailMs / 1000) * this.outputSampleRate);
    const plcSamples = Math.min(output.length - offset, maxPlcSamples, this.plcHistory.length);
    const sourceSamples = Math.min(this.plcHistory.length, maxPlcSamples);
    const sourceStart = this.plcHistory.length - sourceSamples;
    for (let i = 0; i < plcSamples; i++) {
      const phase = plcSamples <= 1 ? 1 : i / (plcSamples - 1);
      const fade = Math.cos((phase * Math.PI) / 2);
      output[offset + i] = this.plcHistory[sourceStart + (i % sourceSamples)] * fade;
    }
    this.restoreCrossfadePending = true;
  }

  applyRestoreCrossfade(output, realSamples) {
    if (!this.restoreCrossfadePending || this.plcHistory.length === 0) {
      this.restoreCrossfadePending = false;
      return;
    }
    const crossfadeSamples = Math.min(
      realSamples,
      this.plcHistory.length,
      Math.ceil((this.plcRestoreCrossfadeMs / 1000) * this.outputSampleRate)
    );
    const historyStart = this.plcHistory.length - crossfadeSamples;
    for (let i = 0; i < crossfadeSamples; i++) {
      const wet = (i + 1) / (crossfadeSamples + 1);
      output[i] = (this.plcHistory[historyStart + i] * (1 - wet)) + (output[i] * wet);
    }
    this.restoreCrossfadePending = false;
  }

  recordRealOutput(samples) {
    if (!samples || samples.length === 0) {
      return;
    }
    const maxHistorySamples = Math.ceil((this.plcTailMs / 1000) * this.outputSampleRate);
    if (samples.length >= maxHistorySamples) {
      this.plcHistory = new Float32Array(samples.subarray(samples.length - maxHistorySamples));
      return;
    }
    const merged = new Float32Array(Math.min(maxHistorySamples, this.plcHistory.length + samples.length));
    const keep = Math.max(0, merged.length - samples.length);
    if (keep > 0) {
      merged.set(this.plcHistory.subarray(this.plcHistory.length - keep), 0);
    }
    merged.set(samples, keep);
    this.plcHistory = merged;
  }

  resampleToOutputRate(input, inputSampleRate) {
    if (!input || input.length === 0) {
      return input;
    }

    if (!inputSampleRate || inputSampleRate === this.outputSampleRate) {
      return input;
    }

    if (this.resampleInputRate !== inputSampleRate) {
      this.resampleInputBuffer = new Float32Array(0);
      this.resampleSourcePosition = 0;
      this.resampleInputRate = inputSampleRate;
    }

    const merged = new Float32Array(this.resampleInputBuffer.length + input.length);
    merged.set(this.resampleInputBuffer);
    merged.set(input, this.resampleInputBuffer.length);
    this.resampleInputBuffer = merged;

    const ratio = inputSampleRate / this.outputSampleRate;
    let outputLength = 0;
    let probePosition = this.resampleSourcePosition;
    while (probePosition < this.resampleInputBuffer.length - 1) {
      outputLength++;
      probePosition += ratio;
    }

    if (outputLength === 0) {
      return new Float32Array(0);
    }

    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = this.resampleSourcePosition;
      const left = Math.floor(sourceIndex);
      const right = Math.min(left + 1, this.resampleInputBuffer.length - 1);
      const fraction = sourceIndex - left;
      const leftSample = this.resampleInputBuffer[left] ?? 0;
      const rightSample = this.resampleInputBuffer[right] ?? leftSample;
      output[i] = leftSample * (1 - fraction) + rightSample * fraction;
      this.resampleSourcePosition += ratio;
    }

    const consumedSamples = Math.floor(this.resampleSourcePosition);
    if (consumedSamples > 0) {
      this.resampleInputBuffer = this.resampleInputBuffer.slice(consumedSamples);
      this.resampleSourcePosition -= consumedSamples;
    }

    return output;
  }

  /**
   * 重置缓冲区
   */
  reset() {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.availableSamples = 0;
    this.totalDroppedSamples = 0;
    this.underrunCount = 0;
    this.consecutiveUnderrunFrames = 0;
    this.isPlaying = false;
    this.isRecovering = false;
    this.adaptiveTargetMs = this.bufferPolicy.initialTargetMs;
    const now = Date.now();
    this.recreateJitterEstimator(now);
    this.lastUnderrunAt = now;
    this.lastTargetChangeAt = now;
    this.audioLevel = 0;
    this.lastOutputSourceTimestampMs = null;
    this.lastMainToWorkletMs = null;
    this.plcHistory = new Float32Array(0);
    this.restoreCrossfadePending = false;
    this.timestampBuffer.fill(Number.NaN);
    this.resampleInputBuffer = new Float32Array(0);
    this.resampleSourcePosition = 0;
    this.resampleInputRate = this.outputSampleRate;
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
