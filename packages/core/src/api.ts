import type {
  HelloResponse,
  AudioDevicesResponse,
  AudioDeviceSettings,
  AudioDeviceSettingsResponse,
  ModeDescriptor,
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
  LogBookQSOQueryOptions,
  LogBookExportOptions,
  QSORecord,
  UpdateQSORequest,
  QSOActionResponse,
  WaveLogConfig,
  WaveLogTestConnectionRequest,
  WaveLogTestConnectionResponse
} from '@tx5dr/contracts';

// ========== 错误处理 ==========

/**
 * API 错误类
 *
 * 扩展标准 Error，添加用户友好的错误信息和操作建议
 */
export class ApiError extends Error {
  /** 错误代码 */
  code?: string;

  /** 用户友好的错误提示（供UI显示） */
  userMessage: string;

  /** 操作建议列表 */
  suggestions: string[];

  /** 错误严重程度 */
  severity: 'info' | 'warning' | 'error' | 'critical';

  /** HTTP 状态码 */
  httpStatus: number;

  /** 错误上下文 */
  context?: Record<string, any>;

  constructor(
    message: string,
    userMessage: string,
    httpStatus: number,
    options?: {
      code?: string;
      suggestions?: string[];
      severity?: 'info' | 'warning' | 'error' | 'critical';
      context?: Record<string, any>;
    }
  ) {
    super(message);
    this.name = 'ApiError';
    this.userMessage = userMessage;
    this.httpStatus = httpStatus;
    this.code = options?.code;
    this.suggestions = options?.suggestions || [];
    this.severity = options?.severity || 'error';
    this.context = options?.context;
  }
}

/**
 * 统一处理 API 错误响应
 *
 * 从后端错误响应中提取信息，创建 ApiError 实例
 *
 * @param errorData - 后端返回的错误数据
 * @param httpStatus - HTTP 状态码
 * @returns ApiError 实例
 */
export function handleApiError(errorData: any, httpStatus: number): ApiError {
  const {
    message = '操作失败',
    userMessage,
    code,
    suggestions = [],
    severity = 'error',
    context
  } = errorData || {};

  // 记录技术日志
  console.error('[API 错误]', {
    httpStatus,
    code,
    message,
    userMessage,
    severity,
    suggestions,
    context
  });

  return new ApiError(
    message,
    userMessage || message || '操作失败，请稍后重试',
    httpStatus,
    { code, suggestions, severity, context }
  );
}

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

// ========== API 请求辅助函数 ==========

/**
 * 通用 API 请求函数
 *
 * 封装了所有 HTTP 请求的通用逻辑：
 * - 错误处理（增强错误格式）
 * - 网络错误处理
 * - JSON 解析
 * - 统一的响应格式
 *
 * @param url - API 端点（相对路径或绝对路径）
 * @param options - Fetch 选项
 * @param apiBase - 可选的 API 基础 URL
 * @returns 响应数据
 * @throws ApiError - 包含用户友好消息的错误
 */
