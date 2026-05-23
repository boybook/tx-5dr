/**
 * 插件系统 API helper
 * 直接使用 fetch 调用插件 REST 端点，不依赖 @tx5dr/core 的 api 对象
 */

import type { PluginStatus } from '@tx5dr/contracts';
import { getAuthHeaders } from './authHeaders';

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

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return typeof payload === 'string' && payload.trim() ? payload.trim() : null;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') {
    return record.error;
  }
  if (record.error && typeof record.error === 'object') {
    const errorRecord = record.error as Record<string, unknown>;
    return typeof errorRecord.userMessage === 'string'
      ? errorRecord.userMessage
      : typeof errorRecord.message === 'string'
        ? errorRecord.message
        : null;
  }
  return typeof record.message === 'string' ? record.message : null;
}

async function pluginFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getApiBase()}${path}`;
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, {
    ...options,
    headers: getAuthHeaders(headers),
  });
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const contentType = res.headers.get('Content-Type') ?? '';
      detail = contentType.includes('application/json')
        ? extractErrorMessage(await res.json())
        : await res.text();
    } catch {
      detail = null;
    }
    const suffix = detail && detail.trim() ? ` - ${detail.trim()}` : '';
    throw new Error(`Plugin API error: ${res.status} ${res.statusText}${suffix}`);
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

  setOperatorPluginPaused: (
    pluginName: string,
    operatorId: string,
    paused: boolean,
  ) =>
    pluginFetch<{ success: boolean; operatorId: string; pausedPlugins: string[] }>(
      `/plugins/${pluginName}/operator/${operatorId}/pause`,
      {
        method: 'PUT',
        body: JSON.stringify({ paused }),
      },
    ),

  pauseOperatorTransmitControlPlugins: (operatorId: string) =>
    pluginFetch<{ success: boolean; operatorId: string; pausedPlugins: string[] }>(
      `/plugins/operators/${operatorId}/transmit-control/pause-all`,
      { method: 'POST' },
    ),

  resumeOperatorTransmitControlPlugins: (operatorId: string) =>
    pluginFetch<{ success: boolean; operatorId: string; pausedPlugins: string[] }>(
      `/plugins/operators/${operatorId}/transmit-control/resume-all`,
      { method: 'POST' },
    ),

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
