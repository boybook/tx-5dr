import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestInteractiveMicrophone,
  VOICE_KEYER_RECORDING_AUDIO_CONSTRAINTS,
  VOICE_TX_MIC_CONSTRAINTS,
} from '../audioRuntime';

function createFakeMediaStream(settings: MediaTrackSettings = {}): MediaStream {
  return {
    getAudioTracks: () => [
      {
        getSettings: () => settings,
      },
    ],
  } as unknown as MediaStream;
}

describe('audioRuntime microphone constraints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests unprocessed 16 kHz mono audio for realtime voice TX', () => {
    expect(VOICE_TX_MIC_CONSTRAINTS).toEqual({
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it('requests unprocessed mono audio for voice keyer recording without forcing sample rate', () => {
    expect(VOICE_KEYER_RECORDING_AUDIO_CONSTRAINTS).toEqual({
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(VOICE_KEYER_RECORDING_AUDIO_CONSTRAINTS).not.toHaveProperty('sampleRate');
  });

  it('passes microphone constraints to getUserMedia', async () => {
    const stream = createFakeMediaStream({
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    });

    await expect(requestInteractiveMicrophone(VOICE_TX_MIC_CONSTRAINTS)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: VOICE_TX_MIC_CONSTRAINTS,
      video: false,
    });
  });

  it('reuses an existing media stream without requesting microphone permission again', async () => {
    const stream = createFakeMediaStream();
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    });

    await expect(requestInteractiveMicrophone(VOICE_TX_MIC_CONSTRAINTS, stream)).resolves.toBe(stream);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
