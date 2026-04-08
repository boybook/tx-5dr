/**
 * 插件系统 API helper
 * 直接使用 fetch 调用插件 REST 端点，不依赖 @tx5dr/core 的 api 对象
 */

import type { PluginStatus } from '@tx5dr/contracts';

type PluginApiWindow = Window & {
  __TX5DR_API_BASE__?: string;
};

interface OperatorPluginStateResponse {
  operatorId: string;
  currentStrategy: string;
  strategyState: string;
  slots: Record<string, string>;
  context: Record<string, unknown>;
  operatorSettings: Record<string, Record<string, unknown>>;
  plugins: PluginStatus[];
}

function getApiBase(): string {
  // 与 @tx5dr/core 保持一致
  return (window as PluginApiWindow).__TX5DR_API_BASE__ || '/api';
}

function getAuthHeaders(): Record<string, string> {
  const jwt = localStorage.getItem('jwt_token');
  return jwt ? { Authorization: `Bearer ${jwt}` } : {};
}

async function pluginFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getApiBase()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Plugin API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const pluginApi = {
  getPlugins: () => pluginFetch<import('@tx5dr/contracts').PluginSystemSnapshot>('/plugins'),

  getRuntimeInfo: () => pluginFetch<import('@tx5dr/contracts').PluginRuntimeInfo>('/plugins/runtime-info'),

  enablePlugin: (name: string) =>
    pluginFetch(`/plugins/${name}/enable`, { method: 'POST' }),

  disablePlugin: (name: string) =>
    pluginFetch(`/plugins/${name}/disable`, { method: 'POST' }),

  updateGlobalSettings: (name: string, settings: Record<string, unknown>) =>
    pluginFetch(`/plugins/${name}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    }),

  getOperatorSettings: (pluginName: string, operatorId: string) =>
    pluginFetch<{ settings: Record<string, unknown> }>(
      `/plugins/${pluginName}/operator/${operatorId}/settings`
    ),

  getOperatorState: (operatorId: string) =>
    pluginFetch<OperatorPluginStateResponse>(`/plugins/operators/${operatorId}`),

  updateOperatorSettings: (
    pluginName: string,
    operatorId: string,
    settings: Record<string, unknown>,
  ) =>
    pluginFetch(`/plugins/${pluginName}/operator/${operatorId}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    }),

  setOperatorStrategy: (operatorId: string, pluginName: string) =>
    pluginFetch(`/plugins/operators/${operatorId}/strategy`, {
      method: 'PUT',
      body: JSON.stringify({ pluginName }),
    }),

  reload: () =>
    pluginFetch('/plugins/reload', { method: 'POST' }),

  rescan: () =>
    pluginFetch('/plugins/rescan', { method: 'POST' }),
};
