import { createLogger } from './logger';

const logger = createLogger('androidAudioBridge');

export interface AndroidAudioEnvironmentProbe {
  ok?: boolean;
  reason?: string;
  active?: boolean;
  activeReasons?: string[];
  sdk?: number;
  route?: string | null;
  isSecureContext?: boolean;
  hasMediaDevices?: boolean;
  hasGetUserMedia?: boolean;
  origin?: string;
}

interface AndroidAudioBridgeApi {
  nativeOperatorAudio?: boolean;
  enterVoiceAudio(reason?: string): AndroidAudioEnvironmentProbe;
  leaveVoiceAudio(reason?: string): AndroidAudioEnvironmentProbe;
  probeAudioEnvironment(): AndroidAudioEnvironmentProbe;
}

declare global {
  interface Window {
    Tx5drAndroidAudio?: AndroidAudioBridgeApi;
  }
}

function bridge(): AndroidAudioBridgeApi | null {
  return typeof window !== 'undefined' ? window.Tx5drAndroidAudio ?? null : null;
}

export function enterAndroidVoiceAudio(reason: string): AndroidAudioEnvironmentProbe | null {
  const api = bridge();
  if (!api) return null;
  try {
    const result = api.enterVoiceAudio(reason);
    if (result?.ok === false) {
      logger.warn('Android WebView audio route was not accepted', result);
    } else {
      logger.debug('Android WebView audio route entered', result);
    }
    return result;
  } catch (error) {
    logger.warn('Failed to enter Android WebView audio route', error);
    return null;
  }
}

export function leaveAndroidVoiceAudio(reason: string): AndroidAudioEnvironmentProbe | null {
  const api = bridge();
  if (!api) return null;
  try {
    const result = api.leaveVoiceAudio(reason);
    logger.debug('Android WebView audio route left', result);
    return result;
  } catch (error) {
    logger.debug('Failed to leave Android WebView audio route', error);
    return null;
  }
}

export function probeAndroidAudioEnvironment(): AndroidAudioEnvironmentProbe | null {
  const api = bridge();
  if (!api) return null;
  try {
    return api.probeAudioEnvironment();
  } catch (error) {
    logger.debug('Failed to probe Android WebView audio environment', error);
    return null;
  }
}

export function hasAndroidNativeOperatorAudio(): boolean {
  return bridge()?.nativeOperatorAudio === true;
}
