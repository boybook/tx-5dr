import { EventEmitter } from 'eventemitter3';
import { describe, expect, it } from 'vitest';
import { CWDecoderManager } from '../CWDecoderManager.js';
import { DEFAULT_CW_DECODER_CONFIG, type CWDecoderBackend, type CWDecoderBackendEvents, type CWDecoderConfig, type CWDecoderStatus } from '../types.js';

class MockBackend extends EventEmitter<CWDecoderBackendEvents> implements CWDecoderBackend {
  readonly id = 'deepcw-onnx' as const;
  startCalls = 0;
  stopCalls = 0;
  pushedChunks = 0;
  private status: CWDecoderStatus = {
    enabled: true,
    backend: 'deepcw-onnx',
    state: 'stopped',
    backendAvailable: false,
    backendError: null,
    lastPendingText: '',
    lastCommittedText: '',
    lastDecodeAt: null,
    queuedSamples: 0,
    muted: false,
  };

  async start(config: CWDecoderConfig): Promise<void> {
    this.startCalls += 1;
    this.status = { ...this.status, enabled: config.enabled, state: 'running', backendAvailable: true, backendError: null };
    this.emit('status', this.getStatus());
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.status = { ...this.status, state: 'stopped', backendAvailable: false };
    this.emit('status', this.getStatus());
  }

  async updateConfig(config: CWDecoderConfig): Promise<void> {
    await this.start(config);
  }

  clearTranscript(): void {
    this.status = { ...this.status, lastPendingText: '', lastCommittedText: '', queuedSamples: 0 };
    this.emit('status', this.getStatus());
  }

  pushAudio(): void {
    this.pushedChunks += 1;
  }

  getStatus(): CWDecoderStatus {
    return { ...this.status };
  }

  getTelemetrySnapshot() {
    return {
      status: this.status.state === 'running' ? 'running' as const : 'stopped' as const,
      workerCount: 1,
      jobsStarted: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      inFlight: 0,
      lastError: null,
    };
  }
}

describe('CWDecoderManager', () => {
  it('starts and stops the selected backend', async () => {
    const backend = new MockBackend();
    const manager = new CWDecoderManager({
      initialConfig: { enabled: true },
      backends: { 'deepcw-onnx': backend },
    });

    await manager.start();
    expect(backend.startCalls).toBe(1);
    expect(manager.getStatus()).toMatchObject({ state: 'running', backendAvailable: true });

    manager.pushAudio(new Float32Array([0.1, 0.2]), DEFAULT_CW_DECODER_CONFIG.inputSampleRate);
    expect(backend.pushedChunks).toBe(1);

    await manager.stop('test');
    expect(backend.stopCalls).toBe(1);
    expect(manager.getStatus()).toMatchObject({ state: 'stopped', backendAvailable: false });
  });

  it('forwards pending and commit events from the backend', async () => {
    const backend = new MockBackend();
    const manager = new CWDecoderManager({ initialConfig: { enabled: true }, backends: { 'deepcw-onnx': backend } });
    const pending: string[] = [];
    const commits: string[] = [];
    manager.on('cwDecoderPending', (event) => pending.push(event.text));
    manager.on('cwDecoderCommit', (event) => commits.push(event.text));

    await manager.start();
    backend.emit('pending', { type: 'pending', backend: 'deepcw-onnx', text: 'CQ', confidence: 0.9, timestamp: 1 });
    backend.emit('commit', { type: 'commit', id: 'seg-1', backend: 'deepcw-onnx', text: 'CQ', confidence: 0.9, timestamp: 2 });

    expect(pending).toEqual(['CQ']);
    expect(commits).toEqual(['CQ']);
  });

  it('clears backend transcript state', async () => {
    const backend = new MockBackend();
    const manager = new CWDecoderManager({ initialConfig: { enabled: true }, backends: { 'deepcw-onnx': backend } });
    await manager.start();
    backend.emit('status', {
      ...backend.getStatus(),
      lastPendingText: 'CQ',
      lastCommittedText: 'CQ TEST',
      queuedSamples: 1200,
    });

    const status = manager.clearTranscript();

    expect(status).toMatchObject({ lastPendingText: '', lastCommittedText: '', queuedSamples: 0 });
  });

  it('subscribes to the normalized 12 kHz audio stream only', async () => {
    const backend = new MockBackend();
    const manager = new CWDecoderManager({ initialConfig: { enabled: true }, backends: { 'deepcw-onnx': backend } });
    const stream = new EventEmitter();
    manager.attachAudioStream(stream as never);

    await manager.start();
    stream.emit('nativeAudioInputData', {
      samples: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      sampleRate: 48_000,
      channels: 1,
      timestamp: 1,
      sequence: 1,
      sourceKind: 'audio-device',
    });
    stream.emit('audioData', new Float32Array([0.1, 0.2]));

    expect(backend.pushedChunks).toBe(1);
  });
});
