import type { PluginDefinition } from '@tx5dr/plugin-api';
import {
  evaluateCallsignFilter,
  evaluateDxccBlocklist,
  listDXCCEntities,
  normalizeCallsignFilterMode,
  parseCallsignFilterRules,
  selectCallsignFilterRuleEntries,
  selectDxccBlockEntityCodes,
} from '@tx5dr/core';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

function getSenderCallsign(message: unknown): string {
  if (typeof message === 'object' && message !== null && 'senderCallsign' in message) {
    const callsign = (message as { senderCallsign?: unknown }).senderCallsign;
    return typeof callsign === 'string' ? callsign : '';
  }
  return '';
}

export const CALLSIGN_FILTER_BANDS = [
  '160m',
  '80m',
  '60m',
  '40m',
  '30m',
  '20m',
  '17m',
  '15m',
  '12m',
  '10m',
  '6m',
  '2m',
  '70cm',
] as const;

const callsignFilterBandKeys = CALLSIGN_FILTER_BANDS.map((band) => ({
  key: band,
  label: band,
}));

const dxccEntityOptions = listDXCCEntities()
  .filter((entity) => typeof entity.entityCode === 'number')
  .map((entity) => ({
    label: `${entity.flag ? `${entity.flag} ` : ''}${entity.name} (${entity.entityCode})`,
    value: String(entity.entityCode),
  }));

export const callsignFilterPlugin: PluginDefinition = {
  name: 'callsign-filter',
  version: '1.0.0',
  type: 'utility',
  description: 'Filter candidate stations by callsign or advanced regex keep rules',

  settings: {
    perBandEnabled: {
      type: 'boolean',
      default: false,
      label: 'perBandEnabled',
      description: 'perBandEnabledDesc',
      scope: 'operator',
    },
    filterOverview: {
      type: 'info',
      default: '',
      label: 'filterOverview',
      description: 'filterOverviewDesc',
      scope: 'operator',
    },
    filterMode: {
      type: 'string',
      default: 'blocklist',
      label: 'filterMode',
      description: 'filterModeDesc',
      scope: 'operator',
      options: [
        { label: 'filterModeBlocklist', value: 'blocklist' },
        { label: 'filterModeRegexKeep', value: 'regex-keep' },
      ],
    },
    filterRules: {
      type: 'string[]',
      default: [],
      label: 'filterRules',
      description: 'filterRulesDesc',
      descriptionWhen: [
        {
          when: { setting: 'filterMode', equals: 'regex-keep' },
          description: 'filterRulesRegexKeepDesc',
        },
        {
          when: { setting: 'filterMode', notEquals: 'regex-keep' },
          description: 'filterRulesBlocklistDesc',
        },
      ],
      scope: 'operator',
      visibleWhen: { setting: 'perBandEnabled', notEquals: true },
    },
    bandFilterRules: {
      type: 'keyedStringArrays',
      default: {},
      label: 'bandFilterRules',
      description: 'bandFilterRulesDesc',
      descriptionWhen: [
        {
          when: { setting: 'filterMode', equals: 'regex-keep' },
          description: 'bandFilterRulesRegexKeepDesc',
        },
        {
          when: { setting: 'filterMode', notEquals: 'regex-keep' },
          description: 'bandFilterRulesBlocklistDesc',
        },
      ],
      scope: 'operator',
      keys: callsignFilterBandKeys,
      visibleWhen: { setting: 'perBandEnabled', equals: true },
    },
    dxccBlockEnabled: {
      type: 'boolean',
      default: false,
      label: 'dxccBlockEnabled',
      description: 'dxccBlockEnabledDesc',
      scope: 'operator',
    },
    blockedDxccEntityCodes: {
      type: 'string[]',
      default: [],
      label: 'blockedDxccEntityCodes',
      description: 'blockedDxccEntityCodesDesc',
      scope: 'operator',
      options: dxccEntityOptions,
      visibleWhen: {
        allOf: [
          { setting: 'dxccBlockEnabled', equals: true },
          { setting: 'perBandEnabled', notEquals: true },
        ],
      },
    },
    bandBlockedDxccEntityCodes: {
      type: 'keyedStringArrays',
      default: {},
      label: 'bandBlockedDxccEntityCodes',
      description: 'bandBlockedDxccEntityCodesDesc',
      scope: 'operator',
      keys: callsignFilterBandKeys,
      options: dxccEntityOptions,
      visibleWhen: {
        allOf: [
          { setting: 'dxccBlockEnabled', equals: true },
          { setting: 'perBandEnabled', equals: true },
        ],
      },
    },
    filterScope: {
      type: 'string',
      default: 'auto-reply',
      label: 'filterScope',
      description: 'filterScopeDesc',
      scope: 'operator',
      options: [
        { label: 'scopeAutoReply', value: 'auto-reply' },
        { label: 'scopeAutoReplyAndDisplay', value: 'auto-reply-and-display' },
      ],
    },
  },

  quickSettings: [
    { settingKey: 'perBandEnabled' },
    { settingKey: 'filterMode' },
    { settingKey: 'dxccBlockEnabled' },
    { settingKey: 'filterRules' },
    { settingKey: 'filterScope' },
  ],

  hooks: {
    onFilterCandidates(candidates, ctx) {
      const rawEntries = selectCallsignFilterRuleEntries({
        perBandEnabled: ctx.config.perBandEnabled,
        filterRules: ctx.config.filterRules,
        bandFilterRules: ctx.config.bandFilterRules,
        band: ctx.radio.band,
      });
      const filterMode = normalizeCallsignFilterMode(ctx.config.filterMode);
      const rules = parseCallsignFilterRules(rawEntries, filterMode);
      const dxccBlockEnabled = ctx.config.dxccBlockEnabled === true;
      const blockedDxccCodes = selectDxccBlockEntityCodes({
        perBandEnabled: ctx.config.perBandEnabled,
        blockedDxccEntityCodes: ctx.config.blockedDxccEntityCodes,
        bandBlockedDxccEntityCodes: ctx.config.bandBlockedDxccEntityCodes,
        band: ctx.radio.band,
      });
      const dxccFilterActive = dxccBlockEnabled && blockedDxccCodes.length > 0;
      if (rules.length === 0 && !dxccFilterActive) {
        return candidates;
      }

      const filtered = candidates.filter((candidate) => {
        const sender = getSenderCallsign(candidate.message);
        const passesCallsignRules = rules.length === 0
          ? true
          : Boolean(sender) && evaluateCallsignFilter(sender, rules);
        return passesCallsignRules && evaluateDxccBlocklist({
          dxccBlockEnabled: dxccFilterActive,
          blockedDxccEntityCodes: blockedDxccCodes,
          dxccId: candidate.logbookAnalysis?.dxccId,
          callsign: sender,
        });
      });

      ctx.log.debug('Callsign filter applied', {
        before: candidates.length,
        after: filtered.length,
        ruleCount: rules.length,
        mode: filterMode,
        perBandEnabled: ctx.config.perBandEnabled === true,
        dxccBlockEnabled,
        blockedDxccCount: blockedDxccCodes.length,
        band: ctx.radio.band,
      });

      return filtered;
    },
  },
};

export const callsignFilterLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};
