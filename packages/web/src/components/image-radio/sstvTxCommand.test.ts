import { describe, expect, it } from 'vitest';

import { sstvTxErrorTranslationKey } from './sstvTxCommand';

describe('sstvTxErrorTranslationKey', () => {
  it('maps stable server rejections and falls back safely', () => {
    expect(sstvTxErrorTranslationKey('PHYSICAL_TX_BUSY')).toBe('txBusy');
    expect(sstvTxErrorTranslationKey('IMAGE_FREQUENCY_CHANGED')).toBe('txFrequencyChanged');
    expect(sstvTxErrorTranslationKey('IMAGE_TX_CALLSIGN_REQUIRED')).toBe('txCallsignRequired');
    expect(sstvTxErrorTranslationKey('UNKNOWN')).toBe('txRejected');
  });
});
