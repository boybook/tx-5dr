import { describe, expect, it } from 'vitest';
import { SstvTxStartCommandSchema } from '../image-radio.schema.js';

describe('SSTV destination frequency contract', () => {
  const command = { requestId: 'request', operatorId: 'op', artifactId: 'image', mode: 'robot36' };
  it.each([null, 14_230_000])('accepts explicit local null or a positive RF frequency: %s', (expectedFrequency) => {
    expect(SstvTxStartCommandSchema.parse({ ...command, expectedFrequency }).expectedFrequency).toBe(expectedFrequency);
  });
  it.each([undefined, 0, -1, NaN, 'null', '14230000'])('rejects missing or invalid frequency: %s', (expectedFrequency) => {
    expect(SstvTxStartCommandSchema.safeParse({ ...command, expectedFrequency }).success).toBe(false);
  });
});
