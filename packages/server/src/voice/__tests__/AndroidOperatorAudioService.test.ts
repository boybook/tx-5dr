import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoicePTTLock } from '@tx5dr/contracts';
import type { AndroidAudioDeviceDescriptor } from '../../audio/android-audio-devices.js';
import type { AndroidAudioInputSocket, AndroidAudioOutputSocket } from '../../audio/AndroidAudioSocketBackend.js';
import type { RealtimeAudioFrame, RealtimeRxAudioSource, RealtimeRxAudioSourceStats } from '../../realtime/RealtimeRxAudioSource.js';
import { AndroidOperatorAudioService } from '../AndroidOperatorAudioService.js';

class FakeInputSocket extends EventEmitter<{ audioData: (samples: Float32Array, sampleRate: number) => void; error: (error: Error) => void; close: () => void }> {
  started = false;
  stopped = false;
  async start(): Promise<void> { this.started = true; }
  stop(): void { this.stopped = true; }
}

class FakeOutputSocket {
  started = false;
  stopped = false;
  writes: Float32Array[] = [];
  async start(): Promise<void> { this.started = true; }
  stop(): void { this.stopped = true; }
  async write(samples: Float32Array): Promise<boolean> {
    this.writes.push(new Float32Array(samples));
    return true;
  }
}

class FakeRxSource extends EventEmitter<{ audioFrame: (frame: RealtimeAudioFrame) => void }> implements RealtimeRxAudioSource {
  readonly id = 'fake-radio';
  readonly sourcePath = 'native-radio' as const;
  getLatestStats(): RealtimeRxAudioSourceStats | null { return null; }
}

function writeManifest(): void {
  const dir = mkdtempSync(join(tmpdir(), 'tx5dr-android-operator-audio-'));
  const manifest = join(dir, 'android-audio-devices.json');
  writeFileSync(manifest, JSON.stringify({
    inputDevices: [
      device('android-input-usb', 'USB mic', 'input', 'usb', '/tmp/usb-in.sock'),
      device('android-input-phone', 'Phone microphone', 'input', 'builtinMic', '/tmp/phone-in.sock'),
    ],
    outputDevices: [
      device('android-output-usb', 'USB speaker', 'output', 'usb', '/tmp/usb-out.sock'),
      device('android-output-phone', 'Phone speaker', 'output', 'builtinSpeaker', '/tmp/phone-out.sock'),
    ],
  }));
  process.env.TX5DR_RUNTIME_FLAVOR = 'android-bridge';
  process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = manifest;
}

function device(
  id: string,
  name: string,
  direction: 'input' | 'output',
  kind: string,
  socketPath: string,
): AndroidAudioDeviceDescriptor {
  return {
    id,
    androidDeviceId: id.endsWith('phone') ? 2 : 1,
    name,
    direction,
    kind,
    channels: 1,
    sampleRate: 48000,
    sampleRates: [48000],
    format: 's16le',
    formats: ['s16le', 'f32le'],
    socketPath,
    available: true,
    isDefault: kind === 'usb',
  };
}

function createHarness() {
  const input = new FakeInputSocket();
  const output = new FakeOutputSocket();
  const source = new FakeRxSource();
  let activeVoiceAudioClientId: string | null = null;
  const voice = new EventEmitter<{ voicePttLockChanged: (lock: VoicePTTLock) => void }>() as any;
  voice.handleParticipantAudioFrame = vi.fn(async () => {});
  voice.getActiveVoiceAudioClientId = vi.fn(() => activeVoiceAudioClientId);
  voice.getPTTLockState = vi.fn(() => ({
    locked: activeVoiceAudioClientId !== null,
    lockedBy: activeVoiceAudioClientId ? 'client-1' : null,
    lockedByLabel: activeVoiceAudioClientId ? 'Operator' : null,
    lockedAt: activeVoiceAudioClientId ? Date.now() : null,
    timeoutMs: 180000,
  }));
  const router = { resolveSource: vi.fn(() => source) } as any;
  const service = new AndroidOperatorAudioService({
    voiceSessionManager: voice,
    rxAudioRouter: router,
    inputSocketFactory: () => input as unknown as AndroidAudioInputSocket,
    outputSocketFactory: () => output as unknown as AndroidAudioOutputSocket,
  });
  return {
    service,
    input,
    output,
    source,
    voice,
    setActiveVoiceAudioClientId: (value: string | null) => { activeVoiceAudioClientId = value; },
  };
}

describe('AndroidOperatorAudioService', () => {
  const originalFlavor = process.env.TX5DR_RUNTIME_FLAVOR;
  const originalManifest = process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE;
  const originalMicGain = process.env.TX5DR_ANDROID_OPERATOR_MIC_GAIN_DB;

  beforeEach(() => {
    writeManifest();
    delete process.env.TX5DR_ANDROID_OPERATOR_MIC_GAIN_DB;
  });

  afterEach(() => {
    process.env.TX5DR_RUNTIME_FLAVOR = originalFlavor;
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = originalManifest;
    if (originalMicGain === undefined) {
      delete process.env.TX5DR_ANDROID_OPERATOR_MIC_GAIN_DB;
    } else {
      process.env.TX5DR_ANDROID_OPERATOR_MIC_GAIN_DB = originalMicGain;
    }
  });

  it('selects builtin phone devices instead of USB defaults', () => {
    const { service } = createHarness();
    const status = service.getStatus();
    expect(status.available).toBe(true);
    expect(status.micDevice?.kind).toBe('builtinMic');
    expect(status.speakerDevice?.kind).toBe('builtinSpeaker');
  });

  it('updates input level without forwarding frames when native PTT is not active', async () => {
    const { service, input, voice } = createHarness();
    await service.prepare();
    input.emit('audioData', new Float32Array(960).fill(0.01), 48000);
    const status = service.getStatus();
    expect(status.rawInputLevel ?? 0).toBeGreaterThan(0);
    expect(status.inputLevel).toBeGreaterThan(status.rawInputLevel ?? 0);
    expect(voice.handleParticipantAudioFrame).not.toHaveBeenCalled();
  });

  it('forwards fixed capture frames when PTT identity matches native participant', async () => {
    const { service, input, voice, setActiveVoiceAudioClientId } = createHarness();
    await service.prepare();
    setActiveVoiceAudioClientId('android-native:operator');
    input.emit('audioData', new Float32Array(960).fill(0.25), 48000);
    await vi.waitFor(() => expect(voice.handleParticipantAudioFrame).toHaveBeenCalledTimes(1));
    expect(voice.handleParticipantAudioFrame.mock.calls[0][0].transport).toBe('android-native');
  });

  it('applies bounded native microphone boost before forwarding TX frames', async () => {
    process.env.TX5DR_ANDROID_OPERATOR_MIC_GAIN_DB = '6';
    const { service, input, voice, setActiveVoiceAudioClientId } = createHarness();
    await service.prepare();
    setActiveVoiceAudioClientId('android-native:operator');
    input.emit('audioData', new Float32Array(960).fill(0.25), 48000);

    await vi.waitFor(() => expect(voice.handleParticipantAudioFrame).toHaveBeenCalledTimes(1));
    const forwarded = voice.handleParticipantAudioFrame.mock.calls[0][1] as Float32Array;
    expect(forwarded[0]).toBeCloseTo(0.25 * Math.pow(10, 6 / 20), 5);
  });

  it('updates native microphone gain at runtime', async () => {
    const { service, input, voice, setActiveVoiceAudioClientId } = createHarness();
    await service.prepare();
    const status = service.setMicGainDb(3);
    expect(status.micGainDb).toBe(3);
    setActiveVoiceAudioClientId('android-native:operator');
    input.emit('audioData', new Float32Array(960).fill(0.25), 48000);

    await vi.waitFor(() => expect(voice.handleParticipantAudioFrame).toHaveBeenCalledTimes(1));
    const forwarded = voice.handleParticipantAudioFrame.mock.calls[0][1] as Float32Array;
    expect(forwarded[0]).toBeCloseTo(0.25 * Math.pow(10, 3 / 20), 5);
    expect(service.setMicGainDb(99).micGainDb).toBe(24);
  });

  it('clips native microphone boost to avoid overflowing TX PCM', async () => {
    process.env.TX5DR_ANDROID_OPERATOR_MIC_GAIN_DB = '24';
    const { service, input, voice, setActiveVoiceAudioClientId } = createHarness();
    await service.prepare();
    setActiveVoiceAudioClientId('android-native:operator');
    input.emit('audioData', new Float32Array(960).fill(0.5), 48000);

    await vi.waitFor(() => expect(voice.handleParticipantAudioFrame).toHaveBeenCalledTimes(1));
    const forwarded = voice.handleParticipantAudioFrame.mock.calls[0][1] as Float32Array;
    expect(forwarded[0]).toBe(1);
  });

  it('writes radio monitor frames to the builtin speaker socket and pauses while PTT is active', async () => {
    const { service, output, source, setActiveVoiceAudioClientId, voice } = createHarness();
    await service.startMonitor();
    source.emit('audioFrame', { samples: new Float32Array([0.1, 0.2]), sampleRate: 48000, channels: 1, timestamp: Date.now(), sequence: 1, sourceKind: 'native-radio' });
    await vi.waitFor(() => expect(output.writes).toHaveLength(1));

    setActiveVoiceAudioClientId('android-native:operator');
    voice.emit('voicePttLockChanged', { locked: true, lockedBy: 'client-1', lockedByLabel: 'Operator', lockedAt: Date.now(), timeoutMs: 180000 });
    source.emit('audioFrame', { samples: new Float32Array([0.3, 0.4]), sampleRate: 48000, channels: 1, timestamp: Date.now(), sequence: 2, sourceKind: 'native-radio' });
    expect(output.writes).toHaveLength(1);

    setActiveVoiceAudioClientId(null);
    voice.emit('voicePttLockChanged', { locked: false, lockedBy: null, lockedByLabel: null, lockedAt: null, timeoutMs: 180000 });
    source.emit('audioFrame', { samples: new Float32Array([0.5, 0.6]), sampleRate: 48000, channels: 1, timestamp: Date.now(), sequence: 3, sourceKind: 'native-radio' });
    await vi.waitFor(() => expect(output.writes).toHaveLength(2));
  });
});
