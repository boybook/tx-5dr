import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateCallsignFilter,
  parseCallsignFilterRules,
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
});
