import { 
  WebSocketClient, 
  type WebSocketClientEvents,
  api
} from '@tx5dr/core';
import type { FT8Frame, DecodeResult, ModeDescriptor } from '@tx5dr/contracts';

export interface TX5DRClientEvents extends WebSocketClientEvents {}

/**
 * TX-5DR 客户端 SDK
 * 提供与服务器的 REST API 和 WebSocket 连接的统一接口
 */
export class TX5DRClient {
  private baseUrl: string;
  private wsClient: WebSocketClient | null = null;
  
  constructor(baseUrl: string = 'http://localhost:4000') {
    this.baseUrl = baseUrl;
  }
  
  /**
   * 连接到服务器
   */
  async connect(): Promise<void> {
    try {
      // 首先测试 REST API 连接
      await this.getModes();
      
      // 然后建立 WebSocket 连接
      await this.connectWebSocket();
      
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  
  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
  }
  
  /**
   * 监听事件
   */
  on<K extends keyof TX5DRClientEvents>(event: K, listener: TX5DRClientEvents[K]): void {
    if (this.wsClient) {
      this.wsClient.on(event, listener as any);
    }
  }
  
  /**
   * 移除事件监听器
   */
  off<K extends keyof TX5DRClientEvents>(event: K, listener: TX5DRClientEvents[K]): void {
    if (this.wsClient) {
      this.wsClient.off(event, listener as any);
    }
  }
  
  // ========== API 方法 ==========
  
  /**
   * 获取可用的模式列表
   */
  async getModes(): Promise<{ modes: ModeDescriptor[]; default: string }> {
    return api.getModes(`${this.baseUrl}/api`);
  }

  /**
   * 获取Hello消息
   */
  async getHello() {
    return api.getHello(`${this.baseUrl}/api`);
  }
  
  /**
   * 获取音频设备列表
   */
  async getAudioDevices() {
    return api.getAudioDevices(`${this.baseUrl}/api`);
  }
  
  /**
   * 获取音频设备设置
   */
  async getAudioSettings() {
    return api.getAudioSettings(`${this.baseUrl}/api`);
  }
  
  /**
   * 更新音频设备设置
   */
  async updateAudioSettings(settings: any) {
    return api.updateAudioSettings(settings, `${this.baseUrl}/api`);
  }
  
  /**
   * 重置音频设备设置
   */
  async resetAudioSettings() {
    return api.resetAudioSettings(`${this.baseUrl}/api`);
  }
  
  /**
   * 获取配置
   */
  async getConfig() {
    return api.getConfig(`${this.baseUrl}/api`);
  }
  
  /**
   * 获取FT8配置
   */
  async getFT8Config() {
    return api.getFT8Config(`${this.baseUrl}/api`);
  }
  
  /**
   * 更新FT8配置
   */
  async updateFT8Config(config: any) {
    return api.updateFT8Config(config, `${this.baseUrl}/api`);
  }
  
  /**
   * 获取服务器配置
   */
  async getServerConfig() {
    return api.getServerConfig(`${this.baseUrl}/api`);
  }
  
  /**
   * 更新服务器配置
   */
  async updateServerConfig(config: any) {
    return api.updateServerConfig(config, `${this.baseUrl}/api`);
  }
  
  /**
   * 验证配置
   */
  async validateConfig() {
    return api.validateConfig(`${this.baseUrl}/api`);
  }
  
  /**
   * 重置配置
   */
  async resetConfig() {
    return api.resetConfig(`${this.baseUrl}/api`);
  }
  
  /**
   * 获取配置文件路径
   */
  async getConfigPath() {
    return api.getConfigPath(`${this.baseUrl}/api`);
  }
  
  /**
   * 获取连接状态
   */
  getConnectionStatus() {
    return {
      isConnected: this.wsClient?.getConnectionStatus().isConnected ?? false,
      wsStatus: this.wsClient?.getConnectionStatus()
    };
  }
  
  /**
   * 建立 WebSocket 连接
   */
  private async connectWebSocket(): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    this.wsClient = new WebSocketClient(wsUrl);
    await this.wsClient.connect();
  }
} 