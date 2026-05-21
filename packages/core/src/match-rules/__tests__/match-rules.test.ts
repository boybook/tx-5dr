import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compileLegacyAutoRegexTextMatchRules,
  compileTextMatchRules,
  matchTextValue,
  normalizeTextMatchEntries,
  validateLegacyAutoRegexTextMatchRuleLine,
  validateTextMatchRuleLine,
} from '../match-rules.js';

describe('generic text match rules', () => {
  it('normalizes string and array entries while preserving comments for textareas', () => {
    assert.deepEqual(normalizeTextMatchEntries(' JA1AAA\n# note\n\nBG5DRB '), ['JA1AAA', 'BG5DRB']);
    assert.deepEqual(normalizeTextMatchEntries([' JA1AAA ', '', '# note', 123]), ['JA1AAA']);
  });

  it('matches exact, prefix, fuzzy, and regex modes case-insensitively', () => {
    assert.ok(matchTextValue('ja1aaa', compileTextMatchRules(['JA1AAA'], 'exact')));
    assert.equal(matchTextValue('JA1AAA/P', compileTextMatchRules(['JA1AAA'], 'exact')), null);
    assert.ok(matchTextValue('JA1AAA', compileTextMatchRules(['JA'], 'prefix')));
    assert.ok(matchTextValue('BG5DRB', compileTextMatchRules(['5D'], 'fuzzy')));
    assert.ok(matchTextValue('BG5DRB', compileTextMatchRules(['^BG[0-9]'], 'regex')));
  });

  it('skips invalid regex rules at runtime and reports the same line in validation', () => {
    const invalid: Array<{ entry: string }> = [];
    const rules = compileTextMatchRules(['[', '^JA'], 'regex', {
      onInvalidRegex: (entry) => invalid.push({ entry }),
    });

    assert.deepEqual(invalid, [{ entry: '[' }]);
    assert.equal(rules.length, 1);
    assert.ok(matchTextValue('JA1AAA', rules));
    assert.deepEqual(validateTextMatchRuleLine('[', 3, 'regex', { issueKey: 'badRegex' }), {
      key: 'badRegex',
      params: { line: 3 },
    });
  });

  it('supports legacy auto-regex rules for existing watched callsign configs', () => {
    const rules = compileLegacyAutoRegexTextMatchRules(['^BG5', 'JA1AAA'], 'exact');
    assert.ok(matchTextValue('BG5DRB', rules));
    assert.ok(matchTextValue('JA1AAA', rules));
    assert.equal(matchTextValue('JA1AAA/P', rules), null);
    assert.deepEqual(validateLegacyAutoRegexTextMatchRuleLine('[', 2, { issueKey: 'legacyBadRegex' }), {
      key: 'legacyBadRegex',
      params: { line: 2 },
    });
  });
});
