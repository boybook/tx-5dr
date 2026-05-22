import { createLogger } from '../utils/logger';

const logger = createLogger('audioRuntime');

export type AudioTrackConstraints = {
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

export const BROWSER_RADIO_AUDIO_PROCESSING_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} satisfies AudioTrackConstraints;

export const VOICE_TX_MIC_CONSTRAINTS = {
  sampleRate: 16000,
  channelCount: 1,
  ...BROWSER_RADIO_AUDIO_PROCESSING_CONSTRAINTS,
} satisfies AudioTrackConstraints;

export const VOICE_KEYER_RECORDING_AUDIO_CONSTRAINTS = {
  channelCount: 1,
  ...BROWSER_RADIO_AUDIO_PROCESSING_CONSTRAINTS,
} satisfies AudioTrackConstraints;

export async function ensureInteractiveAudioContext(existing?: AudioContext | null): Promise<AudioContext> {
  const audioContext = existing ?? new AudioContext({
    latencyHint: 'interactive',
  });

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  return audioContext;
}

export async function closeAudioContext(audioContext?: AudioContext | null): Promise<void> {
  if (!audioContext) {
    return;
  }

  try {
    await audioContext.close();
  } catch (error) {
    logger.debug('Failed to close audio context cleanly', error);
  }
}

export async function requestInteractiveMicrophone(
  constraints: AudioTrackConstraints,
  existing?: MediaStream | null,
): Promise<MediaStream> {
  if (existing) {
    return existing;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: constraints,
    video: false,
  });

  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings();
  logger.debug('Microphone capture constraints applied', {
    requested: constraints,
    actual: settings
      ? {
          sampleRate: settings.sampleRate,
          channelCount: settings.channelCount,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
        }
      : null,
  });

  return stream;
}

export function stopMediaStream(stream?: MediaStream | null): void {
  if (!stream) {
    return;
  }

  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // ignore
    }
  });
}
