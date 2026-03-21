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
      throw new Error('QRZ API密钥不能为空');
    }

    try {
      const body = new URLSearchParams({
        KEY: this.config.apiKey,
        ACTION: 'STATUS',
      });

      let response: Response;
      try {
        console.log(`📊 [QRZ] 正在测试连接到: ${QRZ_API_URL}`);

        response = await fetch(QRZ_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'TX5DR/1.0',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(10000),
        });

        console.log(`📊 [QRZ] 连接响应状态: ${response.status}`);
      } catch (error) {
        throw this.handleNetworkError(error, QRZ_API_URL);
      }

      if (!response.ok) {
        throw new Error(`HTTP错误 ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      console.log(`📊 [QRZ] STATUS 响应: ${responseText}`);

      const parsed = this.parseQRZResponse(responseText);

      if (parsed.RESULT === 'OK') {
        return {
          success: true,
          message: '连接成功',
          callsign: parsed.CALLSIGN,
          logbookCount: parsed.COUNT ? parseInt(parsed.COUNT, 10) : undefined,
        };
      } else if (parsed.RESULT === 'AUTH' || parsed.RESULT === 'FAIL') {
        return {
          success: false,
          message: parsed.REASON || 'API密钥无效或请求失败',
        };
      } else {
        return {
          success: false,
          message: `未知响应: ${responseText}`,
        };
      }
    } catch (error) {
      console.error('QRZ连接测试失败:', error);
      if (error instanceof Error && error.message.startsWith('连接')) {
        // 已经是 handleNetworkError 处理过的错误
        return {
          success: false,
          message: error.message,
        };
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : '连接失败',
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

    console.log('📊 [QRZ] 准备上传 QSO:');
    console.log('  - Callsign:', qso.callsign);
    console.log('  - Mode:', qso.mode);
    console.log('  - Frequency:', qso.frequency, 'Hz');
    console.log('  - ADIF:', adifString);

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
      console.log(`📊 [QRZ] INSERT 响应: ${responseText}`);

      const parsed = this.parseQRZResponse(responseText);

      if (parsed.RESULT === 'OK') {
        return {
          success: true,
          logId: parsed.LOGID || parsed.LOGIDS || '',
          message: '上传成功',
        };
      } else if (parsed.RESULT === 'REPLACE') {
        // QRZ 返回 REPLACE 表示替换了已有记录
        return {
          success: true,
          logId: parsed.LOGID || parsed.LOGIDS || '',
          message: '已替换现有记录',
        };
      } else {
        return {
          success: false,
          logId: '',
          message: parsed.REASON || `上传失败: ${responseText}`,
        };
      }
    } catch (error) {
      console.error('上传QSO到QRZ失败:', error);
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

      console.log(`📊 [QRZ] 正在下载QSO记录...`);

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
        throw new Error(`HTTP错误 ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      console.log(`📊 [QRZ] FETCH 响应长度: ${responseText.length} 字节`);

      const parsed = this.parseQRZResponse(responseText);

      if (parsed.RESULT === 'OK') {
        const adifData = parsed.DATA || '';

        if (!adifData || adifData.trim().length === 0) {
          console.log('📊 [QRZ] 没有QSO数据返回');
          return [];
        }

        const qsoRecords = parseADIFContentUtil(adifData, 'qrz');
        console.log(`📊 [QRZ] 从QRZ下载了 ${qsoRecords.length} 条QSO记录 (COUNT: ${parsed.COUNT || 0})`);

        return qsoRecords;
      } else if (parsed.RESULT === 'FAIL' || parsed.RESULT === 'AUTH') {
        throw new Error(parsed.REASON || 'QRZ API请求失败');
      } else {
        throw new Error(`未知QRZ响应: ${responseText}`);
      }
    } catch (error) {
      console.error('从QRZ下载QSO记录失败:', error);
      throw this.handleNetworkError(error, QRZ_API_URL);
    }
  }

  /**
   * 处理网络连接错误
   */
  private handleNetworkError(error: any, url: string): Error {
    console.error(`📊 [QRZ] 网络错误详情:`, {
      message: error.message,
      code: error.code,
      cause: error.cause,
      url: url,
    });

    if (error instanceof Error && (
      error.message.startsWith('连接') ||
      error.message.startsWith('网络') ||
      error.message.startsWith('域名') ||
      error.message.startsWith('QRZ连接失败')
    )) {
      return error;
    }

    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      return new Error(`连接超时: QRZ服务器响应时间过长，请检查网络连接`);
    }

    if (error.code === 'UND_ERR_SOCKET') {
      if (error.cause?.message?.includes('ECONNREFUSED')) {
        return new Error(`连接被拒绝: 无法连接到QRZ服务器 ${url}`);
      }
      if (error.cause?.message?.includes('ENOTFOUND')) {
        return new Error(`域名解析失败: 找不到QRZ服务器 ${url}，请检查网络连接`);
      }
      if (error.cause?.message?.includes('other side closed')) {
        return new Error(`连接被服务器关闭: QRZ服务器意外关闭了连接`);
      }
      return new Error(`网络连接错误: ${error.cause?.message || error.message}，请检查网络连接`);
    }

    if (error.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error(`连接超时: 无法在规定时间内连接到QRZ服务器，请检查网络延迟`);
    }

    if (error.message?.includes('fetch failed')) {
      return new Error(`网络请求失败: 无法连接到QRZ服务器，请检查网络连接和防火墙设置`);
    }

    return new Error(`QRZ连接失败: ${error.message || '未知网络错误'}`);
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
