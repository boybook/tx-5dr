import type { 
  HelloResponse,
  AudioDevicesResponse,
  AudioDeviceSettings,
  AudioDeviceSettingsResponse,
  ModeDescriptor,
  RadioOperatorConfig,
  CreateRadioOperatorRequest,
  UpdateRadioOperatorRequest,
  RadioOperatorListResponse,
  RadioOperatorDetailResponse,
  RadioOperatorActionResponse,
  RadioOperatorStatusResponse,
  LogBookListResponse,
  LogBookDetailResponse,
  LogBookActionResponse,
  CreateLogBookRequest,
  UpdateLogBookRequest,
  ConnectOperatorToLogBookRequest,
  LogBookQSOQueryOptions,
  LogBookExportOptions,
  QSORecord
} from '@tx5dr/contracts';

// ========== API 配置 ==========

/**
 * API 全局配置
 */
class ApiConfig {
  private static instance: ApiConfig;
  private apiBase: string = '/api';

  private constructor() {}

  static getInstance(): ApiConfig {
    if (!ApiConfig.instance) {
      ApiConfig.instance = new ApiConfig();
    }
    return ApiConfig.instance;
  }

  /**
   * 设置 API 基础 URL
   */
  setApiBase(apiBase: string): void {
    this.apiBase = apiBase;
    console.log(`🔧 [API配置] API基础URL已设置为: ${apiBase}`);
  }

  /**
   * 获取当前的 API 基础 URL
   */
  getApiBase(): string {
    return this.apiBase;
  }
}

/**
 * 配置 API 基础 URL
 * 在应用启动时调用，设置正确的 API 基础 URL
 */
export function configureApi(apiBase: string): void {
  ApiConfig.getInstance().setApiBase(apiBase);
}

/**
 * 获取当前配置的 API 基础 URL
 */
function getConfiguredApiBase(): string {
  return ApiConfig.getInstance().getApiBase();
}

/**
 * 统一的请求封装，简化错误处理
 */
async function request<T>(path: string, options: RequestInit & { apiBase?: string; expectText?: boolean } = {}): Promise<T> {
  const { apiBase, expectText, ...fetchOptions } = options;
  const baseUrl = apiBase || getConfiguredApiBase();
  const res = await fetch(`${baseUrl}${path}`, fetchOptions);
  const isJSON = res.headers.get('content-type')?.includes('application/json');
  const data = expectText ? await res.text() : isJSON ? await res.json().catch(() => ({})) : undefined;

  if (!res.ok) {
    const message = typeof data === 'object' && data && 'message' in data ? (data as any).message : `HTTP ${res.status}: ${res.statusText}`;
    throw new Error(message);
  }

  return (data as unknown) as T;
}

// ========== API 对象 ==========

export const api = {
  // ========== 基础API ==========
  
  /**
   * 获取Hello消息
   */
  async getHello(apiBase?: string): Promise<HelloResponse> {
    return request<HelloResponse>('/hello', { apiBase });
  },

  // ========== 音频设备API ==========

  /**
   * 获取所有音频设备列表
   */
  async getAudioDevices(apiBase?: string): Promise<AudioDevicesResponse> {
    return request<AudioDevicesResponse>('/audio/devices', { apiBase });
  },

  /**
   * 获取当前音频设备设置
   */
  async getAudioSettings(apiBase?: string): Promise<AudioDeviceSettingsResponse> {
    return request<AudioDeviceSettingsResponse>('/audio/settings', { apiBase });
  },

  /**
   * 更新音频设备设置
   */
  async updateAudioSettings(
    settings: AudioDeviceSettings,
    apiBase?: string
  ): Promise<AudioDeviceSettingsResponse> {
    return request('/audio/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
      apiBase,
    });
  },

  /**
   * 重置音频设备设置
   */
  async resetAudioSettings(apiBase?: string): Promise<AudioDeviceSettingsResponse> {
    return request<AudioDeviceSettingsResponse>('/audio/settings/reset', { method: 'POST', apiBase });
  },

  // ========== 模式管理API ==========

  /**
   * 获取所有可用模式
   */
  async getAvailableModes(apiBase?: string): Promise<{ success: boolean; data: ModeDescriptor[] }> {
    return request<{ success: boolean; data: ModeDescriptor[] }>('/mode', { apiBase });
  },

  /**
   * 获取当前模式
   */
  async getCurrentMode(apiBase?: string): Promise<{ success: boolean; data: ModeDescriptor }> {
    return request<{ success: boolean; data: ModeDescriptor }>('/mode/current', { apiBase });
  },

  /**
   * 切换模式
   */
  async switchMode(
    mode: ModeDescriptor,
    apiBase?: string
  ): Promise<{ success: boolean; message: string; data: ModeDescriptor }> {
    return request('/mode/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mode),
      apiBase,
    });
  },

  // ========== 操作员管理API ==========

  /**
   * 获取所有操作员配置
   */
  async getOperators(apiBase?: string): Promise<RadioOperatorListResponse> {
    return request<RadioOperatorListResponse>('/operators', { apiBase });
  },

  /**
   * 获取指定操作员配置
   */
  async getOperator(id: string, apiBase?: string): Promise<RadioOperatorDetailResponse> {
    return request<RadioOperatorDetailResponse>(`/operators/${encodeURIComponent(id)}`, { apiBase });
  },

  /**
   * 创建新操作员
   */
  async createOperator(
    operatorData: CreateRadioOperatorRequest,
    apiBase?: string
  ): Promise<RadioOperatorActionResponse> {
    return request('/operators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operatorData),
      apiBase,
    });
  },

  /**
   * 更新操作员配置
   */
  async updateOperator(
    id: string,
    updates: UpdateRadioOperatorRequest,
    apiBase?: string
  ): Promise<RadioOperatorActionResponse> {
    return request(`/operators/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
      apiBase,
    });
  },

  /**
   * 删除操作员
   */
  async deleteOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    return request(`/operators/${encodeURIComponent(id)}`, { method: 'DELETE', apiBase });
  },

  /**
   * 启动操作员发射
   */
  async startOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    return request(`/operators/${encodeURIComponent(id)}/start`, { method: 'POST', apiBase });
  },

  /**
   * 停止操作员发射
   */
  async stopOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    return request(`/operators/${encodeURIComponent(id)}/stop`, { method: 'POST', apiBase });
  },

  /**
   * 获取操作员运行状态
   */
  async getOperatorStatus(id: string, apiBase?: string): Promise<RadioOperatorStatusResponse> {
    return request<RadioOperatorStatusResponse>(`/operators/${encodeURIComponent(id)}/status`, { apiBase });
  },

  // ========== 日志本管理API ==========

  /**
   * 获取所有日志本列表
   */
  async getLogBooks(apiBase?: string): Promise<LogBookListResponse> {
    return request<LogBookListResponse>('/logbooks', { apiBase });
  },

  /**
   * 获取特定日志本详情
   */
  async getLogBook(id: string, apiBase?: string): Promise<LogBookDetailResponse> {
    return request<LogBookDetailResponse>(`/logbooks/${id}`, { apiBase });
  },

  /**
   * 创建新日志本
   */
  async createLogBook(
    logBookData: CreateLogBookRequest,
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    return request('/logbooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logBookData),
      apiBase,
    });
  },

  /**
   * 更新日志本信息
   */
  async updateLogBook(
    id: string,
    updates: UpdateLogBookRequest,
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    return request(`/logbooks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
      apiBase,
    });
  },

  /**
   * 删除日志本
   */
  async deleteLogBook(id: string, apiBase?: string): Promise<LogBookActionResponse> {
    return request(`/logbooks/${id}`, { method: 'DELETE', apiBase });
  },

  /**
   * 连接操作员到日志本
   */
  async connectOperatorToLogBook(
    logBookId: string,
    operatorId: string,
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    return request(`/logbooks/${logBookId}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operatorId }),
      apiBase,
    });
  },

  /**
   * 断开操作员与日志本的连接
   */
  async disconnectOperatorFromLogBook(operatorId: string, apiBase?: string): Promise<LogBookActionResponse> {
    return request(`/logbooks/disconnect/${operatorId}`, { method: 'POST', apiBase });
  },

  /**
   * 查询日志本中的QSO记录
   */
  async getLogBookQSOs(id: string, options?: LogBookQSOQueryOptions, apiBase?: string): Promise<{ success: boolean; data: QSORecord[] }> {
    const params = new URLSearchParams();
    if (options) {
      Object.entries(options).forEach(([k, v]) => { if (v !== undefined && v !== null) params.append(k, String(v)); });
    }
    const query = params.toString();
    return request<{ success: boolean; data: QSORecord[] }>(`/logbooks/${id}/qsos${query ? '?' + query : ''}`, { apiBase });
  },

  /**
   * 导出日志本数据
   */
  async exportLogBook(id: string, options?: LogBookExportOptions, apiBase?: string): Promise<string> {
    const params = new URLSearchParams();
    if (options) {
      Object.entries(options).forEach(([k, v]) => { if (v !== undefined && v !== null) params.append(k, String(v)); });
    }
    const query = params.toString();
    return request<string>(`/logbooks/${id}/export${query ? '?' + query : ''}`, { apiBase, expectText: true });
  },

  /**
   * 导入数据到日志本
   */
  async importToLogBook(id: string, adifContent: string, operatorId?: string, apiBase?: string): Promise<LogBookActionResponse> {
    return request(`/logbooks/${id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adifContent, operatorId }),
      apiBase,
    });
  },
}

// 为了向后兼容，也导出单独的函数
export const {
  getHello,
  getAudioDevices,
  getAudioSettings,
  updateAudioSettings,
  resetAudioSettings,
  getAvailableModes,
  getCurrentMode,
  switchMode,
  // 操作员管理函数
  getOperators,
  getOperator,
  createOperator,
  updateOperator,
  deleteOperator,
  startOperator,
  stopOperator,
  getOperatorStatus,
  // 日志本管理函数
  getLogBooks,
  getLogBook,
  createLogBook,
  updateLogBook,
  deleteLogBook,
  connectOperatorToLogBook,
  disconnectOperatorFromLogBook,
  getLogBookQSOs,
  exportLogBook,
  importToLogBook
} = api; 