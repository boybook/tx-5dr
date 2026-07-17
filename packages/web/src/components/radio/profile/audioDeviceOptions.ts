import type { AudioDevice, AudioDeviceSettings } from '@tx5dr/contracts';

export const FALLBACK_SAMPLE_RATE_OPTIONS = [8000, 12000, 16000, 22050, 24000, 44100, 48000, 96000];
export const FALLBACK_BUFFER_SIZE_OPTIONS = [128, 256, 512, 768, 1024, 2048, 4096];

export interface NumberOptionState {
  values: number[];
  isFallback: boolean;
  isCurrentUnsupported: boolean;
}

export function isVirtualAudioDevice(device: AudioDevice | null | undefined): boolean {
  return Boolean(
    device?.transport === 'virtual'
    || device?.kind === 'virtual'
    || device?.id.startsWith('icom-wlan-')
    || device?.id.startsWith('openwebrx-')
    || device?.id.startsWith('tci-'),
  );
}

export type AudioDeviceControl = 'sampleRate' | 'bufferSize' | 'sampleFormat' | 'channelMode';

export function isAudioDeviceControlConfigurable(
  device: AudioDevice | null | undefined,
  control: AudioDeviceControl,
): boolean {
  if (!device || isVirtualAudioDevice(device)) return false;
  const capabilities = device.capabilities;
  if (!capabilities) return true;

  switch (control) {
    case 'sampleRate':
      return capabilities.sampleRateConfigurable !== false && capabilities.fixedSampleRate === undefined;
    case 'bufferSize':
      return capabilities.bufferSizeConfigurable !== false && capabilities.fixedBufferSize === undefined;
    case 'sampleFormat':
      return capabilities.sampleFormatConfigurable !== false;
    case 'channelMode':
      return capabilities.channelModeConfigurable !== false && capabilities.fixedChannelCount !== 1;
  }
}

export function getFixedAudioDeviceNumber(
  device: AudioDevice | null | undefined,
  control: 'sampleRate' | 'bufferSize',
): number | undefined {
  if (!device) return undefined;
  if (control === 'sampleRate') {
    return device.capabilities?.fixedSampleRate
      ?? (device.capabilities?.sampleRateConfigurable === false
        ? device.capabilities.sampleRates?.[0] ?? device.sampleRate
        : undefined);
  }
  return device.capabilities?.fixedBufferSize
    ?? (device.capabilities?.bufferSizeConfigurable === false
      ? device.capabilities.bufferSizes?.[0]
      : undefined);
}

export function resolveAudioSettingNumber(
  settings: AudioDeviceSettings | undefined,
  field: 'inputSampleRate' | 'outputSampleRate' | 'inputBufferSize' | 'outputBufferSize',
  legacyField: 'sampleRate' | 'bufferSize',
  fallback: number,
): number {
  return settings?.[field] ?? settings?.[legacyField] ?? fallback;
}

export function deriveSampleRateOptions(
  device: AudioDevice | null | undefined,
  currentValue: number,
  fallbackValues: number[] = FALLBACK_SAMPLE_RATE_OPTIONS,
): NumberOptionState {
  const deviceRates = normalizeNumberOptions(device?.capabilities?.sampleRates ?? device?.sampleRates);
  const baseValues = deviceRates.length > 0 ? deviceRates : normalizeNumberOptions(fallbackValues);
  const isCurrentUnsupported = deviceRates.length > 0 && !deviceRates.includes(currentValue);
  const values = !baseValues.includes(currentValue)
    ? normalizeNumberOptions([...baseValues, currentValue])
    : baseValues;

  return {
    values,
    isFallback: deviceRates.length === 0,
    isCurrentUnsupported,
  };
}

export function deriveBufferSizeOptions(
  values: number[],
  currentValue: number,
  fallbackValues: number[] = FALLBACK_BUFFER_SIZE_OPTIONS,
): NumberOptionState {
  const backendValues = normalizeNumberOptions(values);
  const baseValues = backendValues.length > 0 ? backendValues : normalizeNumberOptions(fallbackValues);
  const isCurrentUnsupported = backendValues.length > 0 && !backendValues.includes(currentValue);
  const resolvedValues = !baseValues.includes(currentValue)
    ? normalizeNumberOptions([...baseValues, currentValue])
    : baseValues;

  return {
    values: resolvedValues,
    isFallback: backendValues.length === 0,
    isCurrentUnsupported,
  };
}

export function normalizeNumberOptions(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(
    values
      .map((value) => Math.round(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0),
  )).sort((a, b) => a - b);
}
