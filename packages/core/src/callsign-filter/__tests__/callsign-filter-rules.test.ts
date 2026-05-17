import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateCallsignFilter,
  normalizeCallsignBandFilterRules,
  parseCallsignFilterRules,
  selectCallsignFilterRuleEntries,
  validateFilterRuleLine,
} from '../callsign-filter-rules.js';

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
});
