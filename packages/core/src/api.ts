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

// ========== API 对象 ==========

export const api = {
  // ========== 基础API ==========
  
  /**
   * 获取Hello消息
   */
  async getHello(apiBase?: string): Promise<HelloResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/hello`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return (await res.json()) as HelloResponse;
  },

  // ========== 音频设备API ==========

  /**
   * 获取所有音频设备列表
   */
  async getAudioDevices(apiBase?: string): Promise<AudioDevicesResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/audio/devices`);
    if (!res.ok) {
      throw new Error(`获取音频设备失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AudioDevicesResponse;
  },

  /**
   * 获取当前音频设备设置
   */
  async getAudioSettings(apiBase?: string): Promise<AudioDeviceSettingsResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/audio/settings`);
    if (!res.ok) {
      throw new Error(`获取音频设置失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AudioDeviceSettingsResponse;
  },

  /**
   * 更新音频设备设置
   */
  async updateAudioSettings(
    settings: AudioDeviceSettings, 
    apiBase?: string
  ): Promise<AudioDeviceSettingsResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/audio/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(settings),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新音频设置失败: ${res.status} ${res.statusText}`);
    }
    
    return (await res.json()) as AudioDeviceSettingsResponse;
  },

  /**
   * 重置音频设备设置
   */
  async resetAudioSettings(apiBase?: string): Promise<AudioDeviceSettingsResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/audio/settings/reset`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      throw new Error(`重置音频设置失败: ${res.status} ${res.statusText}`);
    }
    
    return (await res.json()) as AudioDeviceSettingsResponse;
  },

  // ========== 电台控制API ==========

  async getRadioConfig(apiBase?: string): Promise<any> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/radio/config`);
    return await res.json();
  },

  async updateRadioConfig(config: any, apiBase?: string): Promise<any> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/radio/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return await res.json();
  },

  async getSupportedRigs(apiBase?: string): Promise<any> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/radio/rigs`);
    return await res.json();
  },

  async getSerialPorts(apiBase?: string): Promise<any> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/radio/serial-ports`);
    return await res.json();
  },

  async testRadio(config: any, apiBase?: string): Promise<any> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/radio/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return await res.json();
  },

  async testPTT(apiBase?: string): Promise<any> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/radio/test-ptt`, { method: 'POST' });
    return await res.json();
  },

  async getPresetFrequencies(apiBase?: string): Promise<any> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/radio/frequencies`);
    return await res.json();
  },

  // ========== 模式管理API ==========

  /**
   * 获取所有可用模式
   */
  async getAvailableModes(apiBase?: string): Promise<{ success: boolean; data: ModeDescriptor[] }> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/mode`);
    if (!res.ok) {
      throw new Error(`获取可用模式失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 获取当前模式
   */
  async getCurrentMode(apiBase?: string): Promise<{ success: boolean; data: ModeDescriptor }> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/mode/current`);
    if (!res.ok) {
      throw new Error(`获取当前模式失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 切换模式
   */
  async switchMode(
    mode: ModeDescriptor, 
    apiBase?: string
  ): Promise<{ success: boolean; message: string; data: ModeDescriptor }> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/mode/switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mode),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `切换模式失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  // ========== 操作员管理API ==========

  /**
   * 获取所有操作员配置
   */
  async getOperators(apiBase?: string): Promise<RadioOperatorListResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/operators`);
    if (!res.ok) {
      throw new Error(`获取操作员列表失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as RadioOperatorListResponse;
  },

  /**
   * 获取指定操作员配置
   */
  async getOperator(id: string, apiBase?: string): Promise<RadioOperatorDetailResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/operators/${encodeURIComponent(id)}`);
    if (!res.ok) {
      throw new Error(`获取操作员详情失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as RadioOperatorDetailResponse;
  },

  /**
   * 创建新操作员
   */
  async createOperator(
    operatorData: CreateRadioOperatorRequest, 
    apiBase?: string
  ): Promise<RadioOperatorActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(operatorData),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `创建操作员失败: ${res.status} ${res.statusText}`);
    }
    
    return (await res.json()) as RadioOperatorActionResponse;
  },

  /**
   * 更新操作员配置
   */
  async updateOperator(
    id: string,
    updates: UpdateRadioOperatorRequest, 
    apiBase?: string
  ): Promise<RadioOperatorActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/operators/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新操作员失败: ${res.status} ${res.statusText}`);
    }
    
    return (await res.json()) as RadioOperatorActionResponse;
  },

  /**
   * 删除操作员
   */
  async deleteOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/operators/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `删除操作员失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 启动操作员发射
   */
  async startOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/operators/${encodeURIComponent(id)}/start`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `启动操作员失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 停止操作员发射
   */
  async stopOperator(id: string, apiBase?: string): Promise<{ success: boolean; message: string }> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/operators/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `停止操作员失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 获取操作员运行状态
   */
  async getOperatorStatus(id: string, apiBase?: string): Promise<RadioOperatorStatusResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/operators/${encodeURIComponent(id)}/status`);
    if (!res.ok) {
      throw new Error(`获取操作员状态失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  // ========== 日志本管理API ==========

  /**
   * 获取所有日志本列表
   */
  async getLogBooks(apiBase?: string): Promise<LogBookListResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks`);
    if (!res.ok) {
      throw new Error(`获取日志本列表失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 获取特定日志本详情
   */
  async getLogBook(id: string, apiBase?: string): Promise<LogBookDetailResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/${id}`);
    if (!res.ok) {
      throw new Error(`获取日志本详情失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 创建新日志本
   */
  async createLogBook(
    logBookData: CreateLogBookRequest, 
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(logBookData),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `创建日志本失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 更新日志本信息
   */
  async updateLogBook(
    id: string,
    updates: UpdateLogBookRequest, 
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新日志本失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 删除日志本
   */
  async deleteLogBook(id: string, apiBase?: string): Promise<LogBookActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/${id}`, {
      method: 'DELETE',
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `删除日志本失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 连接操作员到日志本
   */
  async connectOperatorToLogBook(
    logBookId: string,
    operatorId: string, 
    apiBase?: string
  ): Promise<LogBookActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/${logBookId}/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operatorId }),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `连接操作员到日志本失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 断开操作员与日志本的连接
   */
  async disconnectOperatorFromLogBook(operatorId: string, apiBase?: string): Promise<LogBookActionResponse> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const res = await fetch(`${baseUrl}/logbooks/disconnect/${operatorId}`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `断开操作员连接失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 查询日志本中的QSO记录
   */
  async getLogBookQSOs(id: string, options?: LogBookQSOQueryOptions, apiBase?: string): Promise<{ success: boolean; data: QSORecord[] }> {
    const baseUrl = apiBase || getConfiguredApiBase();
    const params = new URLSearchParams();
    
    if (options) {
      Object.entries(options).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      });
    }
    
    const url = `${baseUrl}/logbooks/${id}/qsos${params.toString() ? '?' + params.toString() : ''}`;
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
  ,getRadioConfig
  ,updateRadioConfig
  ,getSupportedRigs
  ,getSerialPorts
  ,testRadio
  ,testPTT
  ,getPresetFrequencies
} = api;