async function apiRequest<T = any>(
  url: string,
  options?: RequestInit,
  apiBase?: string
): Promise<T> {
  const baseUrl = apiBase || getConfiguredApiBase();
  const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;

  try {
    // 只在有 body 时才添加 Content-Type header（修复 PTT 测试报错）
    const headers: HeadersInit = {
      ...options?.headers,
    };

    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(fullUrl, {
      ...options,
      headers,
    });

    if (!response.ok) {
      // 尝试解析增强错误格式
      try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await response.json();

          // 检查是否有增强的错误格式
          if (data?.error) {
            throw handleApiError(data.error, response.status);
          }

          // 向后兼容：检查旧的错误格式
          if (data?.code || data?.message) {
            throw new ApiError(
              data.message || `HTTP ${response.status}`,
              data.message || '操作失败，请稍后重试',
              response.status,
              {
                code: data.code,
                suggestions: data.suggestions,
                severity: 'error'
              }
            );
          }
        }
      } catch (parseError) {
        // 如果解析失败，且 parseError 已经是 ApiError，直接抛出
        if (parseError instanceof ApiError) {
          throw parseError;
        }
        // 否则创建通用 HTTP 错误
        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}`,
          '操作失败，请检查请求参数',
          response.status,
          {
            code: 'HTTP_ERROR',
            severity: 'error'
          }
        );
      }

      // 如果没有抛出任何错误，创建通用错误
      throw new ApiError(
        `HTTP ${response.status}: ${response.statusText}`,
        '操作失败',
        response.status
      );
    }

    // 解析成功响应
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const result = await response.json();

      // 检查响应中的 success 字段
      if (result.success === false && result.error) {
        throw handleApiError(result.error, response.status);
      }

      return result as T;
    }

    // 非 JSON 响应（如文本）
    return (await response.text()) as any;

  } catch (error) {
    // 网络错误（fetch 失败）
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new ApiError(
        '网络请求失败',
        '无法连接到服务器，请检查网络连接',
        0,
        {
          code: 'NETWORK_ERROR',
          suggestions: ['检查网络连接', '确认服务器是否运行'],
          severity: 'error'
        }
      );
    }

    // 如果已经是 ApiError，直接抛出
    if (error instanceof ApiError) {
      throw error;
    }

    // 其他未知错误
    throw new ApiError(
      error instanceof Error ? error.message : String(error),
      '发生未知错误，请稍后重试',
      500,
      {
        code: 'UNKNOWN_ERROR',
        severity: 'error'
      }
    );
  }
}

// ========== API 对象 ==========

export const api = {
  // ========== 基础API ==========
  
  /**
   * 获取Hello消息
   */
  async getHello(apiBase?: string): Promise<HelloResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();

    try {
      const res = await fetch(`${baseUrl}/hello`);

      if (!res.ok) {
        // 尝试解析新的增强错误格式
        try {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await res.json();

            // 检查是否有增强的错误格式
            if (data?.error) {
              throw handleApiError(data.error, res.status);
            }

            // 向后兼容：处理旧的错误格式
            if (data?.code === 'BACKEND_OFFLINE') {
              throw new ApiError(
                'Backend server offline',
                '后端服务器未启动或不可达',
                res.status,
                {
                  code: 'BACKEND_OFFLINE',
                  suggestions: ['检查后端服务是否运行', '查看控制台日志'],
                  severity: 'error'
                }
              );
            }

            if (typeof data?.message === 'string' && data.message) {
              throw new ApiError(
                data.message,
                data.message,
                res.status
              );
            }
          }

          // 检查代理错误头
          const proxyHeader = res.headers.get('x-proxy-error');
          if (proxyHeader === 'backend_offline') {
            throw new ApiError(
              'Backend server offline',
              '后端服务器未启动或不可达',
              res.status,
              {
                code: 'BACKEND_OFFLINE',
                suggestions: ['检查后端服务是否运行', '查看控制台日志'],
                severity: 'error'
              }
            );
          }
        } catch (parseError) {
          // 如果解析失败，且 parseError 已经是 ApiError，直接抛出
          if (parseError instanceof ApiError) {
            throw parseError;
          }
          // 否则创建通用 HTTP 错误
          throw new ApiError(
            `HTTP ${res.status}: ${res.statusText}`,
            '连接服务器失败，请检查网络连接',
            res.status,
            {
              code: 'HTTP_ERROR',
              suggestions: ['检查网络连接', '确认服务器是否运行'],
              severity: 'error'
            }
          );
        }

        // 如果没有抛出任何错误，创建通用错误
        throw new ApiError(
          `HTTP ${res.status}: ${res.statusText}`,
          '连接服务器失败',
          res.status
        );
      }

      return (await res.json()) as HelloResponse;
    } catch (error) {
      // 网络错误（fetch 失败）
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new ApiError(
          '网络请求失败',
          '无法连接到服务器，请检查网络连接',
          0,
          {
            code: 'NETWORK_ERROR',
            suggestions: ['检查网络连接', '确认服务器是否运行'],
            severity: 'error'
          }
        );
      }

      // 如果已经是 ApiError，直接抛出
      if (error instanceof ApiError) {
        throw error;
      }

      // 其他未知错误
      throw new ApiError(
        error instanceof Error ? error.message : String(error),
        '发生未知错误，请稍后重试',
        500,
        {
          code: 'UNKNOWN_ERROR',
          severity: 'error'
        }
      );
    }
  },

  // ========== 音频设备API ==========

  /**
   * 获取所有音频设备列表
   */
  async getAudioDevices(apiBase?: string): Promise<AudioDevicesResponse> {
    return apiRequest<AudioDevicesResponse>('/audio/devices', undefined, apiBase);
  },

  /**
   * 获取当前音频设备设置
   */
  async getAudioSettings(apiBase?: string): Promise<AudioDeviceSettingsResponse> {
    return apiRequest<AudioDeviceSettingsResponse>('/audio/settings', undefined, apiBase);
  },

  /**
   * 更新音频设备设置
   */
  async updateAudioSettings(
    settings: AudioDeviceSettings,
    apiBase?: string
  ): Promise<AudioDeviceSettingsResponse> {
    return apiRequest<AudioDeviceSettingsResponse>(
      '/audio/settings',
      {
        method: 'POST',
        body: JSON.stringify(settings),
      },
      apiBase
    );
  },

  /**
   * 重置音频设备设置
   */
  async resetAudioSettings(apiBase?: string): Promise<AudioDeviceSettingsResponse> {
    return apiRequest<AudioDeviceSettingsResponse>(
      '/audio/settings/reset',
      { method: 'POST' },
      apiBase
    );
  },

  // ========== 电台控制API ==========

  async getRadioConfig(apiBase?: string): Promise<any> {
    return apiRequest('/radio/config', undefined, apiBase);
  },

  async updateRadioConfig(config: any, apiBase?: string): Promise<any> {
    return apiRequest(
      '/radio/config',
      {
        method: 'POST',
        body: JSON.stringify(config),
      },
      apiBase
    );
  },

  async getSupportedRigs(apiBase?: string): Promise<any> {
    return apiRequest('/radio/rigs', undefined, apiBase);
  },

  async getSerialPorts(apiBase?: string): Promise<any> {
    return apiRequest('/radio/serial-ports', undefined, apiBase);
  },

  async testRadio(config: any, apiBase?: string): Promise<any> {
    return apiRequest(
      '/radio/test',
      {
        method: 'POST',
        body: JSON.stringify(config),
      },
      apiBase
    );
  },

  async testPTT(apiBase?: string): Promise<any> {
    return apiRequest('/radio/test-ptt', { method: 'POST' }, apiBase);
  },

  async getRadioStatus(apiBase?: string): Promise<any> {
    return apiRequest('/radio/status', undefined, apiBase);
  },

  async connectRadio(apiBase?: string): Promise<any> {
    return apiRequest('/radio/connect', { method: 'POST' }, apiBase);
  },

  async disconnectRadio(apiBase?: string): Promise<any> {
    return apiRequest('/radio/disconnect', { method: 'POST' }, apiBase);
  },

  async getPresetFrequencies(apiBase?: string): Promise<any> {
    return apiRequest('/radio/frequencies', undefined, apiBase);
  },

  async getLastFrequency(apiBase?: string): Promise<any> {
    return apiRequest('/radio/last-frequency', undefined, apiBase);
  },

  async setRadioFrequency(
    params: {
      frequency: number;
      mode?: string;
      band?: string;
      description?: string;
      radioMode?: string;
    },
    apiBase?: string
  ): Promise<any> {
    return apiRequest(
      '/radio/frequency',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      apiBase
    );
  },

  // ========== 模式管理API ==========

  /**
   * 获取所有可用模式
   */
  async getAvailableModes(apiBase?: string): Promise<{ success: boolean; data: ModeDescriptor[] }> {
    return apiRequest<{ success: boolean; data: ModeDescriptor[] }>('/mode', undefined, apiBase);
  },

  /**
   * 获取当前模式
   */
  async getCurrentMode(apiBase?: string): Promise<{ success: boolean; data: ModeDescriptor }> {
    return apiRequest<{ success: boolean; data: ModeDescriptor }>('/mode/current', undefined, apiBase);
  },

  /**
   * 切换模式
   */
  async switchMode(
    mode: ModeDescriptor,
    apiBase?: string
  ): Promise<{ success: boolean; message: string; data: ModeDescriptor }> {
    return apiRequest<{ success: boolean; message: string; data: ModeDescriptor }>(
      '/mode/switch',
      {
        method: 'POST',
        body: JSON.stringify(mode),
      },
      apiBase
    );
  },

  // ========== 设置管理API ==========

  /**
   * 获取FT8配置
   */
  async getFT8Settings(apiBase?: string): Promise<{ success: boolean; data: any }> {
    return apiRequest<{ success: boolean; data: any }>('/settings/ft8', undefined, apiBase);
  },

  /**
   * 更新FT8配置
   */
  async updateFT8Settings(
    settings: Partial<{
      myCallsign: string;
      myGrid: string;
      frequency: number;
      transmitPower: number;
      autoReply: boolean;
      maxQSOTimeout: number;
      decodeWhileTransmitting: boolean;
      spectrumWhileTransmitting: boolean;
    }>,
    apiBase?: string
  ): Promise<{ success: boolean; message: string; data: any }> {
    return apiRequest<{ success: boolean; message: string; data: any }>(
      '/settings/ft8',
      {
        method: 'PUT',
        body: JSON.stringify(settings),
      },
      apiBase
    );
  },

  // ========== 操作员管理API ==========

  /**
   * 获取所有操作员配置
   */
  async getOperators(apiBase?: string): Promise<RadioOperatorListResponse> {
    return apiRequest<RadioOperatorListResponse>('/operators', undefined, apiBase);
  },

  /**
   * 获取指定操作员配置
   */
  async getOperator(id: string, apiBase?: string): Promise<RadioOperatorDetailResponse> {
    return apiRequest<RadioOperatorDetailResponse>(`/operators/${encodeURIComponent(id)}`, undefined, apiBase);
  },

  /**
   * 创建新操作员
   */
  async createOperator(
    operatorData: CreateRadioOperatorRequest,
    apiBase?: string
  ): Promise<RadioOperatorActionResponse> {
    return apiRequest<RadioOperatorActionResponse>(
      '/operators',
      {
        method: 'POST',
        body: JSON.stringify(operatorData),
      },
      apiBase
    );
  },

  /**
   * 更新操作员配置
   */
  async updateOperator(
    id: string,
    updates: UpdateRadioOperatorRequest,
    apiBase?: string
  ): Promise<RadioOperatorActionResponse> {
    return apiRequest<RadioOperatorActionResponse>(
      `/operators/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(updates),
      },
      apiBase
    );
  },

  /**
   * 删除操作员
   */
  async deleteOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    return apiRequest<{ success: boolean; message: string }>(
      `/operators/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      apiBase
    );
  },

  /**
   * 启动操作员发射
   */
  async startOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    return apiRequest<{ success: boolean; message: string }>(
      `/operators/${encodeURIComponent(id)}/start`,
      { method: 'POST' },
      apiBase
    );
  },

  /**
   * 停止操作员发射
   */
  async stopOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    return apiRequest<{ success: boolean; message: string }>(
      `/operators/${encodeURIComponent(id)}/stop`,
      { method: 'POST' },
      apiBase
    );
  },

  /**
   * 获取操作员运行状态
   */
  async getOperatorStatus(id: string, apiBase?: string): Promise<RadioOperatorStatusResponse> {
    return apiRequest<RadioOperatorStatusResponse>(
      `/operators/${encodeURIComponent(id)}/status`,
      undefined,
      apiBase
    );
  },

  // ========== 日志本管理API ==========

  /**
   * 获取所有日志本列表
   */
  async getLogBooks(apiBase?: string): Promise<LogBookListResponse> {
    return apiRequest<LogBookListResponse>('/logbooks', undefined, apiBase);
  },

  /**
   * 获取特定日志本详情
   */
  async getLogBook(id: string, apiBase?: string): Promise<LogBookDetailResponse> {
    return apiRequest<LogBookDetailResponse>(`/logbooks/${id}`, undefined, apiBase);
  },

  /**
   * 创建新日志本
   */
  async createLogBook(
    logBookData: CreateLogBookRequest,
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    return apiRequest<LogBookActionResponse>(
      '/logbooks',
      {
        method: 'POST',
        body: JSON.stringify(logBookData),
      },
      apiBase
    );
  },

  /**
   * 更新日志本信息
   */
  async updateLogBook(
    id: string,
    updates: UpdateLogBookRequest,
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    return apiRequest<LogBookActionResponse>(
      `/logbooks/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(updates),
      },
      apiBase
    );
  },

  /**
   * 删除日志本
   */
  async deleteLogBook(id: string, apiBase?: string): Promise<LogBookActionResponse> {
    return apiRequest<LogBookActionResponse>(
      `/logbooks/${id}`,
      { method: 'DELETE' },
      apiBase
    );
  },

  /**
   * 连接操作员到日志本
   */
  async connectOperatorToLogBook(
    logBookId: string,
    operatorId: string,
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    return apiRequest<LogBookActionResponse>(
      `/logbooks/${logBookId}/connect`,
      {
        method: 'POST',
        body: JSON.stringify({ operatorId }),
      },
      apiBase
    );
  },

  /**
   * 断开操作员与日志本的连接
   */
  async disconnectOperatorFromLogBook(operatorId: string, apiBase?: string): Promise<LogBookActionResponse> {
    return apiRequest<LogBookActionResponse>(
      `/logbooks/disconnect/${operatorId}`,
      { method: 'POST' },
      apiBase
    );
  },

  /**
   * 查询日志本中的QSO记录
   */
  async getLogBookQSOs(id: string, options?: LogBookQSOQueryOptions, apiBase?: string): Promise<{ success: boolean; data: QSORecord[]; meta?: { total: number; totalRecords: number; offset: number; limit: number; hasFilters: boolean } }> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const params = new URLSearchParams();
    
    if (options) {
      Object.entries(options).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      });
      
      console.log('📊 [API Client] 构建请求参数:', {
        options,
        searchParams: params.toString()
      });
    }
    
    const url = `${baseUrl}/logbooks/${id}/qsos${params.toString() ? '?' + params.toString() : ''}`;
    console.log('📊 [API Client] 请求URL:', url);
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`查询QSO记录失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 导出日志本数据
   */
  async exportLogBook(id: string, options?: LogBookExportOptions, apiBase?: string): Promise<string> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const params = new URLSearchParams();
    
    if (options) {
      Object.entries(options).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      });
    }
    
    const url = `${baseUrl}/logbooks/${id}/export${params.toString() ? '?' + params.toString() : ''}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`导出日志本失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.text();
  },

  /**
   * 导入数据到日志本
   */
  async importToLogBook(id: string, adifContent: string, operatorId?: string, apiBase?: string): Promise<LogBookActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/${id}/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ adifContent, operatorId }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `导入数据失败: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },

  /**
   * 更新单条QSO记录
   */
  async updateQSO(logbookId: string, qsoId: string, updates: UpdateQSORequest, apiBase?: string): Promise<QSOActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/${logbookId}/qsos/${qsoId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新QSO记录失败: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },

  /**
   * 删除单条QSO记录
   */
  async deleteQSO(logbookId: string, qsoId: string, apiBase?: string): Promise<QSOActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/${logbookId}/qsos/${qsoId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `删除QSO记录失败: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },

  // ========== WaveLog同步API ==========

  /**
   * 获取WaveLog配置
   */
  async getWaveLogConfig(apiBase?: string): Promise<WaveLogConfig> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/wavelog/config`);
    if (!res.ok) {
      throw new Error(`获取WaveLog配置失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as WaveLogConfig;
  },

  /**
   * 更新WaveLog配置
   */
  async updateWaveLogConfig(config: Partial<WaveLogConfig>, apiBase?: string): Promise<WaveLogConfig> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/wavelog/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新WaveLog配置失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 测试WaveLog连接
   */
  async testWaveLogConnection(request: WaveLogTestConnectionRequest, apiBase?: string): Promise<WaveLogTestConnectionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/wavelog/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `测试WaveLog连接失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 同步WaveLog数据
   */
  async syncWaveLog(
    operation: 'download' | 'upload' | 'full_sync',
    apiBase?: string
  ): Promise<any> {
    return apiRequest(
      '/wavelog/sync',
      {
        method: 'POST',
        body: JSON.stringify({ operation }),
      },
      apiBase
    );
  },

  /**
   * 重置WaveLog配置
   */
  async resetWaveLogConfig(apiBase?: string): Promise<WaveLogConfig> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/wavelog/config/reset`, {
      method: 'POST',
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `重置WaveLog配置失败: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },
}

// 为了向后兼容,也导出单独的函数
export const {
  getHello,
  getAudioDevices,
  getAudioSettings,
  updateAudioSettings,
  resetAudioSettings,
  getAvailableModes,
  getCurrentMode,
  switchMode,
  // 设置管理函数
  getFT8Settings,
  updateFT8Settings,
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
  importToLogBook,
  updateQSO,
  deleteQSO,
  // WaveLog同步函数
  getWaveLogConfig,
  updateWaveLogConfig,
  testWaveLogConnection,
  syncWaveLog,
  resetWaveLogConfig
  ,getRadioConfig
  ,updateRadioConfig
  ,getSupportedRigs
  ,getSerialPorts
  ,testRadio
  ,testPTT
  ,getPresetFrequencies
  ,getLastFrequency
  ,setRadioFrequency
} = api;
