/* eslint-disable @typescript-eslint/no-explicit-any */
// WaveLogService - HTTP响应处理需要使用any

import {
  WaveLogConfig,
  WaveLogStation,
  WaveLogTestConnectionResponse,
  WaveLogSyncResponse,
  QSORecord
} from '@tx5dr/contracts';
import {
  convertQSOToADIF,
  parseADIFContent as parseADIFContentUtil,
} from '../utils/adif-utils.js';

/**
 * WaveLog服务类
 * 负责与WaveLog服务器的通信，参考WaveLogGate实现
 */
export class WaveLogService {
  private config: WaveLogConfig;

  constructor(config: WaveLogConfig) {
    this.config = config;
  }

  /**
   * 更新配置
   */
  updateConfig(config: WaveLogConfig): void {
    this.config = config;
  }

  /**
   * 测试连接并获取Station列表
   */
  async testConnection(): Promise<WaveLogTestConnectionResponse> {
    if (!this.config.url || !this.config.apiKey) {
      throw new Error('WaveLog URL和API密钥不能为空');
    }

    try {
      // 获取Station列表来验证连接
      const stations = await this.getStationList();
      
      return {
        success: true,
        message: '连接成功',
        stations
      };
    } catch (error) {
      console.error('WaveLog连接测试失败:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : '连接失败'
      };
    }
  }

