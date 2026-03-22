/* eslint-disable @typescript-eslint/no-explicit-any */
// LoTWService - HTTP响应处理和进程输出需要使用any

import {
  LoTWConfig,
  LoTWTestConnectionResponse,
  LoTWTQSLDetectResponse,
  LoTWSyncResponse,
  QSORecord
} from '@tx5dr/contracts';
import {
  parseADIFContent,
  generateADIFFile,
} from '../utils/adif-utils.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { tmpdir, platform } from 'os';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LoTWService');

const execFileAsync = promisify(execFile);

/**
 * LoTW (Logbook of The World) 服务类
 * 负责与ARRL LoTW系统的通信，包括TQSL上传和确认下载
 */
export class LoTWService {
  private config: LoTWConfig;

  constructor(config: LoTWConfig) {
    this.config = config;
  }

  /**
   * 更新配置
   */
  updateConfig(config: LoTWConfig): void {
    this.config = config;
  }

  /**
   * 检测TQSL安装
   */
  async detectTQSL(customPath?: string): Promise<LoTWTQSLDetectResponse> {
    // 如果提供了自定义路径，直接检查
    if (customPath) {
      return await this.checkTQSLAtPath(customPath);
    }

    // 按平台搜索默认路径
    const currentPlatform = platform();
    let searchPaths: string[];

    switch (currentPlatform) {
      case 'darwin':
        searchPaths = [
          '/Applications/tqsl.app/Contents/MacOS/tqsl',
          '/usr/local/bin/tqsl',
        ];
        break;
      case 'win32':
        searchPaths = [
          'C:\\Program Files\\TrustedQSL\\tqsl.exe',
          'C:\\Program Files (x86)\\TrustedQSL\\tqsl.exe',
        ];
        break;
      default: // linux 和其他
        searchPaths = [
          '/usr/bin/tqsl',
          '/usr/local/bin/tqsl',
        ];
        break;
    }

    for (const tqslPath of searchPaths) {
      const result = await this.checkTQSLAtPath(tqslPath);
      if (result.found) {
        return result;
      }
    }

    return {
      found: false,
      message: `TQSL not found in system, please specify path manually. Searched: ${searchPaths.join(', ')}`,
    };
  }

  /**
   * 检查指定路径的TQSL
   */
  private async checkTQSLAtPath(tqslPath: string): Promise<LoTWTQSLDetectResponse> {
    try {
      await fs.access(tqslPath, fs.constants.X_OK);
    } catch {
      return {
        found: false,
        message: `TQSL not found or not executable: ${tqslPath}`,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(tqslPath, ['--version'], {
        timeout: 10000,
      });
      const versionOutput = (stdout || stderr).trim();
      // 版本输出通常类似 "TQSL version 2.7.2"
      const versionMatch = versionOutput.match(/(\d+\.\d+(?:\.\d+)?)/);
      const version = versionMatch ? versionMatch[1] : undefined;

      return {
        found: true,
        path: tqslPath,
        version,
        message: `TQSL found: ${tqslPath}${version ? ` (version ${version})` : ''}`,
      };
    } catch (error) {
      // 即使version命令失败，文件存在且可执行也算找到
      return {
        found: true,
        path: tqslPath,
        message: `TQSL found: ${tqslPath}, but unable to retrieve version info`,
      };
    }
  }

  /**
   * 测试LoTW连接（验证用户名和密码）
   */
  async testConnection(): Promise<LoTWTestConnectionResponse> {
    if (!this.config.username || !this.config.password) {
      return {
        success: false,
        message: 'LoTW username and password cannot be empty',
      };
    }

    try {
      // 使用未来日期来获取空结果，仅验证凭据
      const params = new URLSearchParams({
        login: this.config.username,
        password: this.config.password,
        qso_query: '1',
        qso_qsldetail: 'yes',
        qso_qsl: 'yes',
        qso_qslsince: '2099-01-01',
      });

      const url = `https://lotw.arrl.org/lotwuser/lotwreport.adi?${params.toString()}`;

      logger.debug('Testing connection...');

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'TX5DR-LoTWSync/1.0',
        },
        signal: AbortSignal.timeout(15000),
      });

