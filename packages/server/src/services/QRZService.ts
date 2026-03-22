/* eslint-disable @typescript-eslint/no-explicit-any */
// QRZService - HTTP响应处理需要使用any

import {
  QRZConfig,
  QRZTestConnectionResponse,
  QRZSyncResponse,
  QSORecord
} from '@tx5dr/contracts';
import {
  convertQSOToADIF,
  parseADIFContent as parseADIFContentUtil,
} from '../utils/adif-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('QRZService');

const QRZ_API_URL = 'https://logbook.qrz.com/api';

/**
 * QRZ.com Logbook API 服务类
 * 负责与 QRZ.com Logbook 的通信
 */
export class QRZService {
  private config: QRZConfig;

  constructor(config: QRZConfig) {
    this.config = config;
  }

  /**
   * 更新配置
   */
  updateConfig(config: QRZConfig): void {
    this.config = config;
  }

  /**
   * 解析 QRZ 响应格式
   * QRZ 响应为 name-value pairs 用 & 分隔，例如：RESULT=OK&COUNT=5&LOGIDS=123,456
   * 响应中也可能包含换行符
   */
  private parseQRZResponse(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    // 先去除首尾空白，然后按 & 分隔（忽略换行符）
    const cleaned = text.replace(/[\r\n]+/g, '&').trim();
    const pairs = cleaned.split('&').filter(p => p.length > 0);

    for (const pair of pairs) {
      const eqIndex = pair.indexOf('=');
      if (eqIndex > 0) {
        const key = pair.substring(0, eqIndex).trim();
        const value = pair.substring(eqIndex + 1).trim();
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 测试连接并获取账户信息
   * 使用 ACTION=STATUS 验证 API Key
   */
  async testConnection(): Promise<QRZTestConnectionResponse> {
    if (!this.config.apiKey) {
      throw new Error('QRZ API key cannot be empty');
    }

    try {
      const body = new URLSearchParams({
        KEY: this.config.apiKey,
        ACTION: 'STATUS',
      });

      let response: Response;
      try {
        logger.debug(`Testing connection to: ${QRZ_API_URL}`);

        response = await fetch(QRZ_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'TX5DR/1.0',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(10000),
        });

        logger.debug(`Connection response status: ${response.status}`);
      } catch (error) {
        throw this.handleNetworkError(error, QRZ_API_URL);
      }

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      logger.debug(`STATUS response: ${responseText}`);

      const parsed = this.parseQRZResponse(responseText);

      if (parsed.RESULT === 'OK') {
        return {
          success: true,
          message: 'Connection successful',
          callsign: parsed.CALLSIGN,
          logbookCount: parsed.COUNT ? parseInt(parsed.COUNT, 10) : undefined,
        };
      } else if (parsed.RESULT === 'AUTH' || parsed.RESULT === 'FAIL') {
        return {
          success: false,
          message: parsed.REASON || 'Invalid API key or request failed',
        };
      } else {
        return {
          success: false,
          message: `Unknown response: ${responseText}`,
        };
      }
    } catch (error) {
      logger.error('Connection test failed:', error);
      if (error instanceof Error && error.message.startsWith('Connection')) {
        // Already handled by handleNetworkError
        return {
          success: false,
          message: error.message,
        };
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  /**
   * 上传单条 QSO 记录到 QRZ
   * 使用 ACTION=INSERT, ADIF=<adif string>
   */
  async uploadQSO(qso: QSORecord): Promise<{
    success: boolean;
    logId: string;
    message: string;
  }> {
    const adifString = convertQSOToADIF(qso);

    logger.debug('Uploading QSO:', {
      callsign: qso.callsign,
      mode: qso.mode,
      frequency: qso.frequency,
      adif: adifString,
    });

    const body = new URLSearchParams({
      KEY: this.config.apiKey,
      ACTION: 'INSERT',
      ADIF: adifString,
    });

    try {
      const response = await fetch(QRZ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TX5DR/1.0',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(10000),
      });

      const responseText = await response.text();
      logger.debug(`INSERT response: ${responseText}`);

      const parsed = this.parseQRZResponse(responseText);

      if (parsed.RESULT === 'OK') {
        return {
          success: true,
          logId: parsed.LOGID || parsed.LOGIDS || '',
          message: 'Upload successful',
        };
      } else if (parsed.RESULT === 'REPLACE') {
        // QRZ 返回 REPLACE 表示替换了已有记录
        return {
          success: true,
          logId: parsed.LOGID || parsed.LOGIDS || '',
          message: 'Existing record replaced',
        };
      } else {
        return {
          success: false,
          logId: '',
          message: parsed.REASON || `Upload failed: ${responseText}`,
        };
      }
    } catch (error) {
      logger.error('Failed to upload QSO:', error);
      throw this.handleNetworkError(error, QRZ_API_URL);
    }
  }

  /**
   * 批量上传 QSO 记录
   */
  async uploadMultipleQSOs(qsos: QSORecord[]): Promise<QRZSyncResponse> {
    let uploadedCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    for (const qso of qsos) {
      try {
        const result = await this.uploadQSO(qso);
        if (result.success) {
          uploadedCount++;
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
      message: `Upload complete: ${uploadedCount} succeeded, ${errorCount} failed`,
      uploadedCount,
      downloadedCount: 0,
      skippedCount: 0,
      errorCount,
      errors: errors.length > 0 ? errors : undefined,
      syncTime: Date.now(),
    };
  }

  /**
   * 从 QRZ 下载 QSO 记录
   * 使用 ACTION=FETCH，可选日期范围
   */
  async downloadQSOs(options?: {
    startDate?: string;
    endDate?: string;
  }): Promise<QSORecord[]> {
    try {
      const params: Record<string, string> = {
        KEY: this.config.apiKey,
        ACTION: 'FETCH',
      };

      // 如果提供了日期范围，使用 OPTION=BETWEEN 格式
      if (options?.startDate && options?.endDate) {
        params.OPTION = `BETWEEN:${options.startDate} 00:00:00:${options.endDate} 23:59:59`;
      }

      const body = new URLSearchParams(params);

      logger.debug('Downloading QSO records...');

      const response = await fetch(QRZ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TX5DR/1.0',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      logger.debug(`FETCH response length: ${responseText.length} bytes`);

      const parsed = this.parseQRZResponse(responseText);

      if (parsed.RESULT === 'OK') {
        const adifData = parsed.DATA || '';

        if (!adifData || adifData.trim().length === 0) {
          logger.debug('No QSO data returned');
          return [];
        }

        const qsoRecords = parseADIFContentUtil(adifData, 'qrz');
        logger.info(`Downloaded ${qsoRecords.length} QSO records (COUNT: ${parsed.COUNT || 0})`);

        return qsoRecords;
      } else if (parsed.RESULT === 'FAIL' || parsed.RESULT === 'AUTH') {
        throw new Error(parsed.REASON || 'QRZ API request failed');
      } else {
        throw new Error(`Unknown QRZ response: ${responseText}`);
      }
    } catch (error) {
      logger.error('Failed to download QSO records:', error);
      throw this.handleNetworkError(error, QRZ_API_URL);
    }
  }

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

    if (error instanceof Error && (
      error.message.startsWith('Connection') ||
      error.message.startsWith('Network') ||
      error.message.startsWith('DNS') ||
      error.message.startsWith('QRZ connection failed')
    )) {
      return error;
    }

    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      return new Error(`Connection timeout: QRZ server response too slow, check network connection`);
    }

    if (error.code === 'UND_ERR_SOCKET') {
      if (error.cause?.message?.includes('ECONNREFUSED')) {
        return new Error(`Connection refused: cannot connect to QRZ server ${url}`);
      }
      if (error.cause?.message?.includes('ENOTFOUND')) {
        return new Error(`DNS resolution failed: QRZ server ${url} not found, check network connection`);
      }
      if (error.cause?.message?.includes('other side closed')) {
        return new Error(`Connection closed by server: QRZ server unexpectedly closed the connection`);
      }
      return new Error(`Network connection error: ${error.cause?.message || error.message}, check network connection`);
    }

    if (error.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error(`Connection timeout: unable to connect to QRZ server within time limit`);
    }

    if (error.message?.includes('fetch failed')) {
      return new Error(`Network request failed: cannot connect to QRZ server, check network connection and firewall`);
    }

    return new Error(`QRZ connection failed: ${error.message || 'Unknown network error'}`);
  }
}

/**
 * QRZ服务的单例实例
 */
export class QRZServiceManager {
  private static instance: QRZServiceManager;
  private service: QRZService | null = null;

  private constructor() {}

  static getInstance(): QRZServiceManager {
    if (!QRZServiceManager.instance) {
      QRZServiceManager.instance = new QRZServiceManager();
    }
    return QRZServiceManager.instance;
  }

  /**
   * 初始化或更新QRZ服务
   */
  initializeService(config: QRZConfig): void {
    if (this.service) {
      this.service.updateConfig(config);
    } else {
      this.service = new QRZService(config);
    }
  }

  /**
   * 获取QRZ服务实例
   */
  getService(): QRZService | null {
    return this.service;
  }

  /**
   * 检查服务是否已初始化
   */
  isServiceAvailable(): boolean {
    return this.service !== null;
  }
}
