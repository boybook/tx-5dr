import { describe, expect, it, vi } from 'vitest';
import { VoiceTxDiagnostics } from '../VoiceTxDiagnostics.js';

describe('VoiceTxDiagnostics', () => {
  it('tracks ingress and output metrics for an active session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'));

    const diagnostics = new VoiceTxDiagnostics();
    diagnostics.startSession('conn_1', 'tester');

    diagnostics.noteIngress({
      transport: 'ws-compat',
      participantIdentity: 'compat-send:test',
      sequence: 1,
      clientSentAtMs: Date.now() - 12,
      serverReceivedAtMs: Date.now(),
      sampleRate: 16000,
      samplesPerChannel: 320,
    });
    diagnostics.noteQueueState(2, 40);
    diagnostics.noteProcessed({
      meta: {
        transport: 'ws-compat',
        participantIdentity: 'compat-send:test',
        sequence: 1,
        clientSentAtMs: Date.now() - 12,
        serverReceivedAtMs: Date.now(),
        sampleRate: 16000,
        samplesPerChannel: 320,
      },
      queueDepthFrames: 1,
      queuedAudioMs: 20,
      resampleMs: 3,
      queueWaitMs: 28,
      writeMs: 4,
      endToEndMs: 36,
      outputBufferedMs: 24,
      outputSampleRate: 48000,
      outputBufferSize: 768,
    });

    const snapshot = diagnostics.getSnapshot();
    expect(snapshot.summary.active).toBe(true);
    expect(snapshot.summary.transport).toBe('ws-compat');
    expect(snapshot.transport.receivedFrames).toBe(1);
    expect(snapshot.transport.clientToServerMs.current).toBe(12);
    expect(snapshot.serverIngress.queueDepthFrames).toBe(1);
    expect(snapshot.serverOutput.queueWaitMs.current).toBe(28);
    expect(snapshot.serverOutput.outputBufferedMs.current).toBe(24);
    expect(snapshot.serverOutput.outputBufferSize).toBe(768);
    expect(snapshot.summary.bottleneckStage).toBe('server-queue');

    vi.useRealTimers();
  });

  it('preserves the last snapshot after the session ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T00:00:10.000Z'));

    const diagnostics = new VoiceTxDiagnostics();
    diagnostics.startSession('conn_2', 'tester');
    diagnostics.noteIngress({
      transport: 'livekit',
      participantIdentity: 'livekit-send:test',
      sequence: null,
      clientSentAtMs: null,
      serverReceivedAtMs: Date.now(),
      sampleRate: 16000,
      samplesPerChannel: 320,
    });
    diagnostics.endSession();

    const snapshot = diagnostics.getSnapshot();
    expect(snapshot.summary.active).toBe(false);
    expect(snapshot.summary.clientId).toBe('conn_2');
    expect(snapshot.summary.transport).toBe('livekit');
    expect(snapshot.transport.receivedFrames).toBe(1);

    vi.useRealTimers();
  });
});
