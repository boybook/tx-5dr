export type BrowserAudioRuntimeFamily = 'safari-webkit' | 'chromium' | 'firefox' | 'unknown';

export interface BrowserAudioRuntimeInfo {
  family: BrowserAudioRuntimeFamily;
  label: string;
  audioWorkletSupported: boolean;
}

function getUserAgent(): string {
  if (typeof navigator === 'undefined') {
    return '';
  }
  return navigator.userAgent || '';
}

export function detectBrowserAudioRuntime(): BrowserAudioRuntimeInfo {
  const userAgent = getUserAgent();
  const lower = userAgent.toLowerCase();
  const audioWorkletSupported = typeof AudioWorkletNode !== 'undefined';
  const isChromium = /(chrome|chromium|crios|edg|edge|opr)/i.test(userAgent);
  const isFirefox = /(firefox|fxios)/i.test(userAgent);
  const isSafari = /safari/i.test(userAgent) && !isChromium && !isFirefox;

  if (isSafari) {
    return {
      family: 'safari-webkit',
      label: 'Safari/WebKit',
      audioWorkletSupported,
    };
  }

  if (isChromium) {
    return {
      family: 'chromium',
      label: 'Chromium',
      audioWorkletSupported,
    };
  }

  if (isFirefox) {
    return {
      family: 'firefox',
      label: 'Firefox',
      audioWorkletSupported,
    };
  }

  return {
    family: 'unknown',
    label: lower.length > 0 ? 'Unknown Browser' : 'Unknown Runtime',
    audioWorkletSupported,
  };
}

export function isAudioWorkletSupported(audioContext: AudioContext | null | undefined): boolean {
  return Boolean(
    audioContext
    && typeof AudioWorkletNode !== 'undefined'
    && 'audioWorklet' in audioContext
    && audioContext.audioWorklet
    && typeof audioContext.audioWorklet.addModule === 'function',
  );
}
