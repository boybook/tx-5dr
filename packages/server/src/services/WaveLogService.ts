import { 
  WaveLogConfig, 
  WaveLogStation, 
  WaveLogTestConnectionResponse,
  WaveLogSyncResponse,
  QSORecord
} from '@tx5dr/contracts';
import type { LogQueryOptions } from '@tx5dr/core';

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
  async uploadQSO(qso: QSORecord, dryRun: boolean = false): Promise<{
    success: boolean;
    message: string;
  }> {
    if (!this.config.enabled) {
      throw new Error('WaveLog同步未启用');
    }

    // 转换QSO记录为ADIF格式
    const adifString = this.convertQSOToADIF(qso);
    
    const payload = {
      key: this.config.apiKey,
      station_profile_id: this.config.stationId,
      type: 'adif',
      string: adifString
    };

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
        throw new Error(result.reason || `HTTP错误 ${response.status}`);
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
  async downloadQSOs(options?: {
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
      const qsoRecords = this.parseADIFContent(adifContent);
      console.log(`📊 [WaveLog] 从服务器下载了 ${qsoRecords.length} 条QSO记录 (exported_qsos: ${result.exported_qsos || 0})`);
      
      return qsoRecords;
    } catch (error) {
      console.error('从WaveLog下载QSO记录失败:', error);
      throw this.handleNetworkError(error, `${this.config.url}/api/qso_export`);
    }
  }

  /**
   * 解析ADIF内容为QSORecord数组
   * 基本的ADIF解析器，处理WaveLog导出的标准格式
   */
  private parseADIFContent(adifContent: string): QSORecord[] {
    const records: QSORecord[] = [];
    
    try {
      // 按记录分割（<eor> 标记）
      const recordStrings = adifContent.split(/<eor>/i).filter(r => r.trim().length > 0);
      
      for (const recordStr of recordStrings) {
        const qso = this.parseADIFRecord(recordStr);
        if (qso) {
          records.push(qso);
        }
      }
    } catch (error) {
      console.error('解析ADIF内容失败:', error);
      throw new Error('ADIF格式解析错误');
    }
    
    return records;
  }

  /**
   * 解析单个ADIF记录
   */
  private parseADIFRecord(recordStr: string): QSORecord | null {
    const fields: Record<string, string> = {};
    
    // 匹配ADIF字段模式: <field:length>value
    const fieldRegex = /<(\w+):(\d+)>([^<]*)/gi;
    let match;
    
    while ((match = fieldRegex.exec(recordStr)) !== null) {
      const fieldName = match[1].toLowerCase();
      const fieldLength = parseInt(match[2]);
      const fieldValue = match[3].substring(0, fieldLength);
      fields[fieldName] = fieldValue;
    }
    
    // 检查必需字段
    if (!fields.call || !fields.qso_date || !fields.time_on) {
      console.warn('ADIF记录缺少必需字段，跳过:', fields);
      return null;
    }
    
    try {
      // 构建QSORecord
      const qsoDate = fields.qso_date; // YYYYMMDD
      const timeOn = fields.time_on; // HHMMSS
      const timeOff = fields.time_off || timeOn; // 如果没有结束时间，使用开始时间
      
      // 转换日期时间为ISO格式
      const startTime = this.parseADIFDateTime(qsoDate, timeOn);
      const endTime = this.parseADIFDateTime(fields.qso_date_off || qsoDate, timeOff);
      
      const qsoRecord: QSORecord = {
        id: `wavelog-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        callsign: fields.call.toUpperCase(),
        startTime: new Date(startTime).getTime(),
        endTime: new Date(endTime).getTime(),
        frequency: fields.freq ? Math.round(parseFloat(fields.freq) * 1000000) : 14074000, // 转换MHz到Hz
        mode: fields.mode || 'FT8',
        reportSent: fields.rst_sent || '',
        reportReceived: fields.rst_rcvd || '',
        grid: fields.gridsquare || '',
        messages: [`QSO imported from WaveLog at ${new Date().toISOString()}`]
      };
      
      return qsoRecord;
    } catch (error) {
      console.warn('解析ADIF记录时出错:', error, fields);
      return null;
    }
  }

  /**
   * 解析ADIF日期时间格式为ISO字符串
   */
  private parseADIFDateTime(dateStr: string, timeStr: string): string {
    // ADIF日期格式: YYYYMMDD
    // ADIF时间格式: HHMMSS
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    
    const hour = timeStr.substring(0, 2);
    const minute = timeStr.substring(2, 4);
    const second = timeStr.substring(4, 6) || '00';
    
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).toISOString();
  }

  /**
   * 将QSO记录转换为ADIF格式
   * 参考WaveLogGate中的ADIF处理逻辑
   */
  private convertQSOToADIF(qso: QSORecord): string {
    const adifFields: string[] = [];
    
    // 必需字段
    adifFields.push(`<call:${qso.callsign.length}>${qso.callsign}`);
    
    // QSO时间 - 转换为UTC
    const startTime = new Date(qso.startTime);
    const qsoDate = this.formatADIFDate(startTime);
    const qsoTime = this.formatADIFTime(startTime);
    
    adifFields.push(`<qso_date:8>${qsoDate}`);
    adifFields.push(`<time_on:6>${qsoTime}`);
    
    // 如果有结束时间
    if (qso.endTime) {
      const endTime = new Date(qso.endTime);
      const endDate = this.formatADIFDate(endTime);
      const endTimeStr = this.formatADIFTime(endTime);
      adifFields.push(`<qso_date_off:8>${endDate}`);
      adifFields.push(`<time_off:6>${endTimeStr}`);
    } else {
      // 如果没有结束时间，使用开始时间
      adifFields.push(`<qso_date_off:8>${qsoDate}`);
      adifFields.push(`<time_off:6>${qsoTime}`);
    }
    
    // 模式
    if (qso.mode) {
      adifFields.push(`<mode:${qso.mode.length}>${qso.mode}`);
    }
    
    // 频率 - 转换为MHz
    const freqMHz = (qso.frequency / 1000000).toFixed(6);
    adifFields.push(`<freq:${freqMHz.length}>${freqMHz}`);
    
    // 网格坐标
    if (qso.grid) {
      adifFields.push(`<gridsquare:${qso.grid.length}>${qso.grid}`);
    }
    
    // 信号报告
    if (qso.reportSent) {
      adifFields.push(`<rst_sent:${qso.reportSent.length}>${qso.reportSent}`);
    }
    
    if (qso.reportReceived) {
      adifFields.push(`<rst_rcvd:${qso.reportReceived.length}>${qso.reportReceived}`);
    }
    
    // 电台名称
    if (this.config.radioName) {
      adifFields.push(`<station_callsign:${this.config.radioName.length}>${this.config.radioName}`);
    }
    
    // 结束标记
    adifFields.push('<eor>');
    
    return adifFields.join(' ');
  }

  /**
   * 格式化ADIF日期 (YYYYMMDD)
   */
  private formatADIFDate(date: Date): string {
    const year = date.getUTCFullYear().toString().padStart(4, '0');
    const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = date.getUTCDate().toString().padStart(2, '0');
    return `${year}${month}${day}`;
  }

  /**
   * 格式化ADIF时间 (HHMMSS)
   */
  private formatADIFTime(date: Date): string {
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    const seconds = date.getUTCSeconds().toString().padStart(2, '0');
    return `${hours}${minutes}${seconds}`;
  }

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