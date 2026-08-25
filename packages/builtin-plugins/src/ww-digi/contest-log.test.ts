import { describe, expect, it } from 'vitest';
import {
  ContestLogValidationError,
  generateWWDigiCabrillo,
  isWithinWWDigiContestPeriod,
  projectContestQsos,
  resolveWWDigiContestPeriod,
  setContestQsoStatus,
  type ContestConfig,
  type ContestQso,
  upsertContestQso,
  validateContestConfig,
  validateContestQso,
} from './contest-log.js';

const CONFIG: ContestConfig = {
  callsign: 'BG5DRB',
  location: 'DX',
  categoryBand: 'ALL',
  categoryPower: 'LOW',
  createdBy: 'TX-5DR 1.0.0',
};

function qso(overrides: Partial<ContestQso> = {}): ContestQso {
  return {
    qsoId: 'qso-1',
    callsign: 'JA1AAA',
    myCallsign: 'BG5DRB',
    sentGrid: 'OL32',
    receivedGrid: 'PM95',
    frequencyHz: 14_091_240,
    band: '20M',
    mode: 'FT8',
    startTime: Date.UTC(2026, 7, 29, 12, 0, 15),
    status: 'included',
    ...overrides,
  };
}

describe('WW Digi contest log model', () => {
  it('resolves the last full August weekend as a half-open UTC period', () => {
    expect(resolveWWDigiContestPeriod(2026)).toEqual({
      contestYear: 2026,
      startTime: Date.UTC(2026, 7, 29, 12),
      endTime: Date.UTC(2026, 7, 30, 12),
    });
    // August 31, 2024 was Saturday, so that partial weekend is excluded.
    expect(resolveWWDigiContestPeriod(2024)).toEqual({
      contestYear: 2024,
      startTime: Date.UTC(2024, 7, 24, 12),
      endTime: Date.UTC(2024, 7, 25, 12),
    });
    expect(resolveWWDigiContestPeriod(2025)).toEqual({
      contestYear: 2025,
      startTime: Date.UTC(2025, 7, 30, 12),
      endTime: Date.UTC(2025, 7, 31, 12),
    });
  });

  it('excludes adjacent editions and the exact Sunday end boundary', () => {
    expect(isWithinWWDigiContestPeriod(Date.UTC(2026, 7, 29, 12), 2026)).toBe(true);
    expect(isWithinWWDigiContestPeriod(Date.UTC(2026, 7, 30, 11, 59, 59, 999), 2026)).toBe(true);
    expect(isWithinWWDigiContestPeriod(Date.UTC(2026, 7, 30, 12), 2026)).toBe(false);
    expect(isWithinWWDigiContestPeriod(Date.UTC(2025, 7, 30, 12), 2026)).toBe(false);
    expect(() => resolveWWDigiContestPeriod(2101)).toThrowError(ContestLogValidationError);
  });

  it('upserts by qsoId and keeps replay idempotent', () => {
    const first = upsertContestQso([], qso());
    const replayed = upsertContestQso(first, qso());
    const corrected = upsertContestQso(replayed, qso({ receivedGrid: 'PM96' }));

    expect(replayed).toEqual(first);
    expect(corrected).toHaveLength(1);
    expect(corrected[0]?.receivedGrid).toBe('PM96');
  });

  it('computes dupes by callsign and band across FT4 and FT8', () => {
    const projected = projectContestQsos([
      qso({ qsoId: 'later', mode: 'FT8', startTime: Date.UTC(2026, 7, 29, 12, 1) }),
      qso({ qsoId: 'first', mode: 'FT4', startTime: Date.UTC(2026, 7, 29, 12, 0) }),
      qso({ qsoId: 'other-band', mode: 'FT8', band: '15M', frequencyHz: 21_091_000, startTime: Date.UTC(2026, 7, 29, 12, 2) }),
      qso({ qsoId: 'other-call', callsign: 'JA1AAB', startTime: Date.UTC(2026, 7, 29, 12, 3) }),
    ]);

    expect(projected.map(({ qsoId, dupe }) => ({ qsoId, dupe }))).toEqual([
      { qsoId: 'first', dupe: false },
      { qsoId: 'later', dupe: true },
      { qsoId: 'other-band', dupe: false },
      { qsoId: 'other-call', dupe: false },
    ]);
  });

  it('keeps X-QSO contacts without consuming the dupe key', () => {
    const excluded = setContestQsoStatus([qso({ qsoId: 'first' })], 'first', 'x-qso');
    const projected = projectContestQsos([
      ...excluded,
      qso({ qsoId: 'second', startTime: Date.UTC(2026, 7, 29, 12, 1) }),
    ]);

    expect(projected.map(({ status, dupe }) => ({ status, dupe }))).toEqual([
      { status: 'x-qso', dupe: false },
      { status: 'included', dupe: false },
    ]);
  });

  it('normalizes callsigns, grids, and missing received exchange', () => {
    const normalized = validateContestQso(qso({
      callsign: ' ja1aaa ',
      myCallsign: ' bg5drb ',
      sentGrid: 'ol32',
      receivedGrid: 'ZZ00',
    }));

    expect(normalized).toMatchObject({
      callsign: 'JA1AAA',
      myCallsign: 'BG5DRB',
      sentGrid: 'OL32',
      receivedGrid: undefined,
    });
    expect(projectContestQsos([normalized])[0]?.receivedGrid).toBe('ZZ00');
  });
});

