import { describe, expect, it } from 'vitest';
import { getActiveCoreCapabilityDiagnostics } from '../coreCapabilityDiagnostics';

describe('coreCapabilityDiagnostics utils', () => {
  it('returns only currently unsupported capabilities with diagnostics', () => {
    const result = getActiveCoreCapabilityDiagnostics(
      {
        readFrequency: true,
        writeFrequency: false,
        readRadioMode: false,
        writeRadioMode: true,
      },
      {
        writeFrequency: {
          capability: 'writeFrequency',
          message: 'invalid parameter',
          stack: 'Error: invalid parameter',
          recordedAt: 123,
        },
        readRadioMode: {
          capability: 'readRadioMode',
          message: 'feature not available',
          stack: 'Error: feature not available',
          recordedAt: 456,
        },
      },
    );

    expect(result).toEqual([
      {
        capability: 'writeFrequency',
        message: 'invalid parameter',
        stack: 'Error: invalid parameter',
        recordedAt: 123,
      },
      {
        capability: 'readRadioMode',
        message: 'feature not available',
        stack: 'Error: feature not available',
        recordedAt: 456,
      },
    ]);
  });

  it('returns an empty list when capability support is unknown or diagnostics are absent', () => {
    expect(getActiveCoreCapabilityDiagnostics(null, null)).toEqual([]);
    expect(getActiveCoreCapabilityDiagnostics(
      {
        readFrequency: false,
        writeFrequency: false,
        readRadioMode: false,
        writeRadioMode: false,
      },
      {},
    )).toEqual([]);
  });
});
