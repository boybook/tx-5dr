import {
  ComplexSpectrumAnalyzer,
  type ComplexSpectrumAnalyzerOptions,
  type ComplexSpectrumResult,
} from 'rubato-fft-node';
import {
  TciClient,
  decodeInterleavedIq,
  type TciClientOptions,
  type TciIqFrame,
  type TciIqStreamSession,
} from 'tci-client-node';
import type { SpectrumFrame, SpectrumSourceAvailability } from '@tx5dr/contracts';
import type { TciConnection } from '../radio/connections/TciConnection.js';
import { createLogger } from '../utils/logger.js';
import type { RadioSpectrumSource, RadioSpectrumSpanController } from './RadioSpectrumSource.js';
import { TCI_DBFS_LEVEL } from './spectrumUtils.js';

const logger = createLogger('TciIqSpectrumSource');
const DEFAULT_IQ_SAMPLE_RATE = 96_000;
const FFT_SIZE = 4096;
const DISPLAY_BINS = 1024;
const ANALYSIS_INTERVAL_MS = 100;
const SAMPLE_RATE_FRAME_CONFIRM_MS = 750;
const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5_000;

export interface TciIqSpectrumSourceOptions {
  clientFactory?: (options: TciClientOptions) => TciClient;
  analyzerFactory?: (options: ComplexSpectrumAnalyzerOptions) => {
    analyze(interleavedIq: Float32Array): Promise<ComplexSpectrumResult>;
  };
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export class TciIqSpectrumSource implements RadioSpectrumSource, RadioSpectrumSpanController {
  readonly key: object;
  readonly spanController: RadioSpectrumSpanController = this;
  readonly frameSpanScale = 1;
  readonly preferFrameSpan = false;
  private client: TciClient | null = null;
  private session: TciIqStreamSession | null = null;
  private listener: ((frame: SpectrumFrame) => void) | null = null;
  private analyzer: { analyze(interleavedIq: Float32Array): Promise<ComplexSpectrumResult> } | null = null;
  private analyzerSampleRate = 0;
  private analyzerRevision = 0;
  private ring = new Float32Array(FFT_SIZE * 2);
  private ringWrite = 0;
  private ringComplexCount = 0;
  private analysisActive = false;
  private analysisPending = false;
  private lastAnalysisAt = 0;
  private currentSpan: number | null = null;
  private supportedSpans: number[] = [];
  private rejectedSpans = new Set<number>();
  private latestCenterFrequency: number | undefined;
  private ifLimits: readonly [number, number] | null = null;
  private lastStreamParametersSignature: string | null = null;
  private pendingSampleRateNegotiation: {
    replyRate: number | null;
    lastFrameRate: number | null;
    resolve: (sampleRate: number) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private generation = 0;
  private desiredRunning = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private readonly clientFactory: (options: TciClientOptions) => TciClient;
  private readonly analyzerFactory: NonNullable<TciIqSpectrumSourceOptions['analyzerFactory']>;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  constructor(
    private readonly connection: TciConnection,
    options: TciIqSpectrumSourceOptions = {},
  ) {
    this.key = connection;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new TciClient(clientOptions));
    this.analyzerFactory = options.analyzerFactory ?? ((analyzerOptions) => new ComplexSpectrumAnalyzer(analyzerOptions));
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
  }

  async getAvailability(): Promise<SpectrumSourceAvailability> {
    const support = this.connection.getTciIqSupport();
    return {
      kind: 'radio-sdr',
      supported: support.supported,
      available: support.supported && this.connection.isConnected(),
      defaultSelected: false,
      reason: support.supported
        ? (this.connection.isConnected() ? undefined : 'radio_disconnected')
        : 'tci_iq_not_supported',
      sourceBinCount: FFT_SIZE,
      displayBinCount: DISPLAY_BINS,
      supportsWaterfall: true,
      frequencyRangeMode: 'absolute',
    };
  }

  async start(listener: (frame: SpectrumFrame) => void): Promise<void> {
    this.listener = listener;
    this.desiredRunning = true;
    if (this.session) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connectStream();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectStream(): Promise<void> {
    const options = this.connection.getTciIqClientOptions();
    if (!options) throw new Error('TCI IQ connection is unavailable');
    const generation = ++this.generation;
    const client = this.clientFactory(options);
    this.client = client;
    client.on('error', (error) => logger.warn('TCI IQ client error', error));
    client.on('disconnected', (reason) => this.handleDisconnected(client, generation, reason));
    try {
      await client.connect();
      if (!this.isCurrentAttempt(client, generation)) {
        await client.disconnect().catch(() => undefined);
        return;
      }
      const capabilities = client.getIqCapabilities();
      this.rejectedSpans.clear();
      this.supportedSpans = [...capabilities.supportedSampleRates].sort((left, right) => left - right);
      this.updateIfLimits(client.getState().ifLimits);
      client.on('state', (state) => this.updateIfLimits(state.ifLimits));
      const currentRate = capabilities.currentSampleRate;
      const requestedRate = typeof currentRate === 'number' && currentRate > 0
        ? currentRate
        : this.supportedSpans.includes(DEFAULT_IQ_SAMPLE_RATE)
          ? DEFAULT_IQ_SAMPLE_RATE
          : this.supportedSpans[0] ?? 48_000;
      const session = await client.openIqStream({
        receiver: options.receiver,
        sampleRate: requestedRate,
        firstFrameTimeoutMs: 5_000,
      });
      if (!this.isCurrentAttempt(client, generation)) {
        await session.close();
        await client.disconnect().catch(() => undefined);
        return;
      }
      this.session = session;
      this.reconnectAttempt = 0;
      this.currentSpan = session.appliedSampleRate;
      this.resetAnalyzer(session.appliedSampleRate);
      session.on('frame', (frame) => this.handleIqFrame(frame, generation));
      session.on('error', (error) => logger.warn('TCI IQ stream error', error));
      logger.info('TCI IQ spectrum started', {
        requestedSampleRate: requestedRate,
        appliedSampleRate: session.appliedSampleRate,
        protocolSampleRates: this.supportedSpans,
        zoomSampleRates: await this.getSupportedSpans(),
        ifLimits: this.ifLimits,
        displayWindow: this.resolveDisplayWindow(session.appliedSampleRate),
      });
    } catch (error) {
      if (this.client === client) this.client = null;
      await client.disconnect().catch(() => undefined);
      if (!this.desiredRunning || generation !== this.generation) return;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const wasRunning = Boolean(
      this.desiredRunning
      || this.session
      || this.client
      || this.connectPromise
      || this.reconnectTimer,
    );
    this.desiredRunning = false;
    ++this.generation;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const session = this.session;
    const client = this.client;
    const connectPromise = this.connectPromise;
    this.session = null;
    this.client = null;
    this.listener = null;
    this.analysisPending = false;
    this.analysisActive = false;
    this.ringWrite = 0;
    this.ringComplexCount = 0;
    this.latestCenterFrequency = undefined;
    this.cancelSampleRateNegotiation(new Error('TCI IQ spectrum stopped'));
    await session?.close().catch((error) => logger.debug('Failed to stop TCI IQ session', error));
    await client?.disconnect().catch((error) => logger.debug('Failed to disconnect TCI IQ client', error));
    await connectPromise?.catch(() => undefined);
    if (wasRunning) logger.info('TCI IQ spectrum stopped');
  }

  async getSupportedSpans(): Promise<readonly number[]> {
    const spans = this.supportedSpans.length > 0
      ? this.supportedSpans
      : [...this.connection.getTciIqSupport().supportedSampleRates];
    const candidates = spans
      .filter((span) => !this.rejectedSpans.has(span))
      .sort((left, right) => left - right);
    if (this.currentSpan && !candidates.includes(this.currentSpan)) candidates.push(this.currentSpan);

    const ratesByDisplaySpan = new Map<number, number[]>();
    for (const sampleRate of candidates) {
      const window = this.resolveDisplayWindow(sampleRate);
      const displaySpan = window.maxOffsetHz - window.minOffsetHz;
      const rates = ratesByDisplaySpan.get(displaySpan) ?? [];
      rates.push(sampleRate);
      ratesByDisplaySpan.set(displaySpan, rates);
    }

    return [...ratesByDisplaySpan.values()]
      .map((rates) => rates.includes(this.currentSpan ?? -1) ? this.currentSpan! : Math.min(...rates))
      .sort((left, right) => left - right);
  }

  async getCurrentSpan(): Promise<number | null> { return this.currentSpan; }

  async setSpan(spanHz: number): Promise<number> {
    const session = this.session;
    if (!session) throw new Error('TCI IQ spectrum is not active');
    if (this.pendingSampleRateNegotiation) throw new Error('TCI IQ sample-rate negotiation is already active');
    let resolveFrameRate!: (sampleRate: number) => void;
    let rejectFrameRate!: (error: unknown) => void;
    const frameRate = new Promise<number>((resolve, reject) => {
      resolveFrameRate = resolve;
      rejectFrameRate = reject;
    });
    const timer = setTimeout(() => {
      const pending = this.pendingSampleRateNegotiation;
      if (!pending) return;
      this.pendingSampleRateNegotiation = null;
      pending.resolve(pending.lastFrameRate ?? pending.replyRate ?? this.currentSpan ?? spanHz);
    }, SAMPLE_RATE_FRAME_CONFIRM_MS);
    this.pendingSampleRateNegotiation = {
      replyRate: null,
      lastFrameRate: null,
      resolve: resolveFrameRate,
      reject: rejectFrameRate,
      timer,
    };

    try {
      const result = await session.setSampleRate(spanHz);
      const pending = this.pendingSampleRateNegotiation;
      if (pending) {
        pending.replyRate = result.applied;
        if (pending.lastFrameRate === result.applied) this.finishSampleRateNegotiation(result.applied);
      }
      const applied = await frameRate;
      if (applied !== spanHz) this.rejectedSpans.add(spanHz);
      this.currentSpan = applied;
      if (applied !== this.analyzerSampleRate) this.resetAnalyzer(applied);
      logger.info('TCI IQ sample-rate negotiation completed', {
        requestedSampleRate: spanHz,
        textReadbackSampleRate: result.applied,
        frameSampleRate: applied,
        accepted: applied === spanHz,
        supportedSpans: await this.getSupportedSpans(),
      });
      return applied;
    } catch (error) {
      const pending = this.pendingSampleRateNegotiation;
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSampleRateNegotiation = null;
        pending.resolve(this.currentSpan ?? spanHz);
      }
      throw error;
    }
  }

  private handleIqFrame(frame: TciIqFrame, generation: number): void {
    if (generation !== this.generation) return;
    if (frame.sampleRate !== this.analyzerSampleRate) this.resetAnalyzer(frame.sampleRate);
    const interleaved = decodeInterleavedIq(frame.frame);
    for (let index = 0; index + 1 < interleaved.length; index += 2) {
      this.ring[this.ringWrite * 2] = interleaved[index]!;
      this.ring[this.ringWrite * 2 + 1] = interleaved[index + 1]!;
      this.ringWrite = (this.ringWrite + 1) % FFT_SIZE;
      this.ringComplexCount = Math.min(FFT_SIZE, this.ringComplexCount + 1);
    }
    this.latestCenterFrequency = frame.centerFrequency;
    this.currentSpan = frame.sampleRate;
    const pendingNegotiation = this.pendingSampleRateNegotiation;
    if (pendingNegotiation) {
      pendingNegotiation.lastFrameRate = frame.sampleRate;
      if (pendingNegotiation.replyRate === frame.sampleRate) this.finishSampleRateNegotiation(frame.sampleRate);
    }
    this.logStreamParameters(frame);
    const now = performance.now();
    if (this.ringComplexCount < FFT_SIZE || now - this.lastAnalysisAt < ANALYSIS_INTERVAL_MS) return;
    if (this.analysisActive) {
      this.analysisPending = true;
      return;
    }
    void this.analyzeLatest(generation);
  }

  private async analyzeLatest(generation: number): Promise<void> {
    const analyzer = this.analyzer;
    const analyzerRevision = this.analyzerRevision;
    const listener = this.listener;
    const centerFrequency = this.latestCenterFrequency;
    if (!analyzer || !listener || centerFrequency === undefined) return;
    this.analysisActive = true;
    this.analysisPending = false;
    this.lastAnalysisAt = performance.now();
    const snapshot = new Float32Array(FFT_SIZE * 2);
    for (let index = 0; index < FFT_SIZE; index++) {
      const source = (this.ringWrite + index) % FFT_SIZE;
      snapshot[index * 2] = this.ring[source * 2]!;
      snapshot[index * 2 + 1] = this.ring[source * 2 + 1]!;
    }
    try {
      const result = await analyzer.analyze(snapshot);
      if (
        generation !== this.generation
        || analyzerRevision !== this.analyzerRevision
        || listener !== this.listener
      ) return;
      const displayWindow = this.resolveDisplayWindow(result.spanHz);
      const magnitudes = this.cropAndCompressMagnitudes(
        result.magnitudesBase64,
        result.magnitudesLength,
        result.spanHz,
        displayWindow,
      );
      const spanHz = displayWindow.maxOffsetHz - displayWindow.minOffsetHz;
      listener({
        timestamp: Date.now(),
        kind: 'radio-sdr',
        frequencyRange: {
          min: centerFrequency + displayWindow.minOffsetHz,
          max: centerFrequency + displayWindow.maxOffsetHz,
        },
        binaryData: {
          data: Buffer.from(magnitudes.buffer, magnitudes.byteOffset, magnitudes.byteLength).toString('base64'),
          format: { type: 'int16', length: magnitudes.length, scale: result.scale, offset: result.offset },
        },
        meta: {
          sourceBinCount: FFT_SIZE,
          displayBinCount: magnitudes.length,
          centerFrequency,
          spanHz,
          profileId: null,
          radioModel: 'TCI IQ',
          level: TCI_DBFS_LEVEL,
        },
      });
    } catch (error) {
      logger.warn('TCI IQ spectrum analysis failed', error);
    } finally {
      this.analysisActive = false;
      if (this.analysisPending && generation === this.generation) {
        this.analysisPending = false;
        void this.analyzeLatest(generation);
      }
    }
  }

  private resetAnalyzer(sampleRate: number): void {
    this.analyzerRevision += 1;
    this.analyzerSampleRate = sampleRate;
    this.currentSpan = sampleRate;
    this.analyzer = this.analyzerFactory({
      sampleRate,
      fftSize: FFT_SIZE,
      outputBins: FFT_SIZE,
      windowFunction: 'hann',
      removeDc: true,
    });
    this.ringWrite = 0;
    this.ringComplexCount = 0;
  }

  private updateIfLimits(ifLimits: [number, number] | undefined): void {
    if (
      !ifLimits
      || !Number.isFinite(ifLimits[0])
      || !Number.isFinite(ifLimits[1])
      || ifLimits[1] <= ifLimits[0]
    ) return;
    this.ifLimits = [ifLimits[0], ifLimits[1]];
  }

  private resolveDisplayWindow(sampleRate: number): { minOffsetHz: number; maxOffsetHz: number } {
    const halfRate = sampleRate / 2;
    const minOffsetHz = Math.max(-halfRate, this.ifLimits?.[0] ?? -halfRate);
    const maxOffsetHz = Math.min(halfRate, this.ifLimits?.[1] ?? halfRate);
    if (maxOffsetHz <= minOffsetHz) return { minOffsetHz: -halfRate, maxOffsetHz: halfRate };
    return { minOffsetHz, maxOffsetHz };
  }

  private cropAndCompressMagnitudes(
    base64: string,
    inputLength: number,
    sampleRate: number,
    window: { minOffsetHz: number; maxOffsetHz: number },
  ): Int16Array {
    const bytes = Buffer.from(base64, 'base64');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const availableLength = Math.min(inputLength, Math.floor(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT));
    const input = new Int16Array(availableLength);
    for (let index = 0; index < availableLength; index++) input[index] = view.getInt16(index * 2, true);

    const toIndex = (offsetHz: number) => (offsetHz + sampleRate / 2) / sampleRate * availableLength;
    const start = Math.max(0, Math.min(availableLength - 1, Math.floor(toIndex(window.minOffsetHz))));
    const end = Math.max(start + 1, Math.min(availableLength, Math.ceil(toIndex(window.maxOffsetHz))));
    const selectedLength = end - start;
    const output = new Int16Array(DISPLAY_BINS);
    for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
      const binStart = start + Math.floor(outputIndex * selectedLength / output.length);
      const binEnd = start + Math.max(
        Math.floor((outputIndex + 1) * selectedLength / output.length),
        Math.floor(outputIndex * selectedLength / output.length) + 1,
      );
      let maximum = -32768;
      for (let inputIndex = binStart; inputIndex < Math.min(binEnd, end); inputIndex++) {
        maximum = Math.max(maximum, input[inputIndex] ?? -32768);
      }
      output[outputIndex] = maximum;
    }
    return output;
  }

  private logStreamParameters(frame: TciIqFrame): void {
    const displayWindow = this.resolveDisplayWindow(frame.sampleRate);
    const signature = `${frame.sampleRate}:${displayWindow.minOffsetHz}:${displayWindow.maxOffsetHz}:${frame.complexSampleCount}`;
    if (signature === this.lastStreamParametersSignature) return;
    this.lastStreamParametersSignature = signature;
    logger.info('TCI IQ stream parameters applied', {
      frameSampleRate: frame.sampleRate,
      complexSamplesPerFrame: frame.complexSampleCount,
      ifLimits: this.ifLimits,
      displayWindow,
    });
  }

  private finishSampleRateNegotiation(sampleRate: number): void {
    const pending = this.pendingSampleRateNegotiation;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSampleRateNegotiation = null;
    pending.resolve(sampleRate);
  }

  private cancelSampleRateNegotiation(error: unknown): void {
    const pending = this.pendingSampleRateNegotiation;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSampleRateNegotiation = null;
    pending.reject(error);
  }

  private isCurrentAttempt(client: TciClient, generation: number): boolean {
    return this.desiredRunning && this.client === client && this.generation === generation;
  }

  private handleDisconnected(client: TciClient, generation: number, reason?: unknown): void {
    if (this.client !== client || this.generation !== generation) return;
    this.client = null;
    this.session = null;
    this.analysisPending = false;
    this.ringWrite = 0;
    this.ringComplexCount = 0;
    this.cancelSampleRateNegotiation(new Error('TCI IQ connection disconnected'));
    logger.warn('TCI IQ connection disconnected', reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.desiredRunning || this.reconnectTimer || this.connectPromise) return;
    const delayMs = Math.min(
      this.reconnectInitialDelayMs * (2 ** this.reconnectAttempt),
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desiredRunning) return;
      this.connectPromise = this.connectStream()
        .catch((error) => {
          logger.warn('TCI IQ reconnect failed', error);
          this.scheduleReconnect();
        })
        .finally(() => {
          this.connectPromise = null;
          if (this.desiredRunning && !this.session) this.scheduleReconnect();
        });
    }, delayMs);
  }
}
