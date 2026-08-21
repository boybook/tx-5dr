import type { DiagnosticLogSource, DiagnosticLogSourceId } from '@tx5dr/contracts';

export type DiagnosticTimePreset = '15m' | '1h' | '6h' | '24h' | 'custom';

export const DEFAULT_DIAGNOSTIC_TIME_PRESET: DiagnosticTimePreset = '1h';

const PRESET_MS: Record<Exclude<DiagnosticTimePreset, 'custom'>, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

export function chooseDefaultDiagnosticSource(sources: DiagnosticLogSource[]): DiagnosticLogSourceId | null {
  return sources.find((source) => source.id === 'server')?.id ?? sources[0]?.id ?? null;
}

export function resolveDiagnosticRange(
  preset: DiagnosticTimePreset,
  nowMs: number,
  customFrom?: string,
  customTo?: string,
): { fromMs: number; toMs: number } | null {
  if (preset !== 'custom') return { fromMs: nowMs - PRESET_MS[preset], toMs: nowMs };
  const fromMs = Date.parse(customFrom ?? '');
  const toMs = Date.parse(customTo ?? '');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  if (toMs > nowMs + 60_000 || toMs - fromMs > 7 * 24 * 60 * 60 * 1000) return null;
  return { fromMs, toMs };
}

export function diagnosticRangeOverlapsSource(
  range: { fromMs: number; toMs: number } | null,
  source: DiagnosticLogSource | null,
): boolean {
  if (!range || !source) return false;
  if (source.availableFromMs == null || source.availableToMs == null) return true;
  return range.fromMs <= source.availableToMs && range.toMs >= source.availableFromMs;
}

export function canSubmitDiagnosticUpload(input: {
  sourceId: DiagnosticLogSourceId | null;
  sourcesLoading: boolean;
  uploading: boolean;
  sourceCount: number;
  rangeIsValid?: boolean;
  rangeOverlapsAvailableLogs?: boolean;
}): boolean {
  return Boolean(input.sourceId)
    && !input.sourcesLoading
    && !input.uploading
    && input.sourceCount > 0
    && input.rangeIsValid !== false
    && input.rangeOverlapsAvailableLogs !== false;
}