      const responseText = await response.text();

      // 检查是否包含ADIF头，说明认证成功
      if (responseText.toLowerCase().includes('<eoh>')) {
        return {
          success: true,
          message: 'LoTW connection successful, credentials valid',
        };
      }

      // 检查认证失败的关键词
      const lowerText = responseText.toLowerCase();
      if (lowerText.includes('password') || lowerText.includes('incorrect') || lowerText.includes('invalid')) {
        return {
          success: false,
          message: 'LoTW username or password incorrect',
        };
      }

      return {
        success: false,
        message: 'LoTW returned unexpected response format',
      };
    } catch (error) {
      logger.error('Connection test failed:', error);
      const networkError = this.handleNetworkError(error, 'https://lotw.arrl.org');
      return {
        success: false,
        message: networkError.message,
      };
    }
  }

  /**
   * 通过TQSL上传QSO记录到LoTW
   */
  async uploadQSOs(qsos: QSORecord[]): Promise<LoTWSyncResponse> {
    if (!this.config.tqslPath) {
      return {
        success: false,
        message: 'TQSL path not configured, please detect or set TQSL path manually',
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        errorCount: 1,
        errors: ['TQSL path not configured'],
        syncTime: Date.now(),
      };
    }

    if (!this.config.stationCallsign) {
      return {
        success: false,
        message: 'Station Callsign not configured, please set station callsign',
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        errorCount: 1,
        errors: ['Station Callsign not configured'],
        syncTime: Date.now(),
      };
    }

    if (qsos.length === 0) {
      return {
        success: true,
        message: 'No QSO records to upload',
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        errorCount: 0,
        syncTime: Date.now(),
      };
    }

    // 生成临时ADIF文件
    const tempFileName = `tx5dr_lotw_upload_${Date.now()}.adi`;
    const tempFilePath = path.join(tmpdir(), tempFileName);

    try {
      // 生成ADIF文件内容
      const adifContent = generateADIFFile(qsos, {
        programId: 'TX5DR',
        programVersion: '1.0',
      });

      await fs.writeFile(tempFilePath, adifContent, 'utf-8');

      logger.debug(`Generated temporary ADIF file: ${tempFilePath}, contains ${qsos.length} QSO records`);

      // 调用TQSL上传
      const tqslArgs = [
        '-x',           // 完成后退出
        '-u',           // 上传到LoTW
        '-d',           // 不显示GUI
        '-a', 'all',    // 自动确认
        '-l', this.config.stationCallsign,  // 指定station location
        tempFilePath,
      ];

      logger.debug(`Calling TQSL: ${this.config.tqslPath} ${tqslArgs.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.config.tqslPath, tqslArgs, {
        timeout: 120000, // 120秒超时
      });

      logger.debug(`TQSL stdout: ${stdout}`);
      if (stderr) {
        logger.debug(`TQSL stderr: ${stderr}`);
      }

      return {
        success: true,
        message: `Successfully uploaded ${qsos.length} QSO records to LoTW`,
        uploadedCount: qsos.length,
        downloadedCount: 0,
        confirmedCount: 0,
        errorCount: 0,
        syncTime: Date.now(),
      };
    } catch (error: any) {
      // 处理TQSL退出码
      const exitCode = error.code;

      if (exitCode === 1) {
        return {
          success: false,
          message: 'TQSL operation cancelled by user',
          uploadedCount: 0,
          downloadedCount: 0,
          confirmedCount: 0,
          errorCount: 1,
          errors: ['User cancelled'],
          syncTime: Date.now(),
        };
      } else if (exitCode === 2) {
        return {
          success: false,
          message: 'TQSL upload failed, check network connection and TQSL configuration',
          uploadedCount: 0,
          downloadedCount: 0,
          confirmedCount: 0,
          errorCount: 1,
          errors: [error.stderr || error.message || 'TQSL upload failed'],
          syncTime: Date.now(),
        };
      }

      logger.error('TQSL upload error:', error);
      return {
        success: false,
        message: `TQSL execution error: ${error.message || 'Unknown error'}`,
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        errorCount: 1,
        errors: [error.message || 'Unknown error'],
        syncTime: Date.now(),
      };
    } finally {
      // 清理临时文件
      try {
        await fs.unlink(tempFilePath);
        logger.debug(`Deleted temporary file: ${tempFilePath}`);
      } catch {
        logger.warn(`Failed to delete temporary file: ${tempFilePath}`);
      }
    }
  }

  /**
   * 从LoTW下载确认记录
   */
  async downloadConfirmations(since?: string): Promise<{ records: QSORecord[]; confirmedCount: number }> {
    if (!this.config.username || !this.config.password) {
      throw new Error('LoTW username and password not configured');
    }

    // 计算起始日期：使用since参数或最近30天
    const sinceDate = since || this.getDateDaysAgo(30);

    const params = new URLSearchParams({
      login: this.config.username,
      password: this.config.password,
      qso_query: '1',
      qso_qsl: 'yes',
      qso_qsldetail: 'yes',
      qso_qslsince: sinceDate,
    });

    const url = `https://lotw.arrl.org/lotwuser/lotwreport.adi?${params.toString()}`;

    try {
      logger.debug(`Downloading confirmations since ${sinceDate}...`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'TX5DR-LoTWSync/1.0',
        },
        signal: AbortSignal.timeout(30000),
      });

      const responseText = await response.text();

      // 检查认证是否成功
      const lowerText = responseText.toLowerCase();
      if (lowerText.includes('password') || lowerText.includes('incorrect') || lowerText.includes('invalid')) {
        throw new Error('LoTW username or password incorrect');
      }

      if (!lowerText.includes('<eoh>')) {
        throw new Error('LoTW returned unexpected response format');
      }

      // 解析ADIF内容
      const records = parseADIFContent(responseText, 'lotw');

      logger.info(`Downloaded ${records.length} confirmation records`);

      return {
        records,
        confirmedCount: records.length,
      };
    } catch (error) {
      logger.error('Failed to download confirmation records:', error);
      throw this.handleNetworkError(error, url);
    }
  }

  /**
   * 获取N天前的日期字符串 (YYYY-MM-DD)
   */
  private getDateDaysAgo(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
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

    if (error instanceof Error && error.message.includes('LoTW')) {
      return error;
    }

    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      return new Error('Connection timeout: LoTW server response too slow, check network connection');
    }

    if (error.code === 'UND_ERR_SOCKET') {
      if (error.cause?.message?.includes('ECONNREFUSED')) {
        return new Error(`Connection refused: cannot connect to LoTW server ${url}`);
      }
      if (error.cause?.message?.includes('ENOTFOUND')) {
        return new Error(`DNS resolution failed: LoTW server not found, check network connection`);
      }
      return new Error(`Network connection error: ${error.cause?.message || error.message}`);
    }

    if (error.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error('Connection timeout: unable to connect to LoTW server within time limit');
    }

    if (error.message?.includes('fetch failed')) {
      return new Error('Network request failed: cannot connect to LoTW server, check network connection');
    }

    return new Error(`LoTW connection failed: ${error.message || 'Unknown network error'}`);
  }
}

/**
 * LoTW服务的单例实例
 */
export class LoTWServiceManager {
  private static instance: LoTWServiceManager;
  private service: LoTWService | null = null;

  private constructor() {}

  static getInstance(): LoTWServiceManager {
    if (!LoTWServiceManager.instance) {
      LoTWServiceManager.instance = new LoTWServiceManager();
    }
    return LoTWServiceManager.instance;
  }

  /**
   * 初始化或更新LoTW服务
   */
  initializeService(config: LoTWConfig): void {
    if (this.service) {
      this.service.updateConfig(config);
    } else {
      this.service = new LoTWService(config);
    }
  }

  /**
   * 获取LoTW服务实例
   */
  getService(): LoTWService | null {
    return this.service;
  }

  /**
   * 检查服务是否已初始化
   */
  isServiceAvailable(): boolean {
    return this.service !== null;
  }
}
