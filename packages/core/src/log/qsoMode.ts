import type { QSORecord } from '@tx5dr/contracts';

export interface QsoModeFields {
  mode?: string;
  submode?: string;
}

export interface ProjectedQsoMode {
  mode: string;
  submode?: string;
}

const SSB_SUBMODES = new Set(['USB', 'LSB']);
const LOTW_MFSK_CONTACT_MODES = new Set(['FT4', 'FST4', 'MFSK16', 'MFSK8', 'Q65']);

function normalizeModeToken(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}

function isSsbSubmode(value?: string): value is 'USB' | 'LSB' {
  return !!value && SSB_SUBMODES.has(value);
}

/**
 * Compatibility boundary for incoming or legacy QSO mode data before storage.
 * It is the only place where legacy voice sideband modes are rewritten.
 */
export function normalizeQsoModeForStorage<T extends QsoModeFields>(input: T): T & QsoModeFields {
  const mode = normalizeModeToken(input.mode);
  const submode = normalizeModeToken(input.submode);

  if (!mode) {
    const { submode: _submode, ...rest } = input;
    return { ...rest } as T & QsoModeFields;
  }

  if (isSsbSubmode(mode)) {
    return { ...input, mode: 'SSB', submode: mode };
  }

  if (mode === 'SSB') {
    return submode
      ? { ...input, mode: 'SSB', submode }
      : { ...input, mode: 'SSB', submode: undefined };
  }

  if (isSsbSubmode(submode)) {
    return { ...input, mode, submode: undefined };
  }

  return submode
    ? { ...input, mode, submode }
    : { ...input, mode, submode: undefined };
}

/** Returns the operator-facing mode label without changing stored data. */
export function getDisplayMode(input: QsoModeFields): string {
  const normalized = normalizeQsoModeForStorage(input);
  const mode = normalizeModeToken(normalized.mode) ?? '';
  const submode = normalizeModeToken(normalized.submode);
  return mode === 'SSB' && isSsbSubmode(submode) ? submode : mode;
}

/** Projects the stored QSO mode to ADIF fields. Digital legacy mappings are preserved. */
export function toAdifMode(input: QsoModeFields): ProjectedQsoMode {
  const normalized = normalizeQsoModeForStorage(input);
  const mode = normalizeModeToken(normalized.mode) ?? 'FT8';
  const submode = normalizeModeToken(normalized.submode);

  if (mode === 'FT4') {
    return { mode: 'MFSK', submode: 'FT4' };
  }

  if (mode === 'MFSK' && submode) {
    return { mode: 'MFSK', submode };
  }

  return submode ? { mode, submode } : { mode };
}

/** Projects the stored QSO mode to the single LoTW tCONTACT MODE value. */
export function toLotwContactMode(input: QsoModeFields): string {
  const normalized = normalizeQsoModeForStorage(input);
  const mode = normalizeModeToken(normalized.mode) ?? 'FT8';
  const submode = normalizeModeToken(normalized.submode);

  if (mode === 'SSB' && isSsbSubmode(submode)) {
    return 'SSB';
  }

  if (mode === 'MFSK') {
    if (submode && LOTW_MFSK_CONTACT_MODES.has(submode)) {
      return submode;
    }
    return 'DATA';
  }

  if (mode === 'PKT') {
    return 'PACKET';
  }

  return mode;
}

export function normalizeQsoRecordModeForStorage<T extends QSORecord>(record: T): T {
  return normalizeQsoModeForStorage(record) as T;
}
