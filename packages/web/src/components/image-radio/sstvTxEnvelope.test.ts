import { describe, expect, it } from 'vitest';

import { estimateSstvTxDurationSeconds, isSstvStationIdCallsignSupported } from './sstvTxEnvelope';

const mode = {
  mode: 'robot8Bw', name: 'Robot 8 BW', visCode: 2, width: 160, height: 120,
  colorLayout: 'monochrome' as const, scanLayout: 'monochrome' as const,
  lineSeconds: 0.066, rowsPerLine: 1, status: 'canonical' as const,
};

describe('SSTV transmit envelope presentation', () => {
  it('validates only callsigns supported by the native station ID contract', () => {
    expect(isSstvStationIdCallsignSupported('bg5drb/p')).toBe(true);
    expect(isSstvStationIdCallsignSupported('BG5DRB-1')).toBe(false);
    expect(isSstvStationIdCallsignSupported('')).toBe(false);
  });

  it('accounts for enhanced preamble and all station ID modes', () => {
    const none = estimateSstvTxDurationSeconds(mode, '', { enhancedPreamble: false, stationIdMode: 'none' });
    const fsk = estimateSstvTxDurationSeconds(mode, 'BG5DRB', { enhancedPreamble: true, stationIdMode: 'fsk' });
    const cw = estimateSstvTxDurationSeconds(mode, 'BG5DRB', { enhancedPreamble: false, stationIdMode: 'cw' });
    expect(none).toBe(10);
    expect(fsk).toBeGreaterThan(none);
    expect(cw).toBeGreaterThan(none);
  });
});
