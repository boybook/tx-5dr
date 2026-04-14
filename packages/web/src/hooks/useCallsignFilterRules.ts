import { useEffect, useMemo, useState } from 'react';
import {
  parseCallsignFilterRules,
  type CallsignFilterRule,
} from '@tx5dr/core';
import { pluginApi } from '../utils/pluginApi';
import { usePluginSnapshot } from './usePluginSnapshot';
import { createLogger } from '../utils/logger';

const logger = createLogger('useCallsignFilterRules');

const PLUGIN_NAME = 'callsign-filter';

export type CallsignFilterScope = 'auto-reply' | 'auto-reply-and-display';

interface CallsignFilterState {
  rules: CallsignFilterRule[];
  filterScope: CallsignFilterScope;
}

const EMPTY_STATE: CallsignFilterState = {
  rules: [],
  filterScope: 'auto-reply',
};

/**
 * Hook that loads the current operator's callsign-filter plugin settings and
 * returns parsed rules + filterScope. Refreshes when the operator changes or
 * the plugin system generation bumps.
 */
export function useCallsignFilterRules(
  operatorId: string | undefined,
): CallsignFilterState {
  const pluginSnapshot = usePluginSnapshot();
  const [rawRules, setRawRules] = useState<string[]>([]);
  const [filterScope, setFilterScope] = useState<CallsignFilterScope>('auto-reply');

  const isEnabled = useMemo(
    () => pluginSnapshot.plugins.some((p) => p.name === PLUGIN_NAME && p.enabled),
    [pluginSnapshot.plugins],
  );

  useEffect(() => {
    if (!operatorId || !isEnabled) {
      setRawRules([]);
      setFilterScope('auto-reply');
      return;
    }

    pluginApi
      .getOperatorState(operatorId)
      .then((res) => {
        const settings = res?.operatorSettings?.[PLUGIN_NAME] ?? {};
        const entries = Array.isArray(settings.filterRules) ? settings.filterRules as string[] : [];
        setRawRules(entries);
        setFilterScope(
          settings.filterScope === 'auto-reply-and-display'
            ? 'auto-reply-and-display'
            : 'auto-reply',
        );
      })
      .catch((err: unknown) => {
        logger.debug('Failed to load callsign filter settings', err);
      });
  }, [operatorId, isEnabled, pluginSnapshot.generation]);

  const rules = useMemo(() => {
    if (rawRules.length === 0) return [];
    return parseCallsignFilterRules(rawRules);
  }, [rawRules]);

  if (!isEnabled) return EMPTY_STATE;

  return { rules, filterScope };
}
