import { createLogger } from '../utils/logger';

const logger = createLogger('audioRuntime');

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
  constraints: MediaTrackConstraints,
  existing?: MediaStream | null,
): Promise<MediaStream> {
  if (existing) {
    return existing;
  }

  return navigator.mediaDevices.getUserMedia({
    audio: constraints,
    video: false,
  });
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
