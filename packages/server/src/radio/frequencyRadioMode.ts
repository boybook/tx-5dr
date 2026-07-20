import type { DigitalModeRadioModePreference } from '@tx5dr/contracts';
import type {
  ApplyOperatingStateRequest,
  ApplyOperatingStateResult,
  SetRadioModeOptions,
} from './connections/IRadioConnection.js';

type EngineMode = 'digital' | 'voice' | 'cw';

export interface FrequencyRadioModeResolution {
  displayRadioMode?: string;
  writeRadioMode?: string;
  modeOptions?: SetRadioModeOptions;
}

export interface AppliedFrequencyRadioModeProjection {
  displayRadioMode?: string;
  modeDegraded?: boolean;
  modeFallbackReason?: string;
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

function normalizeAppliedModeForDisplay(appliedMode: string, requestedDisplayMode?: string): string {
  const normalizedAppliedMode = appliedMode.trim().toUpperCase();
  const normalizedRequestedMode = requestedDisplayMode?.trim().toUpperCase();

  // Keep the product-facing USB-DATA label when the backend confirms its
  // Hamlib equivalent. A fallback to plain USB must remain visible as USB.
  if (normalizedRequestedMode === 'USB-DATA' && normalizedAppliedMode === 'PKTUSB') {
    return 'USB-DATA';
  }

  return normalizedAppliedMode;
}

export function projectAppliedFrequencyRadioMode(
  requestedDisplayMode: string | undefined,
  applyResult?: Pick<
    ApplyOperatingStateResult,
    'modeApplied' | 'modeError' | 'appliedMode' | 'modeDegraded' | 'modeFallbackReason'
  >,
): AppliedFrequencyRadioModeProjection {
  const requestedMode = hasNonEmptyString(requestedDisplayMode)
    ? requestedDisplayMode.trim()
    : undefined;
  if (!applyResult) {
    return requestedMode ? { displayRadioMode: requestedMode } : {};
  }

  const appliedMode = hasNonEmptyString(applyResult.appliedMode)
    ? normalizeAppliedModeForDisplay(applyResult.appliedMode, requestedMode)
    : undefined;
  const modeWriteFailed = Boolean(requestedMode && (!applyResult.modeApplied || applyResult.modeError));
  const degradedModeIsUnknown = applyResult.modeDegraded === true && !appliedMode;
  const modeDegraded = applyResult.modeDegraded === true || modeWriteFailed;
  const modeFallbackReason = applyResult.modeFallbackReason
    ?? applyResult.modeError?.message
    ?? (modeWriteFailed
      ? 'Radio did not confirm the requested mode'
      : degradedModeIsUnknown
        ? 'Radio mode degraded but the applied mode is unknown'
        : undefined);

  return {
    ...(appliedMode
      ? { displayRadioMode: appliedMode }
      : !modeWriteFailed && !degradedModeIsUnknown && requestedMode
        ? { displayRadioMode: requestedMode }
        : {}),
    ...(modeDegraded ? { modeDegraded: true } : {}),
    ...(modeDegraded && modeFallbackReason ? { modeFallbackReason } : {}),
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
