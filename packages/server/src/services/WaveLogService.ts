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
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WaveLogService');

type WaveLogUploadStatus = 'created' | 'duplicate' | 'failed';

type WaveLogUploadResult = {
  success: boolean;
  status: WaveLogUploadStatus;
  message: string;
};

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
      throw new Error('WaveLog URL and API key cannot be empty');
    }

    try {
      // 获取Station列表来验证连接
      const stations = await this.getStationList();
      
      return {
        success: true,
        message: 'Connection successful',
        stations
      };
    } catch (error) {
      logger.error('Connection test failed:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed'
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
      logger.debug(`Connecting to: ${url}`);

      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'TX5DR-WaveLogSync/1.0'
        },
        signal: AbortSignal.timeout(10000) // 10秒超时
      });

      logger.debug(`Connection response status: ${response.status}`);
    } catch (error) {
      throw this.handleNetworkError(error, url);
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid API key');
      } else if (response.status === 404) {
        throw new Error('WaveLog URL invalid or API endpoint not found');
      } else {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }
    }

    const stations = await response.json();

    if (!Array.isArray(stations)) {
      throw new Error('WaveLog returned invalid station data format');
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
  async uploadQSO(qso: QSORecord, _dryRun: boolean = false): Promise<WaveLogUploadResult> {
    // 转换QSO记录为ADIF格式
    const adifString = convertQSOToADIF(qso);

    const payload = {
      key: this.config.apiKey,
      station_profile_id: this.config.stationId,
      type: 'adif',
      string: adifString
    };

    logger.debug('Uploading QSO:', {
      myCallsign: qso.myCallsign,
      myGrid: qso.myGrid,
      callsign: qso.callsign,
      grid: qso.grid,
      mode: qso.mode,
      frequency: qso.frequency,
      startTime: new Date(qso.startTime).toISOString(),
      reportSent: qso.reportSent,
      reportReceived: qso.reportReceived,
      apiKeyPrefix: this.config.apiKey ? `${this.config.apiKey.substring(0, 10)}...` : undefined,
      stationId: this.config.stationId,
      radioName: this.config.radioName,
      adif: adifString,
    });

    const url = `${this.config.url.replace(/\/$/, '')}/index.php/api/qso`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'TX5DR-WaveLogSync/1.0'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000) // 10秒超时
      });
    } catch (error) {
      logger.error('Failed to upload QSO:', error);
      throw this.handleNetworkError(error, url);
    }

    const responseText = await response.text();

    logger.debug(`Server response: status=${response.status} ${response.statusText}, body=${responseText}`);

    let result: any;

    try {
      result = JSON.parse(responseText);
    } catch {
      if (responseText.includes('<html>')) {
        throw new Error('WaveLog URL error or server returned an HTML page');
      }
      throw new Error('WaveLog server returned invalid response format');
    }

    if (response.ok && result.status === 'created') {
      return {
        success: true,
        status: 'created',
        message: 'Upload successful',
      };
    }

    const message = this.extractWaveLogResponseMessage(result, `HTTP error ${response.status}`);

    if (this.isDuplicateUploadResult(result, message)) {
      logger.info('WaveLog reported duplicate QSO', {
        callsign: qso.callsign,
        mode: qso.mode,
        message,
      });
      return {
        success: true,
        status: 'duplicate',
        message,
      };
    }

    logger.warn('WaveLog rejected QSO upload', {
      status: response.status,
      reason: message,
      callsign: qso.callsign,
      mode: qso.mode,
    });

    return {
      success: false,
      status: 'failed',
      message,
    };
  }

  /**
   * 批量上传QSO记录
   */
  async uploadMultipleQSOs(qsos: QSORecord[], dryRun: boolean = false): Promise<WaveLogSyncResponse> {
    let uploadedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    for (const qso of qsos) {
      try {
        const result = await this.uploadQSO(qso, dryRun);
        if (result.status === 'created') {
          uploadedCount++;
        } else if (result.status === 'duplicate') {
          skippedCount++;
        } else {
          errorCount++;
          errors.push(`${qso.callsign}: ${result.message}`);
        }
      } catch (error) {
        errorCount++;
        errors.push(`${qso.callsign}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return {
      success: errorCount === 0,
      message: `Upload complete: ${uploadedCount} succeeded, ${skippedCount} skipped, ${errorCount} failed`,
      uploadedCount,
      downloadedCount: 0,
      skippedCount,
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
          throw new Error('Invalid API key');
        } else if (response.status === 404) {
          throw new Error('WaveLog export API endpoint not found');
        } else {
          throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }
      }

      const responseText = await response.text();
      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error('WaveLog server returned invalid JSON response');
      }

      // 检查响应格式
      if (!result || typeof result !== 'object') {
        throw new Error('WaveLog response format is invalid');
      }

      // 检查是否有错误信息
      if (result.message && result.message.toLowerCase().includes('error')) {
        throw new Error(result.message);
      }

      // 获取ADIF数据
      const adifContent = result.adif || '';
      
      if (!adifContent || adifContent.trim().length === 0) {
        logger.debug('Empty ADIF content returned, no matching QSO records');
        return [];
      }

      // 解析ADIF内容为QSORecord数组
      const qsoRecords = parseADIFContentUtil(adifContent, 'wavelog');
      logger.info(`Downloaded ${qsoRecords.length} QSO records from server (exported_qsos: ${result.exported_qsos || 0})`);

      return qsoRecords;
    } catch (error) {
      logger.error('Failed to download QSO records:', error);
      throw this.handleNetworkError(error, `${this.config.url}/api/qso_export`);
    }
  }

  // ADIF 解析和生成方法已提取到 ../utils/adif-utils.ts 公共模块

  /**
   * 处理网络连接错误
   */
  private handleNetworkError(error: any, url: string): Error {
    logger.error('Network error:', {
      message: error.message,
      code: error.code,
      cause: error.cause,
      url,
    });

    // 根据不同的错误类型提供更友好的错误信息
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      return new Error(`Connection timeout: WaveLog server response too slow, check server status and network`);
    }

    if (error.code === 'UND_ERR_SOCKET') {
      if (error.cause?.message?.includes('ECONNREFUSED')) {
        return new Error(`Connection refused: cannot connect to WaveLog server ${url}, check URL and port`);
      }
      if (error.cause?.message?.includes('ENOTFOUND')) {
        return new Error(`DNS resolution failed: WaveLog server ${url} not found, check URL`);
      }
      if (error.cause?.message?.includes('other side closed')) {
        return new Error(`Connection closed by server: WaveLog server unexpectedly closed the connection`);
      }
      return new Error(`Network connection error: ${error.cause?.message || error.message}, check network and WaveLog server status`);
    }

    if (error.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error(`Connection timeout: unable to connect to WaveLog server within time limit`);
    }

    if (error.message?.includes('fetch failed')) {
      return new Error(`Network request failed: cannot connect to WaveLog server, check URL, network, and firewall`);
    }

    // 通用错误处理
    return new Error(`WaveLog connection failed: ${error.message || 'Unknown network error'}`);
  }

  private extractWaveLogResponseMessage(result: any, fallback: string): string {
    const messageParts: string[] = [];

    if (typeof result?.reason === 'string') {
      messageParts.push(result.reason);
    }

    if (typeof result?.message === 'string') {
      messageParts.push(result.message);
    }

    if (Array.isArray(result?.messages)) {
      for (const item of result.messages) {
        if (typeof item === 'string') {
          messageParts.push(item);
        }
      }
    }

    const normalizedMessages = messageParts
      .map((message) => this.normalizeWaveLogMessage(message))
      .filter((message) => message.length > 0);

    if (normalizedMessages.length === 0) {
      return fallback;
    }

    return normalizedMessages.join(' | ');
  }

  private normalizeWaveLogMessage(message: string): string {
    return message
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isDuplicateUploadResult(result: any, message: string): boolean {
    if (typeof message !== 'string' || !message.toLowerCase().includes('duplicate')) {
      return false;
    }

    return result?.status === 'abort' || result?.status === 'duplicate';
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
            wavelogVersion: versionData.version || 'Unknown version'
          };
        } else if (versionResponse.status === 401) {
          return {
            url: baseUrl,
            reachable: true,
            httpStatus: versionResponse.status,
            responseTime,
            error: 'Invalid API key'
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
