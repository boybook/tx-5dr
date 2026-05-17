import { useEffect, useMemo, useState } from 'react';
import {
  normalizeCallsignFilterMode,
  parseCallsignFilterRules,
  selectCallsignFilterRuleEntries,
  selectDxccBlockEntityCodes,
  getBandFromFrequency,
  type CallsignFilterMode,
  type CallsignFilterRule,
} from '@tx5dr/core';
import { pluginApi } from '../utils/pluginApi';
import { usePluginSnapshot } from './usePluginSnapshot';
import { createLogger } from '../utils/logger';
import { useRadioState } from '../store/radioStore';

const logger = createLogger('useCallsignFilterRules');

const PLUGIN_NAME = 'callsign-filter';

export type CallsignFilterScope = 'auto-reply' | 'auto-reply-and-display';

interface CallsignFilterState {
  rules: CallsignFilterRule[];
  filterMode: CallsignFilterMode;
  filterScope: CallsignFilterScope;
  dxccBlockEnabled: boolean;
  blockedDxccEntityCodes: string[];
}

const EMPTY_STATE: CallsignFilterState = {
  rules: [],
  filterMode: 'blocklist',
  filterScope: 'auto-reply',
  dxccBlockEnabled: false,
  blockedDxccEntityCodes: [],
};

/**
 * Hook that loads the current operator's callsign-filter plugin settings and
 * returns parsed rules plus active mode/scope. Refreshes when the operator
 * changes or the plugin system generation bumps.
 */
export function useCallsignFilterRules(
  operatorId: string | undefined,
): CallsignFilterState {
  const pluginSnapshot = usePluginSnapshot();
  const radio = useRadioState();
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [filterMode, setFilterMode] = useState<CallsignFilterMode>('blocklist');
  const [filterScope, setFilterScope] = useState<CallsignFilterScope>('auto-reply');

  const isEnabled = useMemo(
    () => pluginSnapshot.plugins.some((p) => p.name === PLUGIN_NAME && p.enabled),
    [pluginSnapshot.plugins],
  );

  useEffect(() => {
    if (!operatorId || !isEnabled) {
      setSettings({});
      setFilterMode('blocklist');
      setFilterScope('auto-reply');
      return;
    }

    pluginApi
      .getOperatorState(operatorId)
      .then((res) => {
        const nextSettings = res?.operatorSettings?.[PLUGIN_NAME] ?? {};
        setSettings(nextSettings);
        setFilterMode(normalizeCallsignFilterMode(nextSettings.filterMode));
        setFilterScope(
          nextSettings.filterScope === 'auto-reply-and-display'
            ? 'auto-reply-and-display'
            : 'auto-reply',
        );
      })
      .catch((err: unknown) => {
        logger.debug('Failed to load callsign filter settings', err);
      });
  }, [operatorId, isEnabled, pluginSnapshot.generation]);

  const currentBand = useMemo(() => (
    radio.state.currentRadioFrequency > 0
      ? getBandFromFrequency(radio.state.currentRadioFrequency)
      : undefined
  ), [radio.state.currentRadioFrequency]);

  const rawRules = useMemo(() => selectCallsignFilterRuleEntries({
    perBandEnabled: settings.perBandEnabled,
    filterRules: settings.filterRules,
    bandFilterRules: settings.bandFilterRules,
    band: currentBand,
  }), [currentBand, settings]);

  const rules = useMemo(() => {
    if (rawRules.length === 0) return [];
    return parseCallsignFilterRules(rawRules, filterMode);
  }, [filterMode, rawRules]);

  const blockedDxccEntityCodes = useMemo(
    () => selectDxccBlockEntityCodes({
      perBandEnabled: settings.perBandEnabled,
      blockedDxccEntityCodes: settings.blockedDxccEntityCodes,
      bandBlockedDxccEntityCodes: settings.bandBlockedDxccEntityCodes,
      band: currentBand,
    }),
    [
      currentBand,
      settings.perBandEnabled,
      settings.blockedDxccEntityCodes,
      settings.bandBlockedDxccEntityCodes,
    ],
  );
  const dxccBlockEnabled = settings.dxccBlockEnabled === true && blockedDxccEntityCodes.length > 0;

  if (!isEnabled) return EMPTY_STATE;

  return { rules, filterMode, filterScope, dxccBlockEnabled, blockedDxccEntityCodes };
}
