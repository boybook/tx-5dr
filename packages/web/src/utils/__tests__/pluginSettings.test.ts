import { describe, expect, it } from 'vitest';
import type { PluginStatus } from '@tx5dr/contracts';
import {
  getPluginSettingValidationIssue,
  arePluginSettingValuesEqual,
  getPluginSettingDescriptionKey,
  isPluginSettingVisible,
  normalizePluginSettingsForSave,
} from '../pluginSettings';

const mockPluginSettings = {
  watchList: {
    type: 'string[]',
    label: 'Watch list',
    scope: 'operator',
    default: [],
  },
  threshold: {
    type: 'number',
    label: 'Threshold',
    scope: 'global',
    default: -15,
  },
} satisfies NonNullable<PluginStatus['settings']>;

const perBandPluginSettings = {
  ...mockPluginSettings,
  perBandRules: {
    type: 'keyedStringArrays',
    label: 'Per-band rules',
    scope: 'operator',
    default: {},
    keys: [
      { key: '40m', label: '40m' },
      { key: '20m', label: '20m' },
    ],
    visibleWhen: { setting: 'perBandEnabled', equals: true },
    description: 'perBandRulesDesc',
    descriptionWhen: [
      { when: { setting: 'filterMode', equals: 'regex-keep' }, description: 'perBandRegexDesc' },
    ],
  },
  perBandEnabled: {
    type: 'boolean',
    label: 'Per band',
    scope: 'operator',
    default: false,
  },
} satisfies NonNullable<PluginStatus['settings']>;

const mockPlugin: PluginStatus = {
  name: 'watched-callsign-autocall',
  version: '1.0.0',
  description: 'test plugin',
  type: 'utility',
  instanceScope: 'operator',
  isBuiltIn: false,
  enabled: true,
  loaded: true,
  autoDisabled: false,
  errorCount: 0,
  settings: mockPluginSettings,
};

const perBandPlugin: PluginStatus = {
  ...mockPlugin,
  settings: perBandPluginSettings,
};

describe('pluginSettings utils', () => {
  it('treats textarea drafts and normalized arrays as equal for string arrays', () => {
    expect(
      arePluginSettingValuesEqual(
        mockPluginSettings.watchList,
        ' BG6ABC \n\nBA1XYZ ',
        ['BG6ABC', 'BA1XYZ'],
      ),
    ).toBe(true);
  });

  it('normalizes operator string array settings only when saving', () => {
    expect(
      normalizePluginSettingsForSave(
        mockPlugin,
        {
          watchList: ' BG6ABC \n# DX list\n^BH7',
          threshold: -20,
        },
        'operator',
      ),
    ).toEqual({
      watchList: ['BG6ABC', '# DX list', '^BH7'],
    });
  });

  it('keeps non-array values unchanged while filtering by scope', () => {
    expect(
      normalizePluginSettingsForSave(
        mockPlugin,
        {
          watchList: 'BG6ABC',
          threshold: -20,
        },
        'global',
      ),
    ).toEqual({
      threshold: -20,
    });
  });

  it('reports invalid regex in watched callsign rules', () => {
    expect(
      getPluginSettingValidationIssue(
        mockPlugin.name,
        'watchList',
        mockPluginSettings.watchList,
        'BG6ABC\n^(JA\n# comment',
      ),
    ).toEqual({
      key: 'watchListInvalidRegexSyntax',
      params: { line: 2 },
    });
  });

  it('evaluates descriptor visibleWhen conditions', () => {
    expect(isPluginSettingVisible(perBandPluginSettings.perBandRules, { perBandEnabled: false })).toBe(false);
    expect(isPluginSettingVisible(perBandPluginSettings.perBandRules, { perBandEnabled: true })).toBe(true);
  });

  it('selects descriptor conditional descriptions', () => {
    expect(getPluginSettingDescriptionKey(
      mockPlugin.name,
      'perBandRules',
      perBandPluginSettings.perBandRules,
      { filterMode: 'regex-keep' },
    )).toBe('perBandRegexDesc');
    expect(getPluginSettingDescriptionKey(
      mockPlugin.name,
      'perBandRules',
      perBandPluginSettings.perBandRules,
      { filterMode: 'blocklist' },
    )).toBe('perBandRulesDesc');
  });

  it('normalizes keyed string arrays when saving', () => {
    expect(
      normalizePluginSettingsForSave(
        perBandPlugin,
        {
          perBandRules: {
            '40m': ' JA1AAA \n\nBG5DRB ',
            '20m': [' K1ABC ', ''],
          },
          perBandEnabled: true,
        },
        'operator',
      ),
    ).toEqual({
      watchList: [],
      perBandRules: {
        '40m': ['JA1AAA', 'BG5DRB'],
        '20m': ['K1ABC'],
      },
      perBandEnabled: true,
    });
  });

  it('reports invalid regex in callsign filter keyed band rules', () => {
    expect(
      getPluginSettingValidationIssue(
        'callsign-filter',
        'bandFilterRules',
        perBandPluginSettings.perBandRules,
        {
          '40m': '^JA',
          '20m': '[',
        },
        { filterMode: 'regex-keep' },
      ),
    ).toEqual({
      key: 'filterRulesInvalidBandRegexSyntax',
      params: { band: '20m', line: 1 },
    });
  });
});
