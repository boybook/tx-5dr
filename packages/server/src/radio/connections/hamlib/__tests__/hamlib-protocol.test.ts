import { describe, expect, it } from 'vitest';
import { decodeHamlibResult, deserializeHamlibError, encodeHamlibResult, HamlibCommandSchema, HamlibSpectrumLineSchema, serializeHamlibError } from '../hamlib-protocol.js';
import { RadioError, RadioErrorCode } from '../../../../utils/errors/RadioError.js';

describe('Hamlib protocol', () => {
  it('preserves radio errors and errors nested in a compound operating-state result', () => {
    const error = new RadioError({ code: RadioErrorCode.OPERATION_TIMEOUT, message: 'mode read timed out',
      userMessageKey: 'radio:error.operationTimeout', userMessageParams: { operation: 'mode' },
      suggestions: ['Reconnect'], context: { operation: 'getMode', optional: true } });
    const restored = deserializeHamlibError(serializeHamlibError(error));
    expect(restored).toBeInstanceOf(RadioError);
    expect(restored).toMatchObject({ code: error.code, userMessageKey: error.userMessageKey, userMessageParams: error.userMessageParams, context: error.context, suggestions: error.suggestions });
    const result = decodeHamlibResult('applyOperatingState', encodeHamlibResult('applyOperatingState', { frequencyApplied: true, modeApplied: false, modeError: error }));
    expect(result).toMatchObject({ frequencyApplied: true, modeError: { code: RadioErrorCode.OPERATION_TIMEOUT } });
    expect((result as { modeError: Error }).modeError).toBeInstanceOf(RadioError);
  });

  it('does not expose private runtime methods through IPC', () => {
    expect(HamlibCommandSchema.safeParse({ type: 'call', generation: 'session', id: 1, operation: 'cleanup', args: [] }).success).toBe(false);
    expect(HamlibCommandSchema.safeParse({ type: 'call', generation: 'session', id: 1, operation: 'convertError', args: [] }).success).toBe(false);
  });

  it('rejects live functions in diagnostic context', () => {
    const error = new RadioError({ code: RadioErrorCode.DEVICE_ERROR, message: 'bad context', context: { callback: () => {} } });
    expect(() => serializeHamlibError(error)).toThrow();
  });

  it('rejects spectrum lengths that exceed the actual buffer', () => {
    expect(HamlibSpectrumLineSchema.safeParse({ scopeId: 0, dataLevelMin: 0, dataLevelMax: 255, signalStrengthMin: -120, signalStrengthMax: 0, mode: 0, centerFreq: 7100000, spanHz: 100000, lowEdgeFreq: 7050000, highEdgeFreq: 7150000, dataLength: 3, data: Buffer.alloc(2), timestamp: 0 }).success).toBe(false);
  });
});
