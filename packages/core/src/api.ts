import { createLogger } from './utils/logger.js';

const logger = createLogger('API');

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
  CreateQSORequest,
  QSOActionResponse,
  WaveLogConfig,
  WaveLogTestConnectionRequest,
  WaveLogTestConnectionResponse,
  QRZConfig,
  QRZTestConnectionRequest,
  QRZTestConnectionResponse,
  QRZSyncResponse,
  LoTWConfig,
  LoTWTestConnectionRequest,
  LoTWTestConnectionResponse,
  LoTWCertificateImportResponse,
  LoTWCertificateDeleteResponse,
  LoTWUploadPreflightRequest,
  LoTWUploadPreflightResponse,
  LoTWSyncResponse,
  LoTWSyncStatus,
  TunerCapabilities,
  TunerStatus,
  RadioConfigResponse,
  UpdateRadioConfigResponse,
  SupportedRigsResponse,
  RigConfigSchemaResponse,
  SerialPortsResponse,
  TestResponse,
  RadioStatusResponse,
  ConnectRadioResponse,
  DisconnectRadioResponse,
  FrequencyListResponse,
  LastFrequencyResponse,
  SetFrequencyResponse,
  HamlibConfig,
  PSKReporterConfig,
  PSKReporterStatus,
  ProfileListResponse,
  ProfileActionResponse,
  ActivateProfileResponse,
  CreateProfileRequest,
  UpdateProfileRequest,
  LoginResponse,
  PasswordLoginRequest,
  AuthStatus,
  AuthMeResponse,
  TokenInfo,
  CreateTokenRequest,
  CreateTokenResponse,
  UpdateTokenRequest,
  UpdateSelfLoginCredentialRequest,
  UpdateAuthConfigRequest,
  NetworkInfo,
  PresetFrequency,
  StationInfo,
  StationInfoResponse,
  OpenWebRXStationConfig,
  OpenWebRXTestResult,
  OpenWebRXListenStatus,
  OpenWebRXListenStart,
  OpenWebRXListenTune,
  RealtimeConnectivityErrorCode,
  RealtimeConnectivityHints,
  RealtimeSettings,
  RealtimeTransportKind,
  RealtimeSessionRequest,
  RealtimeSessionResponse,
  RealtimeStatsRequest,
  RealtimeStatsResponse,
} from '@tx5dr/contracts';

