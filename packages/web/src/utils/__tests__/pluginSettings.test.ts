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
  perBandTaskRows: {
    type: 'keyedObjectArrays',
    label: 'Per-band tasks',
    scope: 'operator',
    default: {},
    keys: [
      { key: '40m', label: '40m' },
      { key: '20m', label: '20m' },
    ],
    itemFields: [
      { key: 'enabled', type: 'boolean', label: 'Enabled' },
      { key: 'time', type: 'string', label: 'Time' },
      { key: 'count', type: 'number', label: 'Count' },
    ],
    visibleWhen: { setting: 'perBandEnabled', equals: true },
  },
  perBandIntervalRows: {
    type: 'keyedObjects',
    label: 'Per-band intervals',
    scope: 'operator',
    default: {},
    keys: [
      { key: '40m', label: '40m' },
      { key: '20m', label: '20m' },
    ],
    itemFields: [
      { key: 'enabled', type: 'boolean', label: 'Enabled', default: false },
      { key: 'intervalMinutes', type: 'number', label: 'Interval', default: 30 },
    ],
    visibleWhen: { setting: 'perBandEnabled', equals: true },
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

const dxccPluginSettings = {
  ...mockPluginSettings,
  blockedDxccEntityCodes: {
    type: 'string[]',
    label: 'Blocked DXCC',
    scope: 'operator',
    default: [],
    options: [
      { label: 'Japan (339)', value: '339' },
      { label: 'China (318)', value: '318' },
    ],
    visibleWhen: {
      allOf: [
        { setting: 'dxccBlockEnabled', equals: true },
        { setting: 'perBandEnabled', notEquals: true },
      ],
    },
  },
  bandBlockedDxccEntityCodes: {
    type: 'keyedStringArrays',
    label: 'Blocked DXCC by band',
    scope: 'operator',
    default: {},
    keys: [
      { key: '40m', label: '40m' },
      { key: '20m', label: '20m' },
    ],
    options: [
      { label: 'Japan (339)', value: '339' },
      { label: 'China (318)', value: '318' },
    ],
    visibleWhen: {
      anyOf: [
        {
          allOf: [
            { setting: 'dxccBlockEnabled', equals: true },
            { setting: 'perBandEnabled', equals: true },
          ],
        },
      ],
    },
  },
  dxccBlockEnabled: {
    type: 'boolean',
    label: 'DXCC block',
    scope: 'operator',
    default: false,
  },
} satisfies NonNullable<PluginStatus['settings']>;

const dxccPlugin: PluginStatus = {
  ...mockPlugin,
  settings: dxccPluginSettings,
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


  it('normalizes string array option selections when saving', () => {
    expect(
      normalizePluginSettingsForSave(
        dxccPlugin,
        {
          watchList: [],
          dxccBlockEnabled: true,
          blockedDxccEntityCodes: [' 339 ', '318', ''],
        },
        'operator',
      ),
    ).toEqual({
      watchList: [],
      blockedDxccEntityCodes: ['339', '318'],
      bandBlockedDxccEntityCodes: {},
      dxccBlockEnabled: true,
    });
  });

  it('evaluates visibleWhen for string array option selections', () => {
    expect(isPluginSettingVisible(dxccPluginSettings.blockedDxccEntityCodes, { dxccBlockEnabled: false })).toBe(false);
    expect(isPluginSettingVisible(dxccPluginSettings.blockedDxccEntityCodes, { dxccBlockEnabled: true, perBandEnabled: false })).toBe(true);
    expect(isPluginSettingVisible(dxccPluginSettings.blockedDxccEntityCodes, { dxccBlockEnabled: true, perBandEnabled: true })).toBe(false);
  });

  it('evaluates composite visibleWhen conditions for per-band DXCC selections', () => {
    expect(isPluginSettingVisible(dxccPluginSettings.bandBlockedDxccEntityCodes, {
      dxccBlockEnabled: false,
      perBandEnabled: true,
    })).toBe(false);
    expect(isPluginSettingVisible(dxccPluginSettings.bandBlockedDxccEntityCodes, {
      dxccBlockEnabled: true,
      perBandEnabled: false,
    })).toBe(false);
    expect(isPluginSettingVisible(dxccPluginSettings.bandBlockedDxccEntityCodes, {
      dxccBlockEnabled: true,
      perBandEnabled: true,
    })).toBe(true);
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

  it('normalizes keyed string array option selections when saving', () => {
    expect(
      normalizePluginSettingsForSave(
        dxccPlugin,
        {
          watchList: [],
          dxccBlockEnabled: true,
          bandBlockedDxccEntityCodes: {
            '40m': [' 339 ', '', '318'],
            '30m': '291, 110',
            '20m': [],
          },
        },
        'operator',
      ),
    ).toEqual({
      watchList: [],
      blockedDxccEntityCodes: [],
      bandBlockedDxccEntityCodes: {
        '40m': ['339', '318'],
        '30m': ['291', '110'],
      },
      dxccBlockEnabled: true,
    });
  });

  it('normalizes keyed object arrays when saving', () => {
    expect(
      normalizePluginSettingsForSave(
        perBandPlugin,
        {
          perBandEnabled: true,
          perBandTaskRows: {
            '40m': [
              { id: 'empty', enabled: false, time: '', count: '' },
              { id: 'task-1', enabled: true, time: ' 08:30 ', count: '2' },
            ],
            '20m': [],
          },
        },
        'operator',
      ),
    ).toMatchObject({
      perBandTaskRows: {
        '40m': [{ id: 'task-1', enabled: true, time: '08:30', count: 2 }],
      },
    });
  });

  it('normalizes keyed objects while omitting default-only rows when saving', () => {
    expect(
      normalizePluginSettingsForSave(
        perBandPlugin,
        {
          perBandEnabled: true,
          perBandIntervalRows: {
            '40m': { enabled: false, intervalMinutes: 30 },
            '20m': { enabled: true, intervalMinutes: '15' },
          },
        },
        'operator',
      ),
    ).toMatchObject({
      perBandIntervalRows: {
        '20m': { enabled: true, intervalMinutes: 15 },
      },
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
