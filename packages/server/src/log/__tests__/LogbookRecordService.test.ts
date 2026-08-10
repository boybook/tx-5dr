import { describe, expect, it } from 'vitest';

import type { QSORecord } from '@tx5dr/contracts';

import { LogbookRecordService, mergeImportedQso } from '../LogbookRecordService.js';

function qso(id: string, overrides: Partial<QSORecord> = {}): QSORecord {
  return {
    id,
    callsign: 'N0CALL',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-04-05T13:00:00.000Z'),
    messageHistory: ['CQ N0CALL EN50'],
    ...overrides,
  };
}

describe('LogbookRecordService', () => {
  it('keeps physically duplicated records as independent runtime records', () => {
    const service = new LogbookRecordService([
      qso('external:hash:1'),
      qso('external:hash:2'),
    ]);

    expect(service.all().map(record => record.id)).toEqual([
      'external:hash:1',
      'external:hash:2',
    ]);
    expect(service.statistics().totalQSOs).toBe(2);
    expect(service.fingerprintIndex().get('N0CALL__1775394000__FT8__14074000')).toBe('external:hash:1');
  });

  it('does not expose mutable references to its query state', () => {
    const service = new LogbookRecordService([qso('qso-1')]);

    const returned = service.get('qso-1')!;
    returned.callsign = 'CHANGED';
    returned.messageHistory.push('CHANGED');

    expect(service.get('qso-1')).toMatchObject({
      callsign: 'N0CALL',
      messageHistory: ['CQ N0CALL EN50'],
    });
    expect(service.lastWithCallsign('N0CALL')).toMatchObject({ callsign: 'N0CALL' });
  });

  it('applies import merge priorities without mutating the existing record', () => {
    const existing = qso('qso-1', {
      grid: undefined,
      lotwQslSent: 'N',
      lotwQslReceived: 'N',
    });
    const incoming = qso('import-1', {
      grid: 'EN50',
      lotwQslSent: 'Y',
      lotwQslReceived: 'V',
    });

    const result = mergeImportedQso(existing, incoming);

    expect(result).toMatchObject({
      changed: true,
      record: {
        id: 'qso-1',
        grid: 'EN50',
        lotwQslSent: 'Y',
        lotwQslReceived: 'V',
      },
    });
    expect(existing).toMatchObject({
      grid: undefined,
      lotwQslSent: 'N',
      lotwQslReceived: 'N',
    });
  });
});
