import audify from 'audify';
import { createLogger } from '../utils/logger.js';

const { RtAudio } = audify;
export type RtAudioInstance = InstanceType<typeof RtAudio>;

// RtAudioApi values from audify (const enum not importable under isolatedModules)
export const RTAUDIO_API_UNSPECIFIED = 0;
export const RTAUDIO_API_LINUX_ALSA = 2;
export const RTAUDIO_API_UNIX_JACK = 3;
export const RTAUDIO_API_LINUX_PULSE = 4;
export const RTAUDIO_API_WINDOWS_WASAPI = 7;

type RtAudioBackendName = 'auto' | 'pulse' | 'pipewire' | 'alsa' | 'jack' | 'wasapi' | 'unspecified';

type LoggerLike = Pick<ReturnType<typeof createLogger>, 'debug' | 'info' | 'warn'>;

const logger = createLogger('RtAudioApi');
let cachedApi: number | null = null;
let cachedDescription: string | null = null;

const API_DISPLAY_NAMES: Record<number, string> = {
  [RTAUDIO_API_UNSPECIFIED]: 'auto',
  [RTAUDIO_API_LINUX_ALSA]: 'ALSA',
  [RTAUDIO_API_UNIX_JACK]: 'JACK',
  [RTAUDIO_API_LINUX_PULSE]: 'PulseAudio/PipeWire',
  [RTAUDIO_API_WINDOWS_WASAPI]: 'WASAPI',
};

function normalizeBackendName(value: string | undefined): RtAudioBackendName {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'pulse' || normalized === 'pulseaudio') return 'pulse';
  if (normalized === 'pipewire' || normalized === 'pw') return 'pipewire';
  if (normalized === 'alsa') return 'alsa';
  if (normalized === 'jack') return 'jack';
  if (normalized === 'wasapi') return 'wasapi';
  if (normalized === 'unspecified' || normalized === 'rtaudio') return 'unspecified';
  return 'auto';
}

function getConfiguredBackendName(): RtAudioBackendName {
  return normalizeBackendName(
    process.env.TX5DR_RTAUDIO_API
    || process.env.TX5DR_AUDIO_BACKEND
    || process.env.RTAUDIO_API,
  );
}

function expectedApiForBackend(backend: RtAudioBackendName): number | null {
  switch (backend) {
    case 'pulse':
    case 'pipewire':
      return RTAUDIO_API_LINUX_PULSE;
    case 'alsa':
      return RTAUDIO_API_LINUX_ALSA;
    case 'jack':
      return RTAUDIO_API_UNIX_JACK;
    case 'wasapi':
      return RTAUDIO_API_WINDOWS_WASAPI;
    case 'unspecified':
      return RTAUDIO_API_UNSPECIFIED;
    case 'auto':
    default:
      return null;
  }
}

function getActualApiName(instance: RtAudioInstance): string | null {
  const maybeGetApi = (instance as unknown as { getApi?: () => string }).getApi;
  if (typeof maybeGetApi !== 'function') return null;
  try {
    return maybeGetApi.call(instance);
  } catch {
    return null;
  }
}

function getDeviceCount(instance: RtAudioInstance): number {
  try {
    return instance.getDevices().length;
  } catch {
    return 0;
  }
}

function isRequestedApiActive(requestedApi: number, actualApi: string | null): boolean {
  if (requestedApi === RTAUDIO_API_UNSPECIFIED) return true;
  if (!actualApi) return true;
  const normalized = actualApi.toLowerCase();
  switch (requestedApi) {
    case RTAUDIO_API_LINUX_PULSE:
      return normalized.includes('pulse');
    case RTAUDIO_API_LINUX_ALSA:
      return normalized.includes('alsa');
    case RTAUDIO_API_UNIX_JACK:
      return normalized.includes('jack');
    case RTAUDIO_API_WINDOWS_WASAPI:
      return normalized.includes('wasapi');
    default:
      return true;
  }
}

function instantiate(api: number): RtAudioInstance {
  return new RtAudio(api);
}

function chooseLinuxAutoApi(log: LoggerLike): number {
  // Prefer the sound-server layer first. On PipeWire systems, PulseAudio
  // compatibility exposes the shared PipeWire graph and avoids ALSA hw busy
  // false-negatives during device probing.
  const candidates = [
    RTAUDIO_API_LINUX_PULSE,
    RTAUDIO_API_LINUX_ALSA,
    RTAUDIO_API_UNIX_JACK,
    RTAUDIO_API_UNSPECIFIED,
  ];

  for (const api of candidates) {
    try {
      const instance = instantiate(api);
      const actualApi = getActualApiName(instance) ?? API_DISPLAY_NAMES[api] ?? String(api);
      const count = getDeviceCount(instance);
      log.debug('Probed RtAudio backend candidate', {
        requestedApi: API_DISPLAY_NAMES[api] ?? api,
        actualApi,
        deviceCount: count,
      });
      if (count > 0 && isRequestedApiActive(api, actualApi)) {
        return api;
      }
    } catch (error) {
      log.debug('RtAudio backend candidate failed', {
        requestedApi: API_DISPLAY_NAMES[api] ?? api,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return RTAUDIO_API_UNSPECIFIED;
}

function chooseRtAudioApi(log: LoggerLike): number {
  if (process.platform === 'win32') {
    return RTAUDIO_API_WINDOWS_WASAPI;
  }

  const configuredBackend = getConfiguredBackendName();
  const explicitApi = expectedApiForBackend(configuredBackend);
  if (explicitApi !== null) {
    return explicitApi;
  }

  if (process.platform === 'linux') {
    return chooseLinuxAutoApi(log);
  }

  return RTAUDIO_API_UNSPECIFIED;
}

export function resetRtAudioApiSelectionForTests(): void {
  cachedApi = null;
  cachedDescription = null;
}

export function getSelectedRtAudioApi(log: LoggerLike = logger): number {
  if (cachedApi === null) {
    cachedApi = chooseRtAudioApi(log);
    cachedDescription = API_DISPLAY_NAMES[cachedApi] ?? String(cachedApi);
    log.info('Selected RtAudio backend', {
      backend: cachedDescription,
      configured: getConfiguredBackendName(),
      platform: process.platform,
    });
  }

  return cachedApi;
}

export function describeConfiguredRtAudioBackend(): string {
  if (cachedDescription) return cachedDescription;
  const configuredBackend = getConfiguredBackendName();
  const explicitApi = expectedApiForBackend(configuredBackend);
  if (explicitApi !== null) return API_DISPLAY_NAMES[explicitApi] ?? String(explicitApi);
  if (process.platform === 'linux') return 'auto (PulseAudio/PipeWire preferred)';
  if (process.platform === 'win32') return 'WASAPI';
  return 'auto';
}

export function createRtAudioInstance(options: {
  logger?: LoggerLike;
  purpose?: string;
} = {}): RtAudioInstance {
  const log = options.logger ?? logger;
  const api = getSelectedRtAudioApi(log);
  const instance = instantiate(api);
  const actualApi = getActualApiName(instance);
  log.debug('Created RtAudio instance', {
    purpose: options.purpose,
    requestedApi: API_DISPLAY_NAMES[api] ?? api,
    actualApi,
  });
  return instance;
}
