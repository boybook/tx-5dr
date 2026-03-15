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
      message: `未在系统中找到TQSL，请手动指定路径。已搜索: ${searchPaths.join(', ')}`,
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
        message: `TQSL未找到或不可执行: ${tqslPath}`,
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
        message: `TQSL已找到: ${tqslPath}${version ? ` (版本 ${version})` : ''}`,
      };
    } catch (error) {
      // 即使version命令失败，文件存在且可执行也算找到
      return {
        found: true,
        path: tqslPath,
        message: `TQSL已找到: ${tqslPath}，但无法获取版本信息`,
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
        message: 'LoTW用户名和密码不能为空',
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

      console.log(`[LoTW] 正在测试连接...`);

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
          message: 'LoTW连接成功，凭据有效',
        };
      }

      // 检查认证失败的关键词
      const lowerText = responseText.toLowerCase();
      if (lowerText.includes('password') || lowerText.includes('incorrect') || lowerText.includes('invalid')) {
        return {
          success: false,
          message: 'LoTW用户名或密码不正确',
        };
      }

      return {
        success: false,
        message: 'LoTW返回了意外的响应格式',
      };
    } catch (error) {
      console.error('[LoTW] 连接测试失败:', error);
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
        message: 'TQSL路径未配置，请先检测或手动设置TQSL路径',
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        errorCount: 1,
        errors: ['TQSL路径未配置'],
        syncTime: Date.now(),
      };
    }

    if (!this.config.stationCallsign) {
      return {
        success: false,
        message: 'Station Callsign未配置，请先设置电台呼号',
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        errorCount: 1,
        errors: ['Station Callsign未配置'],
        syncTime: Date.now(),
      };
    }

    if (qsos.length === 0) {
      return {
        success: true,
        message: '没有需要上传的QSO记录',
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

      console.log(`[LoTW] 生成临时ADIF文件: ${tempFilePath}，包含 ${qsos.length} 条QSO记录`);

      // 调用TQSL上传
      const tqslArgs = [
        '-x',           // 完成后退出
        '-u',           // 上传到LoTW
        '-d',           // 不显示GUI
        '-a', 'all',    // 自动确认
        '-l', this.config.stationCallsign,  // 指定station location
        tempFilePath,
      ];

      console.log(`[LoTW] 调用TQSL: ${this.config.tqslPath} ${tqslArgs.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.config.tqslPath, tqslArgs, {
        timeout: 120000, // 120秒超时
      });

      console.log(`[LoTW] TQSL输出: ${stdout}`);
      if (stderr) {
        console.log(`[LoTW] TQSL错误输出: ${stderr}`);
      }

      return {
        success: true,
        message: `成功上传 ${qsos.length} 条QSO记录到LoTW`,
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
          message: 'TQSL操作被用户取消',
          uploadedCount: 0,
          downloadedCount: 0,
          confirmedCount: 0,
          errorCount: 1,
          errors: ['用户取消'],
          syncTime: Date.now(),
        };
      } else if (exitCode === 2) {
        return {
          success: false,
          message: 'TQSL上传失败，请检查网络连接和TQSL配置',
          uploadedCount: 0,
          downloadedCount: 0,
          confirmedCount: 0,
          errorCount: 1,
          errors: [error.stderr || error.message || 'TQSL上传失败'],
          syncTime: Date.now(),
        };
      }

      console.error('[LoTW] TQSL上传错误:', error);
      return {
        success: false,
        message: `TQSL执行错误: ${error.message || '未知错误'}`,
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        errorCount: 1,
        errors: [error.message || '未知错误'],
        syncTime: Date.now(),
      };
    } finally {
      // 清理临时文件
      try {
        await fs.unlink(tempFilePath);
        console.log(`[LoTW] 已删除临时文件: ${tempFilePath}`);
      } catch {
        console.warn(`[LoTW] 无法删除临时文件: ${tempFilePath}`);
      }
    }
  }

  /**
   * 从LoTW下载确认记录
   */
  async downloadConfirmations(since?: string): Promise<{ records: QSORecord[]; confirmedCount: number }> {
    if (!this.config.username || !this.config.password) {
      throw new Error('LoTW用户名和密码未配置');
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
      console.log(`[LoTW] 正在下载确认记录（自 ${sinceDate} 以来）...`);

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
        throw new Error('LoTW用户名或密码不正确');
      }

      if (!lowerText.includes('<eoh>')) {
        throw new Error('LoTW返回了意外的响应格式');
      }

      // 解析ADIF内容
      const records = parseADIFContent(responseText, 'lotw');

      console.log(`[LoTW] 下载了 ${records.length} 条确认记录`);

      return {
        records,
        confirmedCount: records.length,
      };
    } catch (error) {
      console.error('[LoTW] 下载确认记录失败:', error);
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
    console.error(`[LoTW] 网络错误详情:`, {
      message: error.message,
      code: error.code,
      cause: error.cause,
      url: url,
    });

    if (error instanceof Error && error.message.includes('LoTW')) {
      return error;
    }

    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      return new Error('连接超时: LoTW服务器响应时间过长，请检查网络连接');
    }

    if (error.code === 'UND_ERR_SOCKET') {
      if (error.cause?.message?.includes('ECONNREFUSED')) {
        return new Error(`连接被拒绝: 无法连接到LoTW服务器 ${url}`);
      }
      if (error.cause?.message?.includes('ENOTFOUND')) {
        return new Error(`域名解析失败: 找不到LoTW服务器，请检查网络连接`);
      }
      return new Error(`网络连接错误: ${error.cause?.message || error.message}`);
    }

    if (error.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error('连接超时: 无法在规定时间内连接到LoTW服务器');
    }

    if (error.message?.includes('fetch failed')) {
      return new Error('网络请求失败: 无法连接到LoTW服务器，请检查网络连接');
    }

    return new Error(`LoTW连接失败: ${error.message || '未知网络错误'}`);
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
