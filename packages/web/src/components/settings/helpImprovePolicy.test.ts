import { describe, expect, it } from 'vitest';
import type { DiagnosticLogSource } from '@tx5dr/contracts';
import {
  canSubmitDiagnosticUpload,
  chooseDefaultDiagnosticSource,
  DEFAULT_DIAGNOSTIC_TIME_PRESET,
  diagnosticRangeOverlapsSource,
  resolveDiagnosticRange,
} from './helpImprovePolicy';

const source = (id: DiagnosticLogSource['id']): DiagnosticLogSource => ({
  id,
  fileName: `${id}.log`,
  fileCount: 1,
  totalBytes: 100,
  availableFromMs: 1,
  availableToMs: 2,
});

describe('help improve interaction policy', () => {
  it('defaults to the server log and the last hour', () => {
    expect(DEFAULT_DIAGNOSTIC_TIME_PRESET).toBe('1h');
    expect(chooseDefaultDiagnosticSource([source('electron-main'), source('server')])).toBe('server');
    expect(resolveDiagnosticRange('1h', 10_000_000)).toEqual({
      fromMs: 6_400_000,
      toMs: 10_000_000,
    });
  });

  it('rejects inverted, future, and longer-than-seven-day custom ranges', () => {
    const now = Date.parse('2026-08-21T12:00:00.000Z');
    expect(resolveDiagnosticRange('custom', now, '2026-08-21T11:00:00.000Z', '2026-08-21T10:00:00.000Z')).toBeNull();
    expect(resolveDiagnosticRange('custom', now, '2026-08-21T11:00:00.000Z', '2026-08-21T13:00:00.000Z')).toBeNull();
    expect(resolveDiagnosticRange('custom', now, '2026-08-01T00:00:00.000Z', '2026-08-21T12:00:00.000Z')).toBeNull();
  });

  it('keeps manual upload availability independent from telemetry consent', () => {
    expect(canSubmitDiagnosticUpload({
      sourceId: 'server',
      sourceCount: 1,
      sourcesLoading: false,
      uploading: false,
    })).toBe(true);
  });

  it('detects whether the selected time intersects the available log coverage', () => {
    expect(diagnosticRangeOverlapsSource(
      { fromMs: 1_500, toMs: 2_500 },
      { ...source('server'), availableFromMs: 1_000, availableToMs: 2_000 },
    )).toBe(true);
    expect(diagnosticRangeOverlapsSource(
      { fromMs: 3_000, toMs: 4_000 },
      { ...source('server'), availableFromMs: 1_000, availableToMs: 2_000 },
    )).toBe(false);
    expect(diagnosticRangeOverlapsSource(
      { fromMs: 3_000, toMs: 4_000 },
      { ...source('server'), availableFromMs: null, availableToMs: null },
    )).toBe(true);
  });

  it('disables upload when the range is invalid or outside available coverage', () => {
    expect(canSubmitDiagnosticUpload({
      sourceId: 'server',
      sourceCount: 1,
      sourcesLoading: false,
      uploading: false,
      rangeIsValid: false,
    })).toBe(false);
    expect(canSubmitDiagnosticUpload({
      sourceId: 'server',
      sourceCount: 1,
      sourcesLoading: false,
      uploading: false,
      rangeOverlapsAvailableLogs: false,
    })).toBe(false);
  });
});
