import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateCallsignFilter,
  evaluateDxccBlocklist,
  normalizeBandDxccEntityCodes,
  normalizeCallsignBandFilterRules,
  normalizeDxccEntityCodes,
  parseCallsignFilterRules,
  resolveCallsignDxccEntityCode,
  selectCallsignFilterRuleEntries,
  selectDxccBlockEntityCodes,
  selectDxccEntityCodeForFilter,
  validateFilterRuleLine,
} from '../callsign-filter-rules.js';
import { getCallsignInfo } from '../../callsign/callsign.js';

describe('callsign filter rules', () => {
  it('filters out matching callsigns or prefixes in blocklist mode', () => {
    const rules = parseCallsignFilterRules(['BG5DRB', 'JA', '# comment']);

    assert.equal(evaluateCallsignFilter('BG5DRB', rules), false);
    assert.equal(evaluateCallsignFilter('JA1AAA', rules), false);
    assert.equal(evaluateCallsignFilter('K1ABC', rules), true);
  });

  it('keeps only regex matches in regex keep mode', () => {
    const rules = parseCallsignFilterRules(['^JA', '^(BG5DRB|K1ABC)$'], 'regex-keep');

    assert.equal(evaluateCallsignFilter('JA1AAA', rules), true);
    assert.equal(evaluateCallsignFilter('BG5DRB', rules), true);
    assert.equal(evaluateCallsignFilter('BV1XYZ', rules), false);
  });

  it('allows all callsigns when no active rules are configured', () => {
    const rules = parseCallsignFilterRules(['', '# comment'], 'regex-keep');

    assert.equal(evaluateCallsignFilter('JA1AAA', rules), true);
  });

  it('validates regex syntax for advanced keep rules', () => {
    assert.deepEqual(validateFilterRuleLine('[', 2, 'regex-keep'), {
      key: 'filterRulesInvalidRegexSyntax',
      params: { line: 2 },
    });
    assert.equal(validateFilterRuleLine('JA', 1, 'regex-keep'), null);
  });

  it('selects common rules while per-band filtering is disabled', () => {
    assert.deepEqual(selectCallsignFilterRuleEntries({
      perBandEnabled: false,
      filterRules: [' JA ', '', '# comment', 'BG5DRB'],
      bandFilterRules: { '40m': ['K'] },
      band: '40m',
    }), ['JA', 'BG5DRB']);
  });

  it('selects only the active band rules while per-band filtering is enabled', () => {
    assert.deepEqual(selectCallsignFilterRuleEntries({
      perBandEnabled: true,
      filterRules: ['JA'],
      bandFilterRules: {
        '40m': [' JA '],
        '20m': ['K'],
      },
      band: '40M',
    }), ['JA']);
  });

  it('allows all when per-band filtering has no rules for the active band', () => {
    assert.deepEqual(selectCallsignFilterRuleEntries({
      perBandEnabled: true,
      filterRules: ['JA'],
      bandFilterRules: { '20m': ['K'] },
      band: '40m',
    }), []);
  });

  it('allows all when per-band filtering cannot resolve a known band', () => {
    assert.deepEqual(selectCallsignFilterRuleEntries({
      perBandEnabled: true,
      filterRules: ['JA'],
      bandFilterRules: { '20m': ['K'] },
      band: 'Unknown',
    }), []);
  });

  it('normalizes per-band rule maps', () => {
    assert.deepEqual(normalizeCallsignBandFilterRules({
      ' 40M ': [' JA ', '', '# comment'],
      '20m': ['K'],
      empty: [],
      invalid: 'JA',
    }), {
      '40m': ['JA'],
      '20m': ['K'],
    });
  });

  it('resolves stable DXCC entity codes from callsigns', () => {
    assert.equal(getCallsignInfo('JA1AAA')?.entityCode, 339);
    assert.equal(resolveCallsignDxccEntityCode('JA1AAA'), '339');
  });

  it('normalizes DXCC entity code lists for block settings', () => {
    assert.deepEqual(normalizeDxccEntityCodes([' 339 ', 318, '0', 'abc', '339']), ['339', '318']);
  });

  it('normalizes per-band DXCC entity code maps', () => {
    assert.deepEqual(normalizeBandDxccEntityCodes({
      ' 40M ': [' 339 ', 318, '339', 'abc'],
      '20m': ['291'],
      empty: [],
      '30m': '110, 291',
    }), {
      '40m': ['339', '318'],
      '20m': ['291'],
      '30m': ['110', '291'],
    });
  });

  it('selects common DXCC block entities while per-band filtering is disabled', () => {
    assert.deepEqual(selectDxccBlockEntityCodes({
      perBandEnabled: false,
      blockedDxccEntityCodes: ['339', '318'],
      bandBlockedDxccEntityCodes: { '40m': ['291'] },
      band: '40m',
    }), ['339', '318']);
  });

  it('selects only the active band DXCC block entities while per-band filtering is enabled', () => {
    assert.deepEqual(selectDxccBlockEntityCodes({
      perBandEnabled: true,
      blockedDxccEntityCodes: ['318'],
      bandBlockedDxccEntityCodes: {
        '40m': ['339'],
        '20m': ['291'],
      },
      band: '40M',
    }), ['339']);
  });

  it('selects no DXCC blocks when per-band filtering has no active band entries', () => {
    assert.deepEqual(selectDxccBlockEntityCodes({
      perBandEnabled: true,
      blockedDxccEntityCodes: ['339'],
      bandBlockedDxccEntityCodes: { '20m': ['291'] },
      band: '40m',
    }), []);
    assert.deepEqual(selectDxccBlockEntityCodes({
      perBandEnabled: true,
      blockedDxccEntityCodes: ['339'],
      bandBlockedDxccEntityCodes: { '20m': ['291'] },
      band: 'Unknown',
    }), []);
  });

  it('selects logbook DXCC ids before falling back to callsign resolution', () => {
    assert.equal(selectDxccEntityCodeForFilter({ dxccId: 318, callsign: 'JA1AAA' }), '318');
    assert.equal(selectDxccEntityCodeForFilter({ callsign: 'JA1AAA' }), '339');
  });

  it('allows candidates when DXCC blocklist is disabled, empty, or unresolved', () => {
    assert.equal(evaluateDxccBlocklist({ dxccBlockEnabled: false, blockedDxccEntityCodes: ['339'], dxccId: 339 }), true);
    assert.equal(evaluateDxccBlocklist({ dxccBlockEnabled: true, blockedDxccEntityCodes: [], dxccId: 339 }), true);
    assert.equal(evaluateDxccBlocklist({ dxccBlockEnabled: true, blockedDxccEntityCodes: ['339'], callsign: 'NOT-A-CALL' }), true);
  });

  it('blocks matching DXCC entities as an extra callsign-filter condition', () => {
    const keepJapan = parseCallsignFilterRules(['^JA'], 'regex-keep');
    assert.equal(evaluateCallsignFilter('JA1AAA', keepJapan), true);
    assert.equal(evaluateDxccBlocklist({
      dxccBlockEnabled: true,
      blockedDxccEntityCodes: ['339'],
      callsign: 'JA1AAA',
    }), false);
    assert.equal(evaluateDxccBlocklist({
      dxccBlockEnabled: true,
      blockedDxccEntityCodes: ['339'],
      callsign: 'BG5DRB',
    }), true);
  });

});
