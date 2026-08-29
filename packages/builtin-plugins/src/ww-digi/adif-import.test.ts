import { describe, expect, it } from 'vitest';
import type { QSORecord } from '@tx5dr/plugin-api';
import { resolveWWDigiContestPeriod } from './contest-log.js';
import {
  parseWWDigiAdifImport,
  planWWDigiAdifImport,
  summarizeWWDigiAdifImport,
} from './adif-import.js';

function field(name: string, value: string): string {
  return `<${name}:${value.length}>${value}`;
}

function adifRecord(overrides: {
  call?: string;
  date?: string;
  time?: string;
  mode?: string;
  frequency?: string;
  stationCallsign?: string | null;
  myGrid?: string | null;
  grid?: string | null;
} = {}): string {
  const values = {
    call: 'JA1AAA',
    date: '20260829',
    time: '120100',
    mode: 'FT8',
    frequency: '14.090000',
    stationCallsign: 'BG5DRB' as string | null,
    myGrid: 'PL09' as string | null,
    grid: 'PM95' as string | null,
    ...overrides,
  };
  return [
    field('CALL', values.call),
    field('QSO_DATE', values.date),
    field('TIME_ON', values.time),
    field('MODE', values.mode),
    ...(values.frequency ? [field('FREQ', values.frequency)] : []),
    ...(values.stationCallsign ? [field('STATION_CALLSIGN', values.stationCallsign)] : []),
    ...(values.myGrid ? [field('MY_GRIDSQUARE', values.myGrid)] : []),
    ...(values.grid ? [field('GRIDSQUARE', values.grid)] : []),
    '<EOR>',
  ].join('');
}

function parse(content: string) {
  return parseWWDigiAdifImport(content, {
    contestYear: 2026,
    stationCallsign: 'BG5DRB',
    stationGrid: 'PL09',
  });
}

describe('WW Digi ADIF import', () => {
  it('accepts an FT8 contest QSO without requiring CONTEST_ID', () => {
    const result = parse(adifRecord());

    expect(result.rejected).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      band: '20M',
      requiresStationConfirmation: false,
      requiresGridConfirmation: false,
      record: {
        callsign: 'JA1AAA',
        contestId: 'WW-DIGI',
        myCallsign: 'BG5DRB',
        myGrid: 'PL09',
        grid: 'PM95',
        frequency: 14_090_000,
      },
    });
  });

  it('rejects missing frequency instead of inheriting the generic 14.074 MHz fallback', () => {
    const result = parse(adifRecord({ frequency: '' }));

    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]?.issues).toContain('missing-frequency');
  });

  it('accepts ADIF fields that include explicit data-type suffixes', () => {
    const typed = adifRecord().replace('<CALL:6>', '<CALL:6:S>').replace('<FREQ:9>', '<FREQ:9:N>');
    expect(parse(typed).candidates[0]?.record).toMatchObject({
      callsign: 'JA1AAA',
      frequency: 14_090_000,
    });
  });

  it('reports an incomplete ADIF tail instead of importing it', () => {
    const result = parse(adifRecord().replace('<EOR>', ''));
    expect(result).toMatchObject({ totalRead: 1, candidates: [] });
    expect(result.rejected[0]?.issues).toContain('invalid-record');
  });

  it('requires confirmation before filling missing station identity fields', () => {
    const parsed = parse(adifRecord({ stationCallsign: null, myGrid: null }));
    const blocked = planWWDigiAdifImport(parsed.candidates, [], {
      stationCallsign: false,
      stationGrid: false,
    });
    const confirmed = planWWDigiAdifImport(parsed.candidates, [], {
      stationCallsign: true,
      stationGrid: true,
    });

    expect(blocked).toMatchObject({ items: [], withheld: 1 });
    expect(confirmed.items).toHaveLength(1);
    expect(summarizeWWDigiAdifImport(parsed, [])).toMatchObject({
      missingStationCallsign: 1,
      missingMyGrid: 1,
      importable: 1,
      review: 0,
    });
  });

  it('marks imported Multi-Two records for transmitter review', () => {
    const parsed = parseWWDigiAdifImport(adifRecord(), {
      contestYear: 2026,
      stationCallsign: 'BG5DRB',
      stationGrid: 'PL09',
      requireTransmitterId: true,
    });
    const plan = planWWDigiAdifImport(parsed.candidates, [], {
      stationCallsign: true,
      stationGrid: true,
    });
    expect(plan.items[0]?.candidate.reviewIssues).toContain('missing-transmitter');
  });

  it('rejects records outside the selected contest and records for another station', () => {
    const period = resolveWWDigiContestPeriod(2026);
    expect(new Date(period.startTime).toISOString()).toBe('2026-08-29T12:00:00.000Z');
    const result = parse([
      adifRecord({ date: '20260828' }),
      adifRecord({ stationCallsign: 'JA1XYZ' }),
    ].join('\n'));

    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]?.issues).toContain('outside-contest-period');
    expect(result.rejected[1]?.issues).toContain('station-mismatch');
  });

  it('skips exact duplicates and marks near matches for review without deleting them', () => {
    const parsed = parse([
      adifRecord(),
      adifRecord({ call: 'JA2BBB', time: '120200' }),
    ].join('\n'));
    const exact: QSORecord = structuredClone(parsed.candidates[0]!.record);
    const near: QSORecord = {
      ...structuredClone(parsed.candidates[1]!.record),
      id: 'existing-near',
      startTime: parsed.candidates[1]!.record.startTime + 30_000,
      frequency: 14_091_000,
    };

    const plan = planWWDigiAdifImport(parsed.candidates, [exact, near], {
      stationCallsign: true,
      stationGrid: true,
    });

    expect(plan.duplicates).toBe(1);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.candidate.reviewIssues).toContain('possible-duplicate');
  });
});
