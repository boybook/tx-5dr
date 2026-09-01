import { describe, expect, it } from 'vitest';
import { createFT8ContestTestKit } from '@tx5dr/plugin-api/contest';
import {
  africaFt4DxContest,
  arrlDigitalContest,
  bataviaFt8Contest,
  ft8ActivityEuropeContest,
  ftContestBuiltinPluginEntries,
  ftContestCatalog,
  ftRoundupContest,
  rsgbFt4InternationalActivityDayContest,
  ybdxpiFt8Contest,
} from './index.js';

describe('FT contest catalog', () => {
  it('registers one thin built-in plugin per contest family', () => {
    expect(ftContestCatalog).toHaveLength(13);
    expect(ftContestBuiltinPluginEntries).toHaveLength(13);
    expect(ftContestCatalog[0]?.locales.en.pluginName).toBe('ARRL International Digital Contest');
    expect(ftContestCatalog[0]?.locales.en.pluginDescription).toContain('ARRL');
    expect(ftContestCatalog[0]?.locales.zh.autoReplyToCQ).toBe('自动回应他人 CQ');
    expect(ftContestCatalog[0]?.locales.ja.autoReplyToCQ).toBe('他局の CQ に自動応答');
    expect(ftContestCatalog.map((entry) => entry.name)).toEqual([
      'arrl-digital',
      'ft-roundup',
      'ft-challenge',
      'european-ft8-dx',
      'european-ft4-dx',
      'rsgb-ft4-international-activity-day',
      'rsgb-ft4-contest-series',
      'ft8-activity-europe',
      'ft8-activity-na',
      'nccc-ft4-sprint',
      'batavia-ft8',
      'ybdxpi-ft8',
      'africa-ft4-dx',
    ]);
  });

  it('covers distance, fixed-point and location-aware scoring without duplicating logic', () => {
    const arrl = createFT8ContestTestKit(arrlDigitalContest);
    arrl.score([
      {
        callsign: 'K1ABC',
        operatorCallsign: 'W1AW',
        operatorGrid: 'FN31',
        band: '20M',
        mode: 'FT8',
        startTime: Date.parse('2026-06-06T19:00:00Z'),
        distanceKm: 1565,
        receivedExchange: { grid: 'EN50' },
      },
    ], { qsoCount: 1, qsoPoints: 5, multiplierCount: 0, total: 5 });

    const roundupKit = createFT8ContestTestKit(ftRoundupContest);
    roundupKit.exchange(
      { report: '-10', state: 'ma' },
      { kind: 'state', report: '-10', value: 'MA' },
    );
    roundupKit.score([
      {
        callsign: 'K1ABC',
        operatorCallsign: 'W1AW',
        band: '20M',
        mode: 'FT8',
        startTime: Date.parse('2026-12-05T19:00:00Z'),
        receivedExchange: { kind: 'state', report: '-10', value: 'MA' },
      },
      {
        callsign: 'K1ABC',
        operatorCallsign: 'W1AW',
        band: '40M',
        mode: 'FT8',
        startTime: Date.parse('2026-12-05T20:00:00Z'),
        receivedExchange: { kind: 'state', report: '-10', value: 'MA' },
      },
    ], { qsoCount: 2, qsoPoints: 2, multiplierCount: 1, total: 2 });

    expect(ft8ActivityEuropeContest.scoring.score({
      callsign: 'ON4KHG',
      operatorCallsign: 'W1AW',
      operatorGrid: 'FN31',
      band: '2M',
      mode: 'FT8',
      startTime: Date.parse('2026-09-02T17:10:00Z'),
      receivedExchange: { grid: 'JO21' },
    })).toMatchObject({ points: 1, multiplierKeys: ['JO'] });

    expect(bataviaFt8Contest.scoring.score({
      callsign: 'YB1AAA',
      operatorCallsign: 'W1AW',
      band: '20M',
      mode: 'FT8',
      startTime: Date.parse('2026-08-01T12:00:00Z'),
      receivedExchange: { grid: 'OI33' },
      member: true,
    })).toMatchObject({ points: 5 });

    expect(ybdxpiFt8Contest.scoring.score({
      callsign: 'W1AW',
      operatorCallsign: 'YB1AAA',
      band: '20M',
      mode: 'FT8',
      startTime: Date.parse('2026-10-24T12:00:00Z'),
      receivedExchange: { grid: 'FN31' },
      member: false,
    })).toMatchObject({ points: 2 });

    expect(rsgbFt4InternationalActivityDayContest.scoring.score({
      callsign: 'JA1AAA',
      operatorCallsign: 'W1AW',
      band: '40M',
      mode: 'FT4',
      startTime: Date.parse('2026-04-11T12:30:00Z'),
      receivedExchange: { grid: 'PM95' },
    })).toMatchObject({ points: 3 });

    expect(africaFt4DxContest.scoring.score({
      callsign: 'JA1AAA',
      operatorCallsign: 'ZS1ABC',
      band: '20M',
      mode: 'FT4',
      startTime: Date.parse('2026-03-07T12:30:00Z'),
      receivedExchange: { grid: 'PM95' },
    })).toMatchObject({ points: 1 });
  });
});
