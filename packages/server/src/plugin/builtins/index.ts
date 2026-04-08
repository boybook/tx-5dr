/**
 * 内置插件注册表
 *
 * 所有内置插件在此统一声明。每个内置插件：
 * - 有独立子目录（standard-qso/, snr-filter/, ...）
 * - 目录内包含 index.ts + locales/zh.json + locales/en.json
 * - 翻译通过 import JSON 编译进 bundle，无运行时文件 I/O
 * - 与用户第三方插件目录结构完全一致，可作为插件范本
 *
 * 新增内置插件时：
 * 1. 在 builtins/ 下创建新目录
 * 2. 在此文件添加 export
 * 3. 在 PluginManager 的 BUILTIN_PLUGINS 数组中注册
 */

export {
  standardQSOStrategyPlugin,
  standardQSOLocales,
  BUILTIN_STANDARD_QSO_PLUGIN_NAME,
} from './standard-qso/index.js';

export {
  snrFilterPlugin,
  snrFilterLocales,
} from './snr-filter/index.js';

export {
  callsignPrefixFilterPlugin,
  callsignPrefixFilterLocales,
} from './callsign-prefix-filter/index.js';

export {
  workedStationBiasPlugin,
  workedStationBiasLocales,
} from './worked-station-bias/index.js';

export {
  qsoSessionInspectorPlugin,
  qsoSessionInspectorLocales,
} from './qso-session-inspector/index.js';

export {
  heartbeatDemoPlugin,
  heartbeatDemoLocales,
} from './heartbeat-demo/index.js';

export {
  watchedCallsignAutocallPlugin,
  watchedCallsignAutocallLocales,
} from './watched-callsign-autocall/index.js';

import { standardQSOStrategyPlugin, standardQSOLocales } from './standard-qso/index.js';
import { snrFilterPlugin, snrFilterLocales } from './snr-filter/index.js';
import { callsignPrefixFilterPlugin, callsignPrefixFilterLocales } from './callsign-prefix-filter/index.js';
import { workedStationBiasPlugin, workedStationBiasLocales } from './worked-station-bias/index.js';
import { qsoSessionInspectorPlugin, qsoSessionInspectorLocales } from './qso-session-inspector/index.js';
import { heartbeatDemoPlugin, heartbeatDemoLocales } from './heartbeat-demo/index.js';
import { watchedCallsignAutocallPlugin, watchedCallsignAutocallLocales } from './watched-callsign-autocall/index.js';
import type { PluginDefinition } from '@tx5dr/plugin-api';

export interface BuiltinPluginEntry {
  definition: PluginDefinition;
  locales: Record<string, Record<string, string>>;
  /** standard-qso 始终启用；其他内置插件默认禁用，用户可手动启用 */
  enabledByDefault: boolean;
}

/**
 * 所有内置插件列表，供 PluginManager 统一注册
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
    definition: callsignPrefixFilterPlugin,
    locales: callsignPrefixFilterLocales,
    enabledByDefault: false,
  },
  {
    definition: workedStationBiasPlugin,
    locales: workedStationBiasLocales,
    enabledByDefault: false,
  },
  {
    definition: qsoSessionInspectorPlugin,
    locales: qsoSessionInspectorLocales,
    enabledByDefault: false,
  },
  {
    definition: heartbeatDemoPlugin,
    locales: heartbeatDemoLocales,
    enabledByDefault: false,
  },
  {
    definition: watchedCallsignAutocallPlugin,
    locales: watchedCallsignAutocallLocales,
    enabledByDefault: false,
  },
];