  /**
   * 获取Station列表
   */
  async getStationList(): Promise<WaveLogStation[]> {
    const url = `${this.config.url.replace(/\/$/, '')}/index.php/api/station_info/${this.config.apiKey}`;
    
    let response: Response;
    try {
      console.log(`📊 [WaveLog] 正在连接到: ${url}`);
      
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'TX5DR-WaveLogSync/1.0'
        },
        signal: AbortSignal.timeout(10000) // 10秒超时
      });

      console.log(`📊 [WaveLog] 连接响应状态: ${response.status}`);
    } catch (error) {
      throw this.handleNetworkError(error, url);
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API密钥无效');
      } else if (response.status === 404) {
        throw new Error('WaveLog URL无效或API端点不存在');
      } else {
        throw new Error(`HTTP错误 ${response.status}: ${response.statusText}`);
      }
    }

    const stations = await response.json();
    
    if (!Array.isArray(stations)) {
      throw new Error('WaveLog返回的Station数据格式无效');
    }

    return stations.map(station => ({
      station_id: station.station_id?.toString() || '',
      station_profile_name: station.station_profile_name || '',
      station_callsign: station.station_callsign || '',
      station_gridsquare: station.station_gridsquare || '',
      station_city: station.station_city || '',
      station_country: station.station_country || ''
    }));
  }

  /**
   * 上传QSO记录到WaveLog
   * 参考WaveLogGate的send2wavelog函数实现
   */
  async uploadQSO(qso: QSORecord, _dryRun: boolean = false): Promise<{
    success: boolean;
    message: string;
  }> {
    if (!this.config.enabled) {
      throw new Error('WaveLog同步未启用');
    }

    // 转换QSO记录为ADIF格式
    const adifString = convertQSOToADIF(qso);

    const payload = {
      key: this.config.apiKey,
      station_profile_id: this.config.stationId,
      type: 'adif',
      string: adifString
    };

    // 🔍 添加详细的调试日志
    console.log('📊 [WaveLog] 准备上传 QSO:');
    console.log('  - My Callsign:', qso.myCallsign || '(未设置)');
    console.log('  - My Grid:', qso.myGrid || '(未设置)');
    console.log('  - Their Callsign:', qso.callsign);
    console.log('  - Their Grid:', qso.grid || '(未知)');
    console.log('  - Mode:', qso.mode);
    console.log('  - Frequency:', qso.frequency, 'Hz');
    console.log('  - Start Time:', new Date(qso.startTime).toISOString());
    console.log('  - Reports:', qso.reportSent, '/', qso.reportReceived);
    console.log('📊 [WaveLog] 配置信息:');
    console.log('  - API Key:', this.config.apiKey ? `${this.config.apiKey.substring(0, 10)}...` : '未设置');
    console.log('  - Station ID:', this.config.stationId);
    console.log('  - Radio Name:', this.config.radioName);
    console.log('📊 [WaveLog] 生成的 ADIF 字符串:');
    console.log('  ', adifString);
    console.log('📊 [WaveLog] 完整 Payload:');
    console.log('  ', JSON.stringify(payload, null, 2));

    const url = `${this.config.url.replace(/\/$/, '')}/index.php/api/qso`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'TX5DR-WaveLogSync/1.0'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000) // 10秒超时
      });

      const responseText = await response.text();

      // 🔍 记录服务器响应
      console.log('📊 [WaveLog] 服务器响应:');
      console.log('  - Status:', response.status, response.statusText);
      console.log('  - Response:', responseText);

      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        // 如果响应不是JSON，可能是HTML错误页面
        if (responseText.includes('<html>')) {
          throw new Error('WaveLog URL错误或服务器返回了HTML页面');
        }
        throw new Error('WaveLog服务器返回了无效的响应格式');
      }

      if (response.ok) {
        return {
          success: result.status === 'created',
          message: result.status === 'created' ? '上传成功' : (result.reason || '上传失败')
        };
      } else {
        // 🔍 记录详细的错误信息
        console.error('📊 [WaveLog] 上传失败详情:', {
          status: response.status,
          result: result,
          reason: result.reason || result.message || result.messages,
          qso: { callsign: qso.callsign, mode: qso.mode }
        });
        throw new Error(result.reason || result.message || (result.messages ? JSON.stringify(result.messages) : `HTTP错误 ${response.status}`));
      }
    } catch (error) {
      console.error('上传QSO到WaveLog失败:', error);
      throw this.handleNetworkError(error, url);
    }
  }

  /**
   * 批量上传QSO记录
   */
  async uploadMultipleQSOs(qsos: QSORecord[], dryRun: boolean = false): Promise<WaveLogSyncResponse> {
    let uploadedCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    for (const qso of qsos) {
      try {
        const result = await this.uploadQSO(qso, dryRun);
        if (result.success) {
          uploadedCount++;
        } else {
          errorCount++;
          errors.push(`${qso.callsign}: ${result.message}`);
        }
      } catch (error) {
        errorCount++;
        errors.push(`${qso.callsign}: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    return {
      success: errorCount === 0,
      message: `上传完成: 成功${uploadedCount}条, 失败${errorCount}条`,
      uploadedCount,
      downloadedCount: 0,
      skippedCount: 0,
      errorCount,
      errors: errors.length > 0 ? errors : undefined,
      syncTime: Date.now()
    };
  }

  /**
   * 从WaveLog下载QSO记录
   * 使用WaveLog的get_contacts_adif API获取ADIF格式的QSO记录
   */
  async downloadQSOs(_options?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<QSORecord[]> {
    if (!this.config.enabled) {
      throw new Error('WaveLog同步未启用');
    }

    try {
      // 构建请求payload，使用WaveLog官方API格式
      const payload = {
        key: this.config.apiKey,
        station_id: this.config.stationId,
        fetchfromid: 0  // 从0开始获取所有QSO，未来可以优化为增量同步
      };
      
      const url = `${this.config.url.replace(/\/$/, '')}/index.php/api/get_contacts_adif`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'TX5DR-WaveLogSync/1.0'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000) // 15秒超时，下载可能需要更长时间
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('API密钥无效');
        } else if (response.status === 404) {
          throw new Error('WaveLog导出API端点不存在');
        } else {
          throw new Error(`HTTP错误 ${response.status}: ${response.statusText}`);
        }
      }

      const responseText = await response.text();
      let result;
      
      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error('WaveLog服务器返回了无效的JSON响应');
      }

      // 检查响应格式
      if (!result || typeof result !== 'object') {
        throw new Error('WaveLog返回的响应格式不正确');
      }

      // 检查是否有错误信息
      if (result.message && result.message.toLowerCase().includes('error')) {
        throw new Error(result.message);
      }

      // 获取ADIF数据
      const adifContent = result.adif || '';
      
      if (!adifContent || adifContent.trim().length === 0) {
        console.log('WaveLog返回空的ADIF内容，可能没有匹配的QSO记录');
        return [];
      }

      // 解析ADIF内容为QSORecord数组
      const qsoRecords = parseADIFContentUtil(adifContent, 'wavelog');
      console.log(`📊 [WaveLog] 从服务器下载了 ${qsoRecords.length} 条QSO记录 (exported_qsos: ${result.exported_qsos || 0})`);
      
      return qsoRecords;
    } catch (error) {
      console.error('从WaveLog下载QSO记录失败:', error);
      throw this.handleNetworkError(error, `${this.config.url}/api/qso_export`);
    }
  }

  // ADIF 解析和生成方法已提取到 ../utils/adif-utils.ts 公共模块

  /**
   * 处理网络连接错误
   */
  private handleNetworkError(error: any, url: string): Error {
    console.error(`📊 [WaveLog] 网络错误详情:`, {
      message: error.message,
      code: error.code,
      cause: error.cause,
      url: url
    });

    // 根据不同的错误类型提供更友好的错误信息
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      return new Error(`连接超时: WaveLog服务器响应时间过长，请检查服务器状态和网络连接`);
    }

    if (error.code === 'UND_ERR_SOCKET') {
      if (error.cause?.message?.includes('ECONNREFUSED')) {
        return new Error(`连接被拒绝: 无法连接到WaveLog服务器 ${url}，请检查URL和端口是否正确`);
      }
      if (error.cause?.message?.includes('ENOTFOUND')) {
        return new Error(`域名解析失败: 找不到WaveLog服务器 ${url}，请检查URL是否正确`);
      }
      if (error.cause?.message?.includes('other side closed')) {
        return new Error(`连接被服务器关闭: WaveLog服务器意外关闭了连接，可能是服务器配置问题或网络不稳定`);
      }
      return new Error(`网络连接错误: ${error.cause?.message || error.message}，请检查网络连接和WaveLog服务器状态`);
    }

    if (error.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error(`连接超时: 无法在规定时间内连接到WaveLog服务器，请检查网络延迟`);
    }

    if (error.message?.includes('fetch failed')) {
      return new Error(`网络请求失败: 无法连接到WaveLog服务器，请检查URL、网络连接和防火墙设置`);
    }

    // 通用错误处理
    return new Error(`WaveLog连接失败: ${error.message || '未知网络错误'}`);
  }


  /**
   * 网络连接诊断工具
   * 使用WaveLog版本API验证连接和API密钥有效性
   */
  async diagnoseConnection(): Promise<{
    url: string;
    reachable: boolean;
    httpStatus?: number;
    responseTime?: number;
    wavelogVersion?: string;
    error?: string;
  }> {
    const baseUrl = this.config.url.replace(/\/$/, '');
    const startTime = Date.now();
    
    try {
      // 首先尝试基本连接测试
      const testResponse = await fetch(baseUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000)
      });
      
      if (!testResponse.ok) {
        throw new Error(`HTTP ${testResponse.status}: ${testResponse.statusText}`);
      }
      
      // 如果有API密钥，尝试使用版本API进行验证
      if (this.config.apiKey) {
        const versionUrl = `${baseUrl}/index.php/api/version`;
        const versionResponse = await fetch(versionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'TX5DR-WaveLogSync/1.0'
          },
          body: JSON.stringify({
            key: this.config.apiKey
          }),
          signal: AbortSignal.timeout(5000)
        });
        
        const responseTime = Date.now() - startTime;
        
        if (versionResponse.ok) {
          const versionData = await versionResponse.json() as { version?: string };
          return {
            url: baseUrl,
            reachable: true,
            httpStatus: versionResponse.status,
            responseTime,
            wavelogVersion: versionData.version || '未知版本'
          };
        } else if (versionResponse.status === 401) {
          return {
            url: baseUrl,
            reachable: true,
            httpStatus: versionResponse.status,
            responseTime,
            error: 'API密钥无效'
          };
        }
      }
      
      const responseTime = Date.now() - startTime;
      return {
        url: baseUrl,
        reachable: true,
        httpStatus: testResponse.status,
        responseTime
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      return {
        url: baseUrl,
        reachable: false,
        responseTime,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

/**
 * WaveLog服务的单例实例
 */
export class WaveLogServiceManager {
  private static instance: WaveLogServiceManager;
  private service: WaveLogService | null = null;

  private constructor() {}

  static getInstance(): WaveLogServiceManager {
    if (!WaveLogServiceManager.instance) {
      WaveLogServiceManager.instance = new WaveLogServiceManager();
    }
    return WaveLogServiceManager.instance;
  }

  /**
   * 初始化或更新WaveLog服务
   */
  initializeService(config: WaveLogConfig): void {
    if (this.service) {
      this.service.updateConfig(config);
    } else {
      this.service = new WaveLogService(config);
    }
  }

  /**
   * 获取WaveLog服务实例
   */
  getService(): WaveLogService | null {
    return this.service;
  }

  /**
   * 检查服务是否已初始化且配置已启用
   */
  isServiceAvailable(): boolean {
    return this.service !== null;
  }
}