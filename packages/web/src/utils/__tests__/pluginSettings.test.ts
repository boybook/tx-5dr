import { describe, expect, it } from 'vitest';
import type { PluginStatus } from '@tx5dr/contracts';
import {
  getPluginSettingValidationIssue,
  arePluginSettingValuesEqual,
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
});