describe('WW Digi Cabrillo generation', () => {
  it('matches the deterministic Cabrillo 3.0 golden file', () => {
    const output = generateWWDigiCabrillo(CONFIG, [
      qso({
        qsoId: 'qso-later',
        callsign: 'VK2AAA',
        receivedGrid: undefined,
        frequencyHz: 21_091_640,
        band: '15M',
        mode: 'FT4',
        startTime: Date.UTC(2026, 7, 29, 12, 2, 45),
      }),
      qso({
        qsoId: 'qso-excluded',
        callsign: 'W1AW',
        receivedGrid: 'FN32',
        frequencyHz: 7_091_499,
        band: '40M',
        startTime: Date.UTC(2026, 7, 29, 12, 1, 30),
        status: 'x-qso',
      }),
      qso({
        qsoId: 'qso-first',
        callsign: 'JA1AAA',
        receivedGrid: 'PM95',
        frequencyHz: 14_091_240,
        band: '20M',
        startTime: Date.UTC(2026, 7, 29, 12, 0, 15),
      }),
    ]);

    expect(output).toBe([
      'START-OF-LOG: 3.0',
      'CONTEST: WW-DIGI',
      'CALLSIGN: BG5DRB',
      'LOCATION: DX',
      'CATEGORY-OPERATOR: SINGLE-OP',
      'CATEGORY-TRANSMITTER: ONE',
      'CATEGORY-BAND: ALL',
      'CATEGORY-POWER: LOW',
      'CATEGORY-MODE: DIGI',
      'CATEGORY-STATION: FIXED',
      'CREATED-BY: TX-5DR 1.0.0',
      'QSO: 14091 DG 2026-08-29 1200 BG5DRB        OL32     JA1AAA        PM95     0',
      'X-QSO:  7091 DG 2026-08-29 1201 BG5DRB        OL32     W1AW          FN32     0',
      'QSO: 21092 DG 2026-08-29 1202 BG5DRB        OL32     VK2AAA        ZZ00     0',
      'END-OF-LOG:',
      '',
    ].join('\r\n'));
    expect(output).not.toContain('CLAIMED-SCORE');
  });

  it('uses qsoId as a stable tie-breaker for equal UTC times', () => {
    const time = Date.UTC(2026, 7, 29, 12, 0);
    const output = generateWWDigiCabrillo(CONFIG, [
      qso({ qsoId: 'b', callsign: 'JA1BBB', startTime: time }),
      qso({ qsoId: 'a', callsign: 'JA1AAA', startTime: time }),
    ]);

    expect(output.indexOf('JA1AAA')).toBeLessThan(output.indexOf('JA1BBB'));
  });
});

describe('WW Digi contest log validation', () => {
  it('rejects unsupported config categories and header injection', () => {
    expect(() => validateContestConfig({ ...CONFIG, categoryBand: '6M' as 'ALL' }))
      .toThrowError(ContestLogValidationError);
    expect(() => validateContestConfig({ ...CONFIG, location: 'DX\nSOAPBOX: injected' }))
      .toThrowError(/line breaks/);
  });

  it('rejects malformed callsigns, grids, modes, and mismatched bands', () => {
    expect(() => validateContestQso(qso({ callsign: 'JA1 AAA' }))).toThrowError(/qso.callsign/);
    expect(() => validateContestQso(qso({ sentGrid: 'ZZ00' }))).toThrowError(/qso.sentGrid/);
    expect(() => validateContestQso(qso({ receivedGrid: 'PM9' }))).toThrowError(/qso.receivedGrid/);
    expect(() => validateContestQso(qso({ mode: 'JT65' as 'FT8' }))).toThrowError(/qso.mode/);
    expect(() => validateContestQso(qso({ band: '40M', frequencyHz: 14_091_000 }))).toThrowError(/qso.frequencyHz/);
  });

  it('uses module validation errors for corrupt persisted IDs', () => {
    const corrupt = qso({ qsoId: 42 as unknown as string });
    expect(() => upsertContestQso([corrupt], qso({ qsoId: 'valid' })))
      .toThrowError(ContestLogValidationError);
    expect(() => setContestQsoStatus([qso()], '', 'x-qso')).toThrowError(/qsoId/);
  });

  it('rejects QSO rows recorded under a different station callsign', () => {
    expect(() => generateWWDigiCabrillo(CONFIG, [qso({ myCallsign: 'BG5AAA' })]))
      .toThrowError(/must match config.callsign/);
  });
});
