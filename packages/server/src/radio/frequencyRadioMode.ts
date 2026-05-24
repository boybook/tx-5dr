import type { DigitalModeRadioModePreference } from '@tx5dr/contracts';
import type { ApplyOperatingStateRequest, SetRadioModeOptions } from './connections/IRadioConnection.js';

type EngineMode = 'digital' | 'voice' | 'cw';

export interface FrequencyRadioModeResolution {
  displayRadioMode?: string;
  writeRadioMode?: string;
  modeOptions?: SetRadioModeOptions;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDigitalAppMode(mode: string | undefined): boolean {
  const normalized = mode?.trim().toUpperCase();
  return normalized === 'FT8' || normalized === 'FT4';
}

export function normalizeDigitalModeRadioModePreference(
  value: unknown,
): DigitalModeRadioModePreference {
  return value === 'usb' || value === 'usb-data' ? value : 'none';
}

export function inferModeOptions(
  appMode: string | undefined,
  engineMode: EngineMode,
): SetRadioModeOptions {
  const normalizedAppMode = appMode?.trim().toUpperCase();

  if (normalizedAppMode === 'VOICE') {
    return { intent: 'voice' };
  }

  if (normalizedAppMode === 'FT8' || normalizedAppMode === 'FT4') {
    return { intent: 'digital' };
  }

  return { intent: engineMode === 'voice' ? 'voice' : engineMode === 'cw' ? 'cw' : 'digital' };
}

export function resolveFrequencyRadioMode({
  effectiveMode,
  requestedRadioMode,
  engineMode,
  digitalModeRadioMode,
}: {
  effectiveMode?: string;
  requestedRadioMode?: string;
  engineMode: EngineMode;
  digitalModeRadioMode?: DigitalModeRadioModePreference | null;
}): FrequencyRadioModeResolution {
  if (isDigitalAppMode(effectiveMode)) {
    switch (normalizeDigitalModeRadioModePreference(digitalModeRadioMode)) {
      case 'usb':
        return {
          displayRadioMode: 'USB',
          writeRadioMode: 'USB',
          modeOptions: { intent: 'voice' },
        };
      case 'usb-data':
        return {
          displayRadioMode: 'USB-DATA',
          writeRadioMode: 'USB',
          modeOptions: { intent: 'digital' },
        };
      case 'none':
      default:
        return {};
    }
  }

  if (!hasNonEmptyString(requestedRadioMode)) {
    return {};
  }

  const normalizedRadioMode = requestedRadioMode.trim();
  return {
    displayRadioMode: normalizedRadioMode,
    writeRadioMode: normalizedRadioMode,
    modeOptions: inferModeOptions(effectiveMode, engineMode),
  };
}

export function buildFrequencyOperatingStateRequest({
  frequency,
  radioMode,
  effectiveMode,
  engineMode,
  digitalModeRadioMode,
}: {
  frequency: number;
  radioMode?: string;
  effectiveMode?: string;
  engineMode: EngineMode;
  digitalModeRadioMode?: DigitalModeRadioModePreference | null;
}): ApplyOperatingStateRequest {
  const request: ApplyOperatingStateRequest = {
    frequency,
    tolerateModeFailure: true,
  };

  const resolution = resolveFrequencyRadioMode({
    effectiveMode,
    requestedRadioMode: radioMode,
    engineMode,
    digitalModeRadioMode,
  });

  if (resolution.writeRadioMode) {
    request.mode = resolution.writeRadioMode;
    request.bandwidth = 'nochange';
    request.options = resolution.modeOptions;
  }

  return request;
}