type RealtimeSettingsApiData = RealtimeSettings & {
  runtime?: {
    liveKitEnabled: boolean;
    connectivityHints: RealtimeConnectivityHints;
    radioReceiveTransport: RealtimeTransportKind;
    radioBridgeHealthy: boolean;
    radioBridgeIssueCode: RealtimeConnectivityErrorCode | null;
    credentialStatus: {
      initialized: boolean;
      source: 'managed-file' | 'environment-override' | 'missing';
      filePath: string | null;
      apiKeyPreview: string | null;
      createdAt: string | null;
      rotatedAt: string | null;
    };
  };
};

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
  context?: Record<string, unknown>;

  constructor(
    message: string,
    userMessage: string,
    httpStatus: number,
    options?: {
      code?: string;
      suggestions?: string[];
      severity?: 'info' | 'warning' | 'error' | 'critical';
      context?: Record<string, unknown>;
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
export function handleApiError(errorData: unknown, httpStatus: number): ApiError {
  // 类型守卫：确保 errorData 是对象
  const data = (typeof errorData === 'object' && errorData !== null) ? errorData as Record<string, unknown> : {};

  const message = typeof data.message === 'string' ? data.message : 'Operation failed';
  const userMessage = typeof data.userMessage === 'string' ? data.userMessage : undefined;
  const code = typeof data.code === 'string' ? data.code : undefined;
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions.filter((s): s is string => typeof s === 'string') : [];
  const severity = (data.severity === 'info' || data.severity === 'warning' || data.severity === 'error' || data.severity === 'critical')
    ? data.severity
    : 'error';
  const context = (typeof data.context === 'object' && data.context !== null) ? data.context as Record<string, unknown> : undefined;

  // 记录技术日志
  logger.error('API error', {
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
    userMessage || message || 'Operation failed, please try again later',
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
  private jwtToken: string | null = null;

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
    logger.debug(`API base URL set to: ${apiBase}`);
  }

  /**
   * 获取当前的 API 基础 URL
   */
  getApiBase(): string {
    return this.apiBase;
  }

  /**
   * 设置 JWT Token（用于认证请求）
   */
  setJwtToken(token: string | null): void {
    this.jwtToken = token;
  }

  /**
   * 获取当前 JWT Token
   */
  getJwtToken(): string | null {
    return this.jwtToken;
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
 * 设置 API JWT Token（登录成功后调用）
 */
export function configureAuthToken(token: string | null): void {
  ApiConfig.getInstance().setJwtToken(token);
}

/**
 * 获取当前配置的 API 基础 URL
 */
function getConfiguredApiBase(): string {
  return ApiConfig.getInstance().getApiBase();
}

// ========== API 请求辅助函数 ==========

/**
 * 返回带 Authorization 头的对象（如已设置 JWT）
 * 用于那些未走 apiRequest 的裸 fetch 调用
 */
function getAuthHeaders(): Record<string, string> {
  const jwt = ApiConfig.getInstance().getJwtToken();
  return jwt ? { Authorization: `Bearer ${jwt}` } : {};
}


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
async function apiRequest<T = unknown>(
  url: string,
  options?: globalThis.RequestInit,
  apiBase?: string
): Promise<T> {
  const baseUrl = apiBase || getConfiguredApiBase();
  const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;

  try {
    // 只在有 body 时才添加 Content-Type header（修复 PTT 测试报错）
    const headers: Record<string, string> = {
      ...(options?.headers as Record<string, string>),
    };

    const isFormDataBody = typeof FormData !== 'undefined' && options?.body instanceof FormData;
    if (options?.body && !isFormDataBody && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    // 自动注入 JWT Token（如果已配置）
    const jwt = ApiConfig.getInstance().getJwtToken();
    if (jwt && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${jwt}`;
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
              data.message || 'Operation failed, please try again later',
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
          'Operation failed, please check request parameters',
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
        'Operation failed',
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
    return (await response.text()) as T;

  } catch (error) {
    // 网络错误（fetch 失败）
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new ApiError(
        'Network request failed',
        'Unable to connect to server, please check network connection',
        0,
        {
          code: 'NETWORK_ERROR',
          suggestions: ['Check network connection', 'Confirm server is running'],
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
      'An unknown error occurred, please try again later',
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
                'Backend server not started or unreachable',
                res.status,
                {
                  code: 'BACKEND_OFFLINE',
                  suggestions: ['Check if backend service is running', 'Check console logs'],
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
              'Backend server not started or unreachable',
              res.status,
              {
                code: 'BACKEND_OFFLINE',
                suggestions: ['Check if backend service is running', 'Check console logs'],
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
            'Failed to connect to server, please check network connection',
            res.status,
            {
              code: 'HTTP_ERROR',
              suggestions: ['Check network connection', 'Confirm server is running'],
              severity: 'error'
            }
          );
        }

        // 如果没有抛出任何错误，创建通用错误
        throw new ApiError(
          `HTTP ${res.status}: ${res.statusText}`,
          'Failed to connect to server',
          res.status
        );
      }

      return (await res.json()) as HelloResponse;
    } catch (error) {
      // 网络错误（fetch 失败）
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new ApiError(
          'Network request failed',
          'Unable to connect to server, please check network connection',
          0,
          {
            code: 'NETWORK_ERROR',
            suggestions: ['Check network connection', 'Confirm server is running'],
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
        'An unknown error occurred, please try again later',
        500,
        {
          code: 'UNKNOWN_ERROR',
          severity: 'error'
        }
      );
    }
  },

  // ========== 认证API ==========

  /**
   * 获取认证状态（是否启用、是否允许公开查看）
   * 无需认证
   */
  async getAuthStatus(apiBase?: string): Promise<AuthStatus> {
    return apiRequest<AuthStatus>('/auth/status', undefined, apiBase);
  },

  /**
   * Token 登录（返回 JWT）
   * 无需认证
   */
  async login(token: string, apiBase?: string): Promise<LoginResponse> {
    return apiRequest<LoginResponse>(
      '/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ token }),
      },
      apiBase
    );
  },

  /**
   * 用户名密码登录（返回 JWT）
   * 无需认证
   */
  async loginWithPassword(credentials: PasswordLoginRequest, apiBase?: string): Promise<LoginResponse> {
    return apiRequest<LoginResponse>(
      '/auth/login-password',
      {
        method: 'POST',
        body: JSON.stringify(credentials),
      },
      apiBase
    );
  },

  /**
   * 获取当前用户信息
   * 需要认证
   */
  async getAuthMe(apiBase?: string): Promise<AuthMeResponse> {
    return apiRequest<AuthMeResponse>('/auth/me', undefined, apiBase);
  },

  /**
   * 获取所有 Token 列表（Admin）
   */
  async getTokens(apiBase?: string): Promise<TokenInfo[]> {
    return apiRequest<TokenInfo[]>('/auth/tokens', undefined, apiBase);
  },

  /**
   * 创建新 Token（Admin）
   */
  async createToken(req: CreateTokenRequest, apiBase?: string): Promise<CreateTokenResponse> {
    return apiRequest<CreateTokenResponse>(
      '/auth/tokens',
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
      apiBase
    );
  },

  /**
   * 更新 Token（Admin）
   */
  async updateToken(tokenId: string, updates: UpdateTokenRequest, apiBase?: string): Promise<TokenInfo> {
    return apiRequest<TokenInfo>(
      `/auth/tokens/${encodeURIComponent(tokenId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updates),
      },
      apiBase
    );
  },

  /**
   * 撤销 Token（Admin）
   */
  async revokeToken(tokenId: string, apiBase?: string): Promise<{ success: boolean }> {
    return apiRequest<{ success: boolean }>(
      `/auth/tokens/${encodeURIComponent(tokenId)}`,
      { method: 'DELETE' },
      apiBase
    );
  },

  /**
   * 重新生成系统令牌（Admin）
   */
  async regenerateToken(tokenId: string, apiBase?: string): Promise<CreateTokenResponse> {
    return apiRequest<CreateTokenResponse>(
      `/auth/tokens/${encodeURIComponent(tokenId)}/regenerate`,
      { method: 'POST' },
      apiBase
    );
  },

  /**
   * 更新认证配置（Admin）
   */
  async updateAuthConfig(updates: UpdateAuthConfigRequest, apiBase?: string): Promise<AuthStatus> {
    return apiRequest<AuthStatus>(
      '/auth/config',
      {
        method: 'PATCH',
        body: JSON.stringify(updates),
      },
      apiBase
    );
  },

  /**
   * 更新当前用户绑定的账号密码登录方式
   */
  async updateSelfLoginCredential(
    updates: UpdateSelfLoginCredentialRequest,
    apiBase?: string,
  ): Promise<AuthMeResponse> {
    return apiRequest<AuthMeResponse>(
      '/auth/me/login-credential',
      {
        method: 'PUT',
        body: JSON.stringify(updates),
      },
      apiBase,
    );
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

  async getRadioConfig(apiBase?: string): Promise<RadioConfigResponse> {
    return apiRequest<RadioConfigResponse>('/radio/config', undefined, apiBase);
  },

  async updateRadioConfig(config: HamlibConfig, apiBase?: string): Promise<UpdateRadioConfigResponse> {
    return apiRequest<UpdateRadioConfigResponse>(
      '/radio/config',
      {
        method: 'POST',
        body: JSON.stringify(config),
      },
      apiBase
    );
  },

  async getSupportedRigs(apiBase?: string): Promise<SupportedRigsResponse> {
    return apiRequest<SupportedRigsResponse>('/radio/rigs', undefined, apiBase);
  },

  async getRigConfigSchema(rigModel: number, apiBase?: string): Promise<RigConfigSchemaResponse> {
    return apiRequest<RigConfigSchemaResponse>(`/radio/rigs/${encodeURIComponent(String(rigModel))}/config-schema`, undefined, apiBase);
  },

  async getSerialPorts(apiBase?: string): Promise<SerialPortsResponse> {
    return apiRequest<SerialPortsResponse>('/radio/serial-ports', undefined, apiBase);
  },

  async testRadio(config: HamlibConfig, apiBase?: string): Promise<TestResponse> {
    return apiRequest<TestResponse>(
      '/radio/test',
      {
        method: 'POST',
        body: JSON.stringify(config),
      },
      apiBase
    );
  },

  async testPTT(config: HamlibConfig, apiBase?: string): Promise<TestResponse> {
    return apiRequest<TestResponse>(
      '/radio/test-ptt',
      {
        method: 'POST',
        body: JSON.stringify(config),
      },
      apiBase
    );
  },

  async getRadioStatus(apiBase?: string): Promise<RadioStatusResponse> {
    return apiRequest<RadioStatusResponse>('/radio/status', undefined, apiBase);
  },

  async connectRadio(apiBase?: string): Promise<ConnectRadioResponse> {
    return apiRequest<ConnectRadioResponse>('/radio/connect', { method: 'POST' }, apiBase);
  },

  async disconnectRadio(apiBase?: string): Promise<DisconnectRadioResponse> {
    return apiRequest<DisconnectRadioResponse>('/radio/disconnect', { method: 'POST' }, apiBase);
  },

  async getPresetFrequencies(apiBase?: string): Promise<FrequencyListResponse> {
    return apiRequest<FrequencyListResponse>('/radio/frequencies', undefined, apiBase);
  },

  async getLastFrequency(apiBase?: string): Promise<LastFrequencyResponse> {
    return apiRequest<LastFrequencyResponse>('/radio/last-frequency', undefined, apiBase);
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
  ): Promise<SetFrequencyResponse> {
    return apiRequest<SetFrequencyResponse>(
      '/radio/frequency',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      apiBase
    );
  },

  // ========== 天调控制API ==========

  /**
   * 获取天调能力
   */
  async getTunerCapabilities(apiBase?: string): Promise<{ success: boolean; capabilities: TunerCapabilities }> {
    return apiRequest<{ success: boolean; capabilities: TunerCapabilities }>(
      '/radio/tuner/capabilities',
      undefined,
      apiBase
    );
  },

  /**
   * 获取天调状态
   */
  async getTunerStatus(apiBase?: string): Promise<{ success: boolean; status: TunerStatus }> {
    return apiRequest<{ success: boolean; status: TunerStatus }>(
      '/radio/tuner/status',
      undefined,
      apiBase
    );
  },

  /**
   * 设置天调开关
   */
  async setTuner(enabled: boolean, apiBase?: string): Promise<{ success: boolean; message: string }> {
    return apiRequest<{ success: boolean; message: string }>(
      '/radio/tuner',
      {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      },
      apiBase
    );
  },

  /**
   * 启动手动调谐
   */
  async startTuning(apiBase?: string): Promise<{ success: boolean; message: string }> {
    return apiRequest<{ success: boolean; message: string }>(
      '/radio/tuner/tune',
      { method: 'POST' },
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
   *
   * 注意：FT8Settings 类型尚未在 contracts 中定义
   */
  async getFT8Settings(apiBase?: string): Promise<{ success: boolean; data: unknown }> {
    return apiRequest<{ success: boolean; data: unknown }>('/settings/ft8', undefined, apiBase);
  },

  /**
   * 更新FT8配置
   *
   * 注意：FT8Settings 类型尚未在 contracts 中定义
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
  ): Promise<{ success: boolean; message: string; data: unknown }> {
    return apiRequest<{ success: boolean; message: string; data: unknown }>(
      '/settings/ft8',
      {
        method: 'PUT',
        body: JSON.stringify(settings),
      },
      apiBase
    );
  },

  // ========== 解码窗口设置 ==========

  /**
   * 获取解码窗口设置
   */
  async getDecodeWindowSettings(apiBase?: string): Promise<{
    success: boolean;
    data: {
      settings: Record<string, unknown>;
      resolved: Record<string, number[]>;
    };
  }> {
    return apiRequest('/settings/decode-windows', undefined, apiBase);
  },

  /**
   * 更新解码窗口设置
   */
  async updateDecodeWindowSettings(
    settings: Record<string, unknown>,
    apiBase?: string
  ): Promise<{
    success: boolean;
    message: string;
    data: {
      settings: Record<string, unknown>;
      resolved: Record<string, number[]>;
    };
  }> {
    return apiRequest(
      '/settings/decode-windows',
      {
        method: 'PUT',
        body: JSON.stringify(settings),
      },
      apiBase
    );
  },

  async getRealtimeSettings(apiBase?: string): Promise<{
    success: boolean;
    data: RealtimeSettingsApiData;
  }> {
    return apiRequest('/settings/realtime', undefined, apiBase);
  },

  async updateRealtimeSettings(
    settings: RealtimeSettings,
    apiBase?: string
  ): Promise<{
    success: boolean;
    message: string;
    data: RealtimeSettingsApiData;
  }> {
    return apiRequest(
      '/settings/realtime',
      {
        method: 'PUT',
        body: JSON.stringify(settings),
      },
      apiBase
    );
  },

  // ========== 频率预设管理 ==========

  async getFrequencyPresets(apiBase?: string): Promise<{
    success: boolean;
    presets: PresetFrequency[];
    isCustomized: boolean;
  }> {
    return apiRequest('/settings/frequency-presets', undefined, apiBase);
  },

  async updateFrequencyPresets(
    presets: PresetFrequency[],
    apiBase?: string
  ): Promise<{
    success: boolean;
    message: string;
    presets: PresetFrequency[];
    isCustomized: boolean;
  }> {
    return apiRequest(
      '/settings/frequency-presets',
      {
        method: 'PUT',
        body: JSON.stringify({ presets }),
      },
      apiBase
    );
  },

  async resetFrequencyPresets(apiBase?: string): Promise<{
    success: boolean;
    message: string;
    presets: PresetFrequency[];
    isCustomized: boolean;
  }> {
    return apiRequest(
      '/settings/frequency-presets',
      { method: 'DELETE' },
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

      logger.debug('Building QSO query params:', {
        options,
        searchParams: params.toString()
      });
    }

    const url = `${baseUrl}/logbooks/${id}/qsos${params.toString() ? '?' + params.toString() : ''}`;
    logger.debug('Request URL:', url);
    const res = await fetch(url, { headers: getAuthHeaders() });
    
    if (!res.ok) {
      throw new Error(`Failed to query QSO records: ${res.status} ${res.statusText}`);
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
    const res = await fetch(url, { headers: getAuthHeaders() });
    
    if (!res.ok) {
      throw new Error(`Failed to export logbook: ${res.status} ${res.statusText}`);
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
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ adifContent, operatorId }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to import data: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },

  /**
   * 手动补录新 QSO 记录
   */
  async createQSO(logbookId: string, data: CreateQSORequest, apiBase?: string): Promise<QSOActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/${logbookId}/qsos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to create QSO record: ${res.status} ${res.statusText}`);
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
        ...getAuthHeaders(),
      },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to update QSO record: ${res.status} ${res.statusText}`);
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
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to delete QSO record: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },

  // ========== 按呼号同步配置 API ==========

  /**
   * 获取呼号的同步配置总览
   */
  async getCallsignSyncConfig(callsign: string, apiBase?: string): Promise<unknown> {
    return apiRequest(`/sync/${encodeURIComponent(callsign)}/config`, undefined, apiBase);
  },

  /**
   * 获取呼号的同步摘要
   */
  async getCallsignSyncSummary(callsign: string, apiBase?: string): Promise<unknown> {
    return apiRequest(`/sync/${encodeURIComponent(callsign)}/summary`, undefined, apiBase);
  },

  // ========== WaveLog同步API（按呼号） ==========

  /**
   * 获取WaveLog配置
   */
  async getWaveLogConfig(callsign: string, apiBase?: string): Promise<WaveLogConfig> {
    return apiRequest<WaveLogConfig>(
      `/sync/${encodeURIComponent(callsign)}/wavelog/config`,
      undefined,
      apiBase
    );
  },

  /**
   * 更新WaveLog配置
   */
  async updateWaveLogConfig(callsign: string, config: Partial<WaveLogConfig>, apiBase?: string): Promise<WaveLogConfig> {
    return apiRequest<WaveLogConfig>(
      `/sync/${encodeURIComponent(callsign)}/wavelog/config`,
      { method: 'PUT', body: JSON.stringify(config) },
      apiBase
    );
  },

  /**
   * 测试WaveLog连接
   */
  async testWaveLogConnection(callsign: string, request: WaveLogTestConnectionRequest, apiBase?: string): Promise<WaveLogTestConnectionResponse> {
    return apiRequest<WaveLogTestConnectionResponse>(
      `/sync/${encodeURIComponent(callsign)}/wavelog/test`,
      { method: 'POST', body: JSON.stringify(request) },
      apiBase
    );
  },

  /**
   * 同步WaveLog数据
   */
  async syncWaveLog(
    callsign: string,
    operation: 'download' | 'upload' | 'full_sync',
    apiBase?: string
  ): Promise<{ success: boolean; message: string }> {
    return apiRequest<{ success: boolean; message: string }>(
      `/sync/${encodeURIComponent(callsign)}/wavelog/sync`,
      {
        method: 'POST',
        body: JSON.stringify({ operation }),
      },
      apiBase
    );
  },

  /**
   * 获取WaveLog同步状态
   */
  async getWaveLogSyncStatus(callsign: string, apiBase?: string): Promise<unknown> {
    return apiRequest(`/sync/${encodeURIComponent(callsign)}/wavelog/status`, undefined, apiBase);
  },

  // ========== QRZ.com Logbook API（按呼号） ==========

  async getQRZConfig(callsign: string, apiBase?: string): Promise<QRZConfig> {
    return apiRequest<QRZConfig>(
      `/sync/${encodeURIComponent(callsign)}/qrz/config`,
      undefined,
      apiBase
    );
  },

  async updateQRZConfig(callsign: string, config: Partial<QRZConfig>, apiBase?: string): Promise<QRZConfig> {
    return apiRequest<QRZConfig>(
      `/sync/${encodeURIComponent(callsign)}/qrz/config`,
      { method: 'PUT', body: JSON.stringify(config) },
      apiBase
    );
  },

  async testQRZConnection(callsign: string, request: QRZTestConnectionRequest, apiBase?: string): Promise<QRZTestConnectionResponse> {
    return apiRequest<QRZTestConnectionResponse>(
      `/sync/${encodeURIComponent(callsign)}/qrz/test`,
      { method: 'POST', body: JSON.stringify(request) },
      apiBase
    );
  },

  async syncQRZ(
    callsign: string,
    operation: 'upload' | 'download' | 'full_sync',
    apiBase?: string
  ): Promise<QRZSyncResponse> {
    return apiRequest<QRZSyncResponse>(
      `/sync/${encodeURIComponent(callsign)}/qrz/sync`,
      { method: 'POST', body: JSON.stringify({ operation }) },
      apiBase
    );
  },

  /**
   * 获取QRZ同步状态
   */
  async getQRZSyncStatus(callsign: string, apiBase?: string): Promise<unknown> {
    return apiRequest(`/sync/${encodeURIComponent(callsign)}/qrz/status`, undefined, apiBase);
  },

  // ========== LoTW API（按呼号） ==========

  async getLoTWConfig(callsign: string, apiBase?: string): Promise<LoTWConfig> {
    return apiRequest<LoTWConfig>(
      `/sync/${encodeURIComponent(callsign)}/lotw/config`,
      undefined,
      apiBase
    );
  },

  async updateLoTWConfig(callsign: string, config: Partial<LoTWConfig>, apiBase?: string): Promise<LoTWConfig> {
    return apiRequest<LoTWConfig>(
      `/sync/${encodeURIComponent(callsign)}/lotw/config`,
      { method: 'PUT', body: JSON.stringify(config) },
      apiBase
    );
  },

  async testLoTWConnection(callsign: string, request: LoTWTestConnectionRequest, apiBase?: string): Promise<LoTWTestConnectionResponse> {
    return apiRequest<LoTWTestConnectionResponse>(
      `/sync/${encodeURIComponent(callsign)}/lotw/test`,
      { method: 'POST', body: JSON.stringify(request) },
      apiBase
    );
  },

  async importLoTWCertificate(callsign: string, file: File, apiBase?: string): Promise<LoTWCertificateImportResponse> {
    const formData = new FormData();
    formData.append('certificate', file);
    return apiRequest<LoTWCertificateImportResponse>(
      `/sync/${encodeURIComponent(callsign)}/lotw/certificates/import`,
      { method: 'POST', body: formData },
      apiBase
    );
  },

  async deleteLoTWCertificate(callsign: string, certId: string, apiBase?: string): Promise<LoTWCertificateDeleteResponse> {
    return apiRequest<LoTWCertificateDeleteResponse>(
      `/sync/${encodeURIComponent(callsign)}/lotw/certificates/${encodeURIComponent(certId)}`,
      { method: 'DELETE' },
      apiBase
    );
  },

  async getLoTWUploadPreflight(
    callsign: string,
    request?: LoTWUploadPreflightRequest,
    apiBase?: string
  ): Promise<LoTWUploadPreflightResponse> {
    return apiRequest<LoTWUploadPreflightResponse>(
      `/sync/${encodeURIComponent(callsign)}/lotw/upload-preflight`,
      { method: 'POST', body: JSON.stringify(request || {}) },
      apiBase
    );
  },

  async syncLoTW(
    callsign: string,
    operation: 'upload' | 'download_confirmations',
    since?: string,
    apiBase?: string
  ): Promise<LoTWSyncResponse> {
    return apiRequest<LoTWSyncResponse>(
      `/sync/${encodeURIComponent(callsign)}/lotw/sync`,
      { method: 'POST', body: JSON.stringify({ operation, since }) },
      apiBase
    );
  },

  /**
   * 获取LoTW同步状态
   */
  async getLoTWSyncStatus(callsign: string, apiBase?: string): Promise<LoTWSyncStatus> {
    return apiRequest<LoTWSyncStatus>(`/sync/${encodeURIComponent(callsign)}/lotw/status`, undefined, apiBase);
  },

  /**
   * 获取日志本数据目录路径
   */
  async getLogbookDataPath(apiBase?: string): Promise<{ path: string }> {
    return apiRequest<{ path: string }>('/logbooks/data-path', undefined, apiBase);
  },

  // ========== PSKReporter API ==========

  /**
   * 获取 PSKReporter 配置
   */
  async getPSKReporterConfig(apiBase?: string): Promise<{ success: boolean; data: PSKReporterConfig }> {
    return apiRequest<{ success: boolean; data: PSKReporterConfig }>(
      '/pskreporter/config',
      undefined,
      apiBase
    );
  },

  /**
   * 更新 PSKReporter 配置
   */
  async updatePSKReporterConfig(
    config: Partial<PSKReporterConfig>,
    apiBase?: string
  ): Promise<{ success: boolean; message: string; data: PSKReporterConfig }> {
    return apiRequest<{ success: boolean; message: string; data: PSKReporterConfig }>(
      '/pskreporter/config',
      {
        method: 'PUT',
        body: JSON.stringify(config),
      },
      apiBase
    );
  },

  /**
   * 获取 PSKReporter 运行状态
   */
  async getPSKReporterStatus(apiBase?: string): Promise<{ success: boolean; data: PSKReporterStatus }> {
    return apiRequest<{ success: boolean; data: PSKReporterStatus }>(
      '/pskreporter/status',
      undefined,
      apiBase
    );
  },

  /**
   * 手动触发 PSKReporter 上报
   */
  async triggerPSKReport(apiBase?: string): Promise<{ success: boolean; message: string; data: PSKReporterStatus }> {
    return apiRequest<{ success: boolean; message: string; data: PSKReporterStatus }>(
      '/pskreporter/report',
      { method: 'POST' },
      apiBase
    );
  },

  /**
   * 重置 PSKReporter 统计信息
   */
  async resetPSKReporterStats(apiBase?: string): Promise<{ success: boolean; message: string }> {
    return apiRequest<{ success: boolean; message: string }>(
      '/pskreporter/reset-stats',
      { method: 'POST' },
      apiBase
    );
  },

  // ========== Profile 管理 API ==========

  async getProfiles(apiBase?: string): Promise<ProfileListResponse> {
    return apiRequest<ProfileListResponse>('/profiles', undefined, apiBase);
  },

  async createProfile(data: CreateProfileRequest, apiBase?: string): Promise<ProfileActionResponse> {
    return apiRequest<ProfileActionResponse>(
      '/profiles',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
      apiBase
    );
  },

  async updateProfile(id: string, data: UpdateProfileRequest, apiBase?: string): Promise<ProfileActionResponse> {
    return apiRequest<ProfileActionResponse>(
      `/profiles/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      },
      apiBase
    );
  },

  async deleteProfile(id: string, apiBase?: string): Promise<{ success: boolean }> {
    return apiRequest<{ success: boolean }>(
      `/profiles/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      apiBase
    );
  },

  async reorderProfiles(profileIds: string[], apiBase?: string): Promise<{ success: boolean }> {
    return apiRequest<{ success: boolean }>(
      '/profiles/reorder',
      {
        method: 'PUT',
        body: JSON.stringify({ profileIds }),
      },
      apiBase
    );
  },

  async activateProfile(id: string, apiBase?: string): Promise<ActivateProfileResponse> {
    return apiRequest<ActivateProfileResponse>(
      `/profiles/${encodeURIComponent(id)}/activate`,
      { method: 'POST' },
      apiBase
    );
  },

  // ========== 系统信息 ==========

  async getNetworkInfo(apiBase?: string): Promise<NetworkInfo> {
    return apiRequest<NetworkInfo>('/system/network-info', undefined, apiBase);
  },

  // ========== 电台站基础信息 ==========

  async getStationInfo(apiBase?: string): Promise<StationInfoResponse> {
    return apiRequest<StationInfoResponse>('/station/info', undefined, apiBase);
  },

  async updateStationInfo(data: StationInfo, apiBase?: string): Promise<StationInfoResponse> {
    return apiRequest<StationInfoResponse>('/station/info', {
      method: 'PUT',
      body: JSON.stringify(data),
    }, apiBase);
  },

  // ===== OpenWebRX SDR 站点管理 =====

  async getOpenWebRXStations(apiBase?: string): Promise<{ stations: OpenWebRXStationConfig[] }> {
    return apiRequest<{ stations: OpenWebRXStationConfig[] }>('/openwebrx/stations', undefined, apiBase);
  },

  async addOpenWebRXStation(data: Omit<OpenWebRXStationConfig, 'id'>, apiBase?: string): Promise<{ success: boolean; station: OpenWebRXStationConfig }> {
    return apiRequest<{ success: boolean; station: OpenWebRXStationConfig }>('/openwebrx/stations', {
      method: 'POST',
      body: JSON.stringify(data),
    }, apiBase);
  },

  async updateOpenWebRXStation(id: string, data: Partial<Omit<OpenWebRXStationConfig, 'id'>>, apiBase?: string): Promise<{ success: boolean }> {
    return apiRequest<{ success: boolean }>(`/openwebrx/stations/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }, apiBase);
  },

  async removeOpenWebRXStation(id: string, apiBase?: string): Promise<{ success: boolean }> {
    return apiRequest<{ success: boolean }>(`/openwebrx/stations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }, apiBase);
  },

  async testOpenWebRXUrl(url: string, apiBase?: string): Promise<OpenWebRXTestResult> {
    return apiRequest<OpenWebRXTestResult>('/openwebrx/test-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }, apiBase);
  },

  async startOpenWebRXListen(options: OpenWebRXListenStart, apiBase?: string): Promise<{ success: boolean; status: OpenWebRXListenStatus }> {
    return apiRequest<{ success: boolean; status: OpenWebRXListenStatus }>('/openwebrx/listen/start', {
      method: 'POST',
      body: JSON.stringify(options),
    }, apiBase);
  },

  async stopOpenWebRXListen(apiBase?: string): Promise<{ success: boolean }> {
    return apiRequest<{ success: boolean }>('/openwebrx/listen/stop', {
      method: 'POST',
    }, apiBase);
  },

  async tuneOpenWebRXListen(options: OpenWebRXListenTune, apiBase?: string): Promise<{ success: boolean }> {
    return apiRequest<{ success: boolean }>('/openwebrx/listen/tune', {
      method: 'POST',
      body: JSON.stringify(options),
    }, apiBase);
  },

  async getOpenWebRXListenStatus(apiBase?: string): Promise<{ status: OpenWebRXListenStatus | null }> {
    return apiRequest<{ status: OpenWebRXListenStatus | null }>('/openwebrx/listen/status', undefined, apiBase);
  },

  async getRealtimeSession(body: RealtimeSessionRequest, apiBase?: string): Promise<RealtimeSessionResponse> {
    return apiRequest<RealtimeSessionResponse>('/realtime/session', {
      method: 'POST',
      body: JSON.stringify(body),
    }, apiBase);
  },

  async getRealtimeStats(query: RealtimeStatsRequest, apiBase?: string): Promise<RealtimeStatsResponse> {
    const params = new URLSearchParams({
      scope: query.scope,
      ...(query.previewSessionId ? { previewSessionId: query.previewSessionId } : {}),
    });
    return apiRequest<RealtimeStatsResponse>(`/realtime/stats?${params.toString()}`, undefined, apiBase);
  },
}

// 为了向后兼容,也导出单独的函数
export const {
  // 认证函数
  getAuthStatus,
  login,
  getAuthMe,
  getTokens,
  createToken,
  updateToken: updateAuthToken,
  revokeToken,
  regenerateToken,
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
  createQSO,
  updateQSO,
  deleteQSO,
  // 按呼号同步配置函数
  getCallsignSyncConfig,
  getCallsignSyncSummary,
  // WaveLog同步函数
  getWaveLogConfig,
  updateWaveLogConfig,
  testWaveLogConnection,
  syncWaveLog,
  getWaveLogSyncStatus,
  // QRZ.com同步函数
  getQRZConfig,
  updateQRZConfig,
  testQRZConnection,
  syncQRZ,
  getQRZSyncStatus,
  // LoTW同步函数
  getLoTWConfig,
  updateLoTWConfig,
  testLoTWConnection,
  importLoTWCertificate,
  deleteLoTWCertificate,
  getLoTWUploadPreflight,
  syncLoTW,
  getLoTWSyncStatus,
  // 日志本数据路径
  getLogbookDataPath
  ,getRadioConfig
  ,updateRadioConfig
  ,getSupportedRigs
  ,getSerialPorts
  ,testRadio
  ,testPTT
  ,getPresetFrequencies
  ,getLastFrequency
  ,setRadioFrequency
  // 天调控制函数
  ,getTunerCapabilities
  ,getTunerStatus
  ,setTuner
  ,startTuning
  // PSKReporter 函数
  ,getPSKReporterConfig
  ,updatePSKReporterConfig
  ,getPSKReporterStatus
  ,triggerPSKReport
  ,resetPSKReporterStats
  // Profile 管理函数
  ,getProfiles
  ,createProfile
  ,updateProfile: updateProfile
  ,deleteProfile
  ,reorderProfiles
  ,activateProfile
  // 电台站基础信息函数
  ,getStationInfo
  ,updateStationInfo
  // OpenWebRX SDR 函数
  ,getOpenWebRXStations
  ,addOpenWebRXStation
  ,updateOpenWebRXStation
  ,removeOpenWebRXStation
  ,testOpenWebRXUrl
  ,startOpenWebRXListen
  ,stopOpenWebRXListen
  ,tuneOpenWebRXListen
  ,getOpenWebRXListenStatus
  ,getRealtimeSession
  ,getRealtimeStats
} = api;
