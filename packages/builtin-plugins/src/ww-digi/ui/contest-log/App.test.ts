import { describe, expect, it } from 'vitest';
import { wwDigiContestLogUiTestables } from './App.js';

const BASE = {
  callsign: 'BG5DRB',
  location: 'DX',
  categoryBand: '20M',
  categoryPower: 'QRP',
  categoryOperator: 'SINGLE-OP',
  categoryTransmitter: 'ONE',
  operators: [],
};

describe('WW Digi contest settings form rules', () => {
  it('removes the invalid SINGLE-TWO combination', () => {
    expect(wwDigiContestLogUiTestables.normalizeCategoryDraft({
      ...BASE, categoryTransmitter: 'TWO',
    }).categoryTransmitter).toBe('ONE');
  });

  it('normalizes multi-operator band and power choices', () => {
    expect(wwDigiContestLogUiTestables.normalizeCategoryDraft({
      ...BASE, categoryOperator: 'MULTI-OP', categoryTransmitter: 'ONE',
    })).toMatchObject({ categoryBand: 'ALL', categoryPower: 'LOW' });
    expect(wwDigiContestLogUiTestables.normalizeCategoryDraft({
      ...BASE, categoryOperator: 'MULTI-OP', categoryTransmitter: 'TWO', categoryPower: 'LOW',
    })).toMatchObject({ categoryBand: 'ALL', categoryPower: 'HIGH' });
  });

  it('limits selectable options to official category combinations', () => {
    const multiTwo = { ...BASE, categoryOperator: 'MULTI-OP', categoryTransmitter: 'TWO' };
    expect(wwDigiContestLogUiTestables.powerOptions(multiTwo)).toEqual(['HIGH']);
    expect(wwDigiContestLogUiTestables.bandOptions(multiTwo)).toEqual(['ALL']);
    expect(wwDigiContestLogUiTestables.transmitterOptions(BASE)).toEqual(['ONE', 'UNLIMITED']);
  });

  it('formats the official submission deadline with an explicit UTC label', () => {
    expect(wwDigiContestLogUiTestables.formatDeadline(Date.UTC(2026, 8, 1, 12)))
      .toBe('2026-09-01 12:00 UTC');
  });

  it('formats import confirmations without exposing template markers', () => {
    expect(wwDigiContestLogUiTestables.interpolate(
      'Import {{count}} for {{callsign}}',
      { count: 12, callsign: 'BG5DRB' },
    )).toBe('Import 12 for BG5DRB');
  });
});
