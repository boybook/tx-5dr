import { describe, expect, it } from 'vitest';

import {
  CONTEST_QSO_ENVELOPE_MAX_BYTES,
  ContestQsoEnvelopeSchema,
  QSORecordSchema,
  parseContestQsoEnvelope,
  serializeContestQsoEnvelope,
} from '../qso.schema.js';

function envelope() {
  return {
    schemaVersion: 1 as const,
    contestId: 'FT-CHALLENGE',
    editionId: '2026-weekend-1',
    rulesetVersion: '2026.1',
    sent: { grid: 'PL05', snr: '-09' },
    received: { grid: 'PM96', snr: '-12' },
    annotations: { status: 'included', transmitter: 1, reviewed: false, note: '台北' },
  };
}

describe('ContestQsoEnvelopeSchema', () => {
  it('accepts shallow typed facts and round-trips Unicode through durable JSON', () => {
    const parsed = ContestQsoEnvelopeSchema.parse(envelope());
    const serialized = serializeContestQsoEnvelope(parsed);

    expect(serialized).toContain('\\u53f0\\u5317');
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      CONTEST_QSO_ENVELOPE_MAX_BYTES,
    );
    expect(parseContestQsoEnvelope(serialized)).toEqual(parsed);
  });

  it('rejects arbitrary nested values and unknown envelope fields', () => {
    expect(ContestQsoEnvelopeSchema.safeParse({
      ...envelope(),
      annotations: { nested: { value: true } },
    }).success).toBe(false);
    expect(ContestQsoEnvelopeSchema.safeParse({
      ...envelope(),
      privateState: 'not part of the contract',
    }).success).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite annotation number %s',
    (value) => {
      expect(ContestQsoEnvelopeSchema.safeParse({
        ...envelope(),
        annotations: { distance: value },
      }).success).toBe(false);
    },
  );

  it('enforces the UTF-8 JSON byte limit', () => {
    const result = ContestQsoEnvelopeSchema.safeParse({
      ...envelope(),
      received: { payload: '台'.repeat(Math.ceil(CONTEST_QSO_ENVELOPE_MAX_BYTES / 6)) },
    });

    expect(result.success).toBe(false);
  });
});

describe('QSORecordSchema contest identity', () => {
  const qso = {
    id: 'qso-1',
    callsign: 'N0CALL',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: 1,
    messageHistory: [],
  };

  it('accepts a matching standard and atomic contest identity', () => {
    expect(QSORecordSchema.safeParse({
      ...qso,
      contestId: 'FT-CHALLENGE',
      contestEntry: envelope(),
    }).success).toBe(true);
  });

  it('rejects conflicting standard and atomic contest identities', () => {
    expect(QSORecordSchema.safeParse({
      ...qso,
      contestId: 'WW-DIGI',
      contestEntry: envelope(),
    }).success).toBe(false);
  });
});
