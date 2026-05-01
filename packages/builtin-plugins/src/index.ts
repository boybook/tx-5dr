/**
 * TX-5DR Built-in Plugins
 *
 * All built-in plugins are declared here. Each plugin:
 * - Has its own subdirectory with index.ts + locales/zh.json + locales/en.json
 * - Depends only on @tx5dr/plugin-api, @tx5dr/contracts, and @tx5dr/core
 * - Does NOT import any server-internal modules
 *
 * Legacy migration logic (reading old config.json) is handled by the server
 * host before calling each plugin's onLoad hook.
 */

import type { PluginDefinition } from '@tx5dr/plugin-api';

// ===== Individual plugin imports =====

import {
  autocallIdleFrequencyPlugin,
  autocallIdleFrequencyLocales,
  BUILTIN_AUTOCALL_IDLE_FREQUENCY_PLUGIN_NAME,
} from './autocall-idle-frequency/index.js';

import {
  buildStandardQSODefaultTx6Message,
  normalizeStandardQSOTx6MessageOverride,
  standardQSOStrategyPlugin,
  standardQSOLocales,
  BUILTIN_STANDARD_QSO_PLUGIN_NAME,
  STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING,
} from './standard-qso/index.js';

import {
  snrFilterPlugin,
  snrFilterLocales,
  BUILTIN_SNR_FILTER_PLUGIN_NAME,
} from './snr-filter/index.js';

import {
  noReplyMemoryFilterPlugin,
  noReplyMemoryFilterLocales,
  noReplyMemoryFilterDirPath,
  BUILTIN_NO_REPLY_MEMORY_FILTER_PLUGIN_NAME,
} from './no-reply-memory-filter/index.js';

import {
  callsignFilterPlugin,
  callsignFilterLocales,
} from './callsign-filter/index.js';

import {
  workedStationBiasPlugin,
  workedStationBiasLocales,
} from './worked-station-bias/index.js';

import {
  watchedCallsignAutocallPlugin,
  watchedCallsignAutocallLocales,
} from './watched-callsign-autocall/index.js';

import {
  watchedNoveltyAutocallPlugin,
  watchedNoveltyAutocallLocales,
} from './watched-novelty-autocall/index.js';

import {
  wavelogSyncPlugin,
  wavelogSyncLocales,
  wavelogSyncDirPath,
  BUILTIN_WAVELOG_SYNC_PLUGIN_NAME,
} from './wavelog-sync/index.js';

import {
  qrzSyncPlugin,
  qrzSyncLocales,
  qrzSyncDirPath,
  BUILTIN_QRZ_SYNC_PLUGIN_NAME,
} from './qrz-sync/index.js';

import {
  lotwSyncPlugin,
  lotwSyncLocales,
  lotwSyncDirPath,
  BUILTIN_LOTW_SYNC_PLUGIN_NAME,
} from './lotw-sync/index.js';

import {
  qsoUdpBroadcastPlugin,
  qsoUdpBroadcastLocales,
  BUILTIN_QSO_UDP_BROADCAST_PLUGIN_NAME,
} from './qso-udp-broadcast/index.js';

// ===== Shared types =====

export interface BuiltinPluginEntry {
  definition: PluginDefinition;
  locales: Record<string, Record<string, string>>;
  /** standard-qso is always enabled; other built-ins default to disabled unless overridden */
  enabledByDefault: boolean;
  /** Plugin directory path (built-in plugins with UI static files must provide this via import.meta.url) */
  dirPath?: string;
}

// ===== Named exports =====

export {
  BUILTIN_STANDARD_QSO_PLUGIN_NAME,
  BUILTIN_SNR_FILTER_PLUGIN_NAME,
  STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING,
  buildStandardQSODefaultTx6Message,
  normalizeStandardQSOTx6MessageOverride,
  BUILTIN_WAVELOG_SYNC_PLUGIN_NAME,
  BUILTIN_QRZ_SYNC_PLUGIN_NAME,
  BUILTIN_LOTW_SYNC_PLUGIN_NAME,
  BUILTIN_AUTOCALL_IDLE_FREQUENCY_PLUGIN_NAME,
  BUILTIN_QSO_UDP_BROADCAST_PLUGIN_NAME,
  BUILTIN_NO_REPLY_MEMORY_FILTER_PLUGIN_NAME,
};

// ===== Registry =====

/**
 * All built-in plugins, supplied to PluginManager for unified registration.
 */
export const BUILTIN_PLUGINS: BuiltinPluginEntry[] = [
  {
    definition: standardQSOStrategyPlugin,
    locales: standardQSOLocales,
    enabledByDefault: true,
  },
  {
    definition: snrFilterPlugin,
    locales: snrFilterLocales,
    enabledByDefault: false,
  },
  {
    definition: noReplyMemoryFilterPlugin,
    locales: noReplyMemoryFilterLocales,
    enabledByDefault: false,
    dirPath: noReplyMemoryFilterDirPath,
  },
  {
    definition: callsignFilterPlugin,
    locales: callsignFilterLocales,
    enabledByDefault: false,
  },
  {
    definition: workedStationBiasPlugin,
    locales: workedStationBiasLocales,
    enabledByDefault: false,
  },
  {
    definition: watchedCallsignAutocallPlugin,
    locales: watchedCallsignAutocallLocales,
    enabledByDefault: false,
  },
  {
    definition: watchedNoveltyAutocallPlugin,
    locales: watchedNoveltyAutocallLocales,
    enabledByDefault: false,
  },
  {
    definition: autocallIdleFrequencyPlugin,
    locales: autocallIdleFrequencyLocales,
    enabledByDefault: true,
  },
  {
    definition: wavelogSyncPlugin,
    locales: wavelogSyncLocales,
    enabledByDefault: true,
    dirPath: wavelogSyncDirPath,
  },
  {
    definition: qrzSyncPlugin,
    locales: qrzSyncLocales,
    enabledByDefault: true,
    dirPath: qrzSyncDirPath,
  },
  {
    definition: lotwSyncPlugin,
    locales: lotwSyncLocales,
    enabledByDefault: true,
    dirPath: lotwSyncDirPath,
  },
  {
    definition: qsoUdpBroadcastPlugin,
    locales: qsoUdpBroadcastLocales,
    enabledByDefault: true,
  },
];
