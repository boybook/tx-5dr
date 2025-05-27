import type { 
  HelloResponse,
  AudioDevicesResponse,
  AudioDeviceSettings,
  AudioDeviceSettingsResponse,
  FT8ConfigUpdate,
  ServerConfigUpdate
} from '@tx5dr/contracts';

// API客户端类
export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
  }

  // ========== 基础API ==========
  
  /**
   * 获取Hello消息
   */
  async getHello(): Promise<HelloResponse> {
    const res = await fetch(`${this.baseUrl}/hello`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return (await res.json()) as HelloResponse;
  }

  // ========== 音频设备API ==========
  
  /**
   * 获取所有音频设备列表
   */
  async getAudioDevices(): Promise<AudioDevicesResponse> {
    const res = await fetch(`${this.baseUrl}/audio/devices`);
    if (!res.ok) {
      throw new Error(`获取音频设备失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AudioDevicesResponse;
  }

  /**
   * 获取当前音频设备设置
   */
  async getAudioSettings(): Promise<AudioDeviceSettingsResponse> {
    const res = await fetch(`${this.baseUrl}/audio/settings`);
    if (!res.ok) {
      throw new Error(`获取音频设置失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AudioDeviceSettingsResponse;
  }

  /**
   * 更新音频设备设置
   */
  async updateAudioSettings(settings: AudioDeviceSettings): Promise<AudioDeviceSettingsResponse> {
    const res = await fetch(`${this.baseUrl}/audio/settings`, {
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
  }

  /**
   * 重置音频设备设置
   */
  async resetAudioSettings(): Promise<AudioDeviceSettingsResponse> {
    const res = await fetch(`${this.baseUrl}/audio/settings/reset`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      throw new Error(`重置音频设置失败: ${res.status} ${res.statusText}`);
    }
    
    return (await res.json()) as AudioDeviceSettingsResponse;
  }

  // ========== 配置管理API ==========
  
  /**
   * 获取完整配置
   */
  async getConfig(): Promise<{ success: boolean; data: any }> {
    const res = await fetch(`${this.baseUrl}/config`);
    if (!res.ok) {
      throw new Error(`获取配置失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  /**
   * 获取FT8配置
   */
  async getFT8Config(): Promise<{ success: boolean; data: any }> {
    const res = await fetch(`${this.baseUrl}/config/ft8`);
    if (!res.ok) {
      throw new Error(`获取FT8配置失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  /**
   * 更新FT8配置
   */
  async updateFT8Config(config: FT8ConfigUpdate): Promise<{ success: boolean; message: string; data: any }> {
    const res = await fetch(`${this.baseUrl}/config/ft8`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新FT8配置失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  }

  /**
   * 获取服务器配置
   */
  async getServerConfig(): Promise<{ success: boolean; data: any }> {
    const res = await fetch(`${this.baseUrl}/config/server`);
    if (!res.ok) {
      throw new Error(`获取服务器配置失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  /**
   * 更新服务器配置
   */
  async updateServerConfig(config: ServerConfigUpdate): Promise<{ success: boolean; message: string; data: any }> {
    const res = await fetch(`${this.baseUrl}/config/server`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新服务器配置失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  }

  /**
   * 验证配置
   */
  async validateConfig(): Promise<{ success: boolean; data: { isValid: boolean; errors: string[] } }> {
    const res = await fetch(`${this.baseUrl}/config/validate`);
    if (!res.ok) {
      throw new Error(`验证配置失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  /**
   * 重置配置
   */
  async resetConfig(): Promise<{ success: boolean; message: string; data: any }> {
    const res = await fetch(`${this.baseUrl}/config/reset`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      throw new Error(`重置配置失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  }

  /**
   * 获取配置文件路径
   */
  async getConfigPath(): Promise<{ success: boolean; data: { path: string } }> {
    const res = await fetch(`${this.baseUrl}/config/path`);
    if (!res.ok) {
      throw new Error(`获取配置文件路径失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }
}

// ========== 便捷函数 ==========

// 创建默认API客户端实例
const defaultApiClient = new ApiClient();

/**
 * 获取Hello消息（便捷函数）
 */
export async function getHello(apiBase = '/api'): Promise<HelloResponse> {
  const client = new ApiClient(apiBase);
  return client.getHello();
}

/**
 * 获取音频设备列表（便捷函数）
 */
export async function getAudioDevices(apiBase = '/api'): Promise<AudioDevicesResponse> {
  const client = new ApiClient(apiBase);
  return client.getAudioDevices();
}

/**
 * 获取音频设备设置（便捷函数）
 */
export async function getAudioSettings(apiBase = '/api'): Promise<AudioDeviceSettingsResponse> {
  const client = new ApiClient(apiBase);
  return client.getAudioSettings();
}

/**
 * 更新音频设备设置（便捷函数）
 */
export async function updateAudioSettings(
  settings: AudioDeviceSettings, 
  apiBase = '/api'
): Promise<AudioDeviceSettingsResponse> {
  const client = new ApiClient(apiBase);
  return client.updateAudioSettings(settings);
}

/**
 * 获取FT8配置（便捷函数）
 */
export async function getFT8Config(apiBase = '/api'): Promise<{ success: boolean; data: any }> {
  const client = new ApiClient(apiBase);
  return client.getFT8Config();
}

/**
 * 更新FT8配置（便捷函数）
 */
export async function updateFT8Config(
  config: FT8ConfigUpdate, 
  apiBase = '/api'
): Promise<{ success: boolean; message: string; data: any }> {
  const client = new ApiClient(apiBase);
  return client.updateFT8Config(config);
}

// 导出默认客户端实例
export { defaultApiClient as apiClient }; 