/**
 * PSKReporter 上报服务
 *
 * 将解码到的 FT8/FT4 信号上报到 PSKReporter 网络
 * 协议: UDP + IPFIX (RFC 5101)
 * 上报地址: report.pskreporter.info:4739
 * 测试地址: pskreporter.info:14739
 */

import dgram from 'dgram';
import { EventEmitter } from 'eventemitter3';
import {
  PSKReporterConfig,
  PSKReporterSpot,
  PSKReporterStatus,
  SlotPack,
  FrameMessage,
  FT8MessageType,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { FT8MessageParser } from '@tx5dr/core';

// PSKReporter 服务器地址
const PSKREPORTER_HOST = 'report.pskreporter.info';
const PSKREPORTER_PORT = 4739;
const PSKREPORTER_TEST_HOST = 'pskreporter.info';
const PSKREPORTER_TEST_PORT = 14739;

// 队列限制
const MAX_PENDING_SPOTS = 1000;

// 随机ID生成（用于IPFIX会话标识）
const generateRandomId = (): number => {
  return Math.floor(Math.random() * 0xFFFFFFFF);
};

interface PSKReporterEvents {
  reportSent: (count: number) => void;
  reportError: (error: Error) => void;
  statusChanged: (status: PSKReporterStatus) => void;
}

export class PSKReporterService extends EventEmitter<PSKReporterEvents> {
  private configManager: ConfigManager;
  private pendingSpots: PSKReporterSpot[] = [];
  private reportedCallsigns: Map<string, Set<string>> = new Map(); // slotId -> Set<callsign>
  private reportTimer: NodeJS.Timeout | null = null;
  private udpSocket: dgram.Socket | null = null;
  private isReporting = false;
  private lastReportTime: number | null = null;
  private sequenceNumber = 0;
  private sessionId: number;

  // 有效的接收站信息
  private activeCallsign: string = '';
  private activeLocator: string = '';

  // 当前模式 (FT8/FT4)
  private currentMode: string = 'FT8';

  constructor() {
    super();
    this.configManager = ConfigManager.getInstance();
    this.sessionId = generateRandomId();
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    const config = this.configManager.getPSKReporterConfig();

    if (config.enabled) {
      await this.start();
    }

    console.log('✅ [PSKReporter] 服务已初始化');
  }

  /**
   * 启动服务
   */
  async start(): Promise<void> {
    const config = this.configManager.getPSKReporterConfig();

    // 计算有效的呼号和网格
    this.resolveActiveIdentity();

    if (!this.activeCallsign || !this.activeLocator) {
      console.warn('⚠️ [PSKReporter] 无法确定接收站呼号或网格，服务未启动');
      console.warn(`   呼号: "${this.activeCallsign}", 网格: "${this.activeLocator}"`);
      return;
    }

    // 创建 UDP socket
    this.udpSocket = dgram.createSocket('udp4');

    this.udpSocket.on('error', (err) => {
      console.error('❌ [PSKReporter] UDP 错误:', err);
      this.emit('reportError', err);
    });

    // 启动定时上报
    const intervalMs = config.reportIntervalSeconds * 1000;
    this.reportTimer = setInterval(() => {
      this.sendPendingSpots();
    }, intervalMs);

    console.log(`✅ [PSKReporter] 服务已启动，上报间隔: ${config.reportIntervalSeconds}秒`);
    console.log(`   接收站: ${this.activeCallsign} @ ${this.activeLocator}`);

    this.emitStatus();
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }

    // 发送剩余的待上报数据
    if (this.pendingSpots.length > 0) {
      await this.sendPendingSpots();
    }

    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }

    console.log('🛑 [PSKReporter] 服务已停止');
    this.emitStatus();
  }

  /**
   * 设置当前模式
   */
  setMode(mode: string): void {
    this.currentMode = mode;
  }

  /**
   * 根据配置解析有效的呼号和网格
   */
  private resolveActiveIdentity(): void {
    const config = this.configManager.getPSKReporterConfig();
    const operators = this.configManager.getOperatorsConfig();

    // 如果手动配置了呼号和网格，使用手动配置
    if (config.receiverCallsign && config.receiverLocator) {
      this.activeCallsign = config.receiverCallsign;
      this.activeLocator = config.receiverLocator;
    } else {
      // 否则使用第一个操作员的信息
      const firstOperator = operators[0];
      this.activeCallsign = firstOperator?.myCallsign || '';
      this.activeLocator = firstOperator?.myGrid || '';
    }

    // 确保网格是6位
    if (this.activeLocator.length === 4) {
      this.activeLocator += 'mm';
    }
  }

  /**
   * 处理 SlotPack 解码结果，提取待上报的 Spot
   */
  processSlotPack(slotPack: SlotPack, rfFrequency: number): void {
    const config = this.configManager.getPSKReporterConfig();

    if (!config.enabled) {
      return;
    }

    // 刷新身份信息（可能操作员已变更）
    this.resolveActiveIdentity();

    if (!this.activeCallsign || !this.activeLocator) {
      return;
    }

    const flowStartSeconds = Math.floor(slotPack.startMs / 1000);
    const slotId = slotPack.slotId;

    // 获取或创建此时隙的已上报呼号集合
    if (!this.reportedCallsigns.has(slotId)) {
      this.reportedCallsigns.set(slotId, new Set());
    }
    const reported = this.reportedCallsigns.get(slotId)!;

    for (const frame of slotPack.frames) {
      // 跳过发射帧 (snr === -999)
      if (frame.snr === -999) {
        continue;
      }

      const spot = this.extractSpotFromFrame(frame, rfFrequency, flowStartSeconds);
      if (spot) {
        // 检查是否已上报此呼号（同一时隙内去重）
        if (reported.has(spot.senderCallsign)) {
          continue;
        }
        reported.add(spot.senderCallsign);
        this.pendingSpots.push(spot);
      }
    }

    // 清理旧的时隙记录（保留最近10个时隙）
    if (this.reportedCallsigns.size > 10) {
      const keys = Array.from(this.reportedCallsigns.keys());
      for (let i = 0; i < keys.length - 10; i++) {
        this.reportedCallsigns.delete(keys[i]);
      }
    }

    // 限制待上报数量，防止内存溢出
    if (this.pendingSpots.length > MAX_PENDING_SPOTS) {
      this.pendingSpots = this.pendingSpots.slice(-MAX_PENDING_SPOTS);
    }

    this.emitStatus();
  }

  /**
   * 从 FrameMessage 提取 Spot 信息
   */
  private extractSpotFromFrame(
    frame: FrameMessage,
    rfFrequency: number,
    flowStartSeconds: number
  ): PSKReporterSpot | null {
    try {
      // 解析 FT8 消息
      const parsedMessage = FT8MessageParser.parseMessage(frame.message);

      // 提取发送方呼号
      let senderCallsign: string | undefined;
      let senderLocator: string | undefined;

      switch (parsedMessage.type) {
        case FT8MessageType.CQ:
          senderCallsign = parsedMessage.senderCallsign;
          senderLocator = parsedMessage.grid;
          break;
        case FT8MessageType.CALL:
          senderCallsign = parsedMessage.senderCallsign;
          senderLocator = parsedMessage.grid;
          break;
        case FT8MessageType.SIGNAL_REPORT:
        case FT8MessageType.ROGER_REPORT:
          senderCallsign = parsedMessage.senderCallsign;
          break;
        case FT8MessageType.RRR:
        case FT8MessageType.SEVENTY_THREE:
          senderCallsign = parsedMessage.senderCallsign;
          break;
        default:
          // 未知消息类型，跳过
          return null;
      }

      if (!senderCallsign) {
        return null;
      }

      // 计算实际频率 (RF频率 + 音频偏移)
      const actualFrequency = rfFrequency + Math.round(frame.freq);

      return {
        senderCallsign,
        frequency: actualFrequency,
        mode: this.currentMode,
        snr: frame.snr,
        flowStartSeconds,
        senderLocator,
        informationSource: 1, // 1 = automatic
      };
    } catch (error) {
      console.error('📡 [PSKReporter] 解析消息失败:', error);
      return null;
    }
  }

  /**
   * 发送待上报的 Spots
   */
  async sendPendingSpots(): Promise<void> {
    if (this.isReporting || this.pendingSpots.length === 0) {
      return;
    }

    if (!this.udpSocket || !this.activeCallsign || !this.activeLocator) {
      return;
    }

    this.isReporting = true;
    const spotsToSend = [...this.pendingSpots];
    this.pendingSpots = [];

    try {
      const config = this.configManager.getPSKReporterConfig();
      const host = config.useTestServer ? PSKREPORTER_TEST_HOST : PSKREPORTER_HOST;
      const port = config.useTestServer ? PSKREPORTER_TEST_PORT : PSKREPORTER_PORT;

      // 构建 IPFIX 数据包
      const packet = this.buildIPFIXPacket(spotsToSend);

      await this.sendUDPPacket(packet, host, port);

      this.lastReportTime = Date.now();

      // 更新统计
      await this.configManager.updatePSKReporterStats({
        lastReportTime: this.lastReportTime,
        todayReportCount: (config.stats.todayReportCount || 0) + spotsToSend.length,
        totalReportCount: (config.stats.totalReportCount || 0) + spotsToSend.length,
        consecutiveFailures: 0,
        lastError: undefined,
      });

      console.log(`📡 [PSKReporter] 成功上报 ${spotsToSend.length} 条记录到 ${host}:${port}`);
      this.emit('reportSent', spotsToSend.length);
    } catch (error) {
      // 上报失败，将数据放回队列
      this.pendingSpots = [...spotsToSend, ...this.pendingSpots];

      const config = this.configManager.getPSKReporterConfig();
      await this.configManager.updatePSKReporterStats({
        consecutiveFailures: (config.stats.consecutiveFailures || 0) + 1,
        lastError: error instanceof Error ? error.message : String(error),
      });

      console.error('❌ [PSKReporter] 上报失败:', error);
      this.emit('reportError', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isReporting = false;
      this.emitStatus();
    }
  }

  /**
   * 构建 IPFIX 数据包
   * 参考 PSKReporter 协议文档和 WSJT-X 开源实现
   */
  private buildIPFIXPacket(spots: PSKReporterSpot[]): Buffer {
    const config = this.configManager.getPSKReporterConfig();

    // 递增序列号
    this.sequenceNumber++;

    // 构建各部分：合并模板集合 + 两个数据集合
    const combinedTemplates = this.buildCombinedTemplateSet();
    const receiverData = this.buildReceiverData(config);
    const senderData = this.buildSenderData(spots);

    // 计算总长度
    const dataLength = combinedTemplates.length + receiverData.length + senderData.length;
    const totalLength = 16 + dataLength; // 16字节头部 + 数据

    // 构建头部
    const header = Buffer.alloc(16);
    header.writeUInt16BE(10, 0);                                    // IPFIX Version
    header.writeUInt16BE(totalLength, 2);                           // Length
    header.writeUInt32BE(Math.floor(Date.now() / 1000), 4);         // Export Time
    header.writeUInt32BE(this.sequenceNumber, 8);                   // Sequence Number
    header.writeUInt32BE(this.sessionId, 12);                       // Observation Domain ID

    return Buffer.concat([header, combinedTemplates, receiverData, senderData]);
  }

  /**
   * 构建合并的模板集合（接收站模板 + 发送站模板放在同一个 Template Set 中）
   *
   * 按照 PSKReporter 协议规范（参考 WSJT-X 实现）：
   * - 接收站模板 Template ID = 2
   * - 发送站模板 Template ID = 3
   * - 两个模板必须在同一个 Template Set (Set ID = 2) 中
   *
   * Enterprise 字段格式（RFC 5101）：每个字段占 8 字节：
   *   [2B: E bit + Field ID] [2B: Length] [4B: Enterprise Number]
   * 标准字段 (E bit = 0) 占 4 字节：
   *   [2B: Field ID] [2B: Length]
   *
   * PSKReporter Enterprise Number = 44261 (0x0000ACE5)
   */
  private buildCombinedTemplateSet(): Buffer {
    const ENTERPRISE_NUM = 44261; // PSKReporter Private Enterprise Number

    // --- 接收站模板记录 (Template ID=2, 4 个 Enterprise 字段) ---
    const receiverTemplateHeader = Buffer.alloc(4);
    receiverTemplateHeader.writeUInt16BE(2, 0);  // Template ID = 2
    receiverTemplateHeader.writeUInt16BE(4, 2);  // Field Count = 4

    // 4 个 Enterprise 字段，各 8 字节 = 32 字节
    const receiverFields = Buffer.alloc(32);
    const rDefs = [
      { id: 0x01, len: 0xFFFF }, // receiverCallsign (variable)
      { id: 0x02, len: 0xFFFF }, // receiverLocator (variable)
      { id: 0x03, len: 0xFFFF }, // decodingSoftware (variable)
      { id: 0x04, len: 0xFFFF }, // antennaInformation (variable)
    ];
    for (let i = 0; i < rDefs.length; i++) {
      const off = i * 8;
      receiverFields.writeUInt16BE(0x8000 | rDefs[i].id, off);      // E bit + Field ID
      receiverFields.writeUInt16BE(rDefs[i].len, off + 2);           // Length
      receiverFields.writeUInt32BE(ENTERPRISE_NUM, off + 4);          // Enterprise Number
    }

    // --- 发送站模板记录 (Template ID=3, 5 个 Enterprise 字段 + 1 个标准字段) ---
    const senderTemplateHeader = Buffer.alloc(4);
    senderTemplateHeader.writeUInt16BE(3, 0);  // Template ID = 3
    senderTemplateHeader.writeUInt16BE(6, 2);  // Field Count = 6

    // 5 个 Enterprise 字段 * 8B + 1 个标准字段 * 4B = 44 字节
    const senderFields = Buffer.alloc(44);
    // senderCallsign (Enterprise, variable)
    senderFields.writeUInt16BE(0x8000 | 0x05, 0);
    senderFields.writeUInt16BE(0xFFFF, 2);
    senderFields.writeUInt32BE(ENTERPRISE_NUM, 4);
    // frequency (Enterprise, 4 bytes)
    senderFields.writeUInt16BE(0x8000 | 0x06, 8);
    senderFields.writeUInt16BE(4, 10);
    senderFields.writeUInt32BE(ENTERPRISE_NUM, 12);
    // sNR (Enterprise, 1 byte)
    senderFields.writeUInt16BE(0x8000 | 0x07, 16);
    senderFields.writeUInt16BE(1, 18);
    senderFields.writeUInt32BE(ENTERPRISE_NUM, 20);
    // mode (Enterprise, variable)
    senderFields.writeUInt16BE(0x8000 | 0x0A, 24);
    senderFields.writeUInt16BE(0xFFFF, 26);
    senderFields.writeUInt32BE(ENTERPRISE_NUM, 28);
    // informationSource (Enterprise, 1 byte)
    senderFields.writeUInt16BE(0x8000 | 0x0B, 32);
    senderFields.writeUInt16BE(1, 34);
    senderFields.writeUInt32BE(ENTERPRISE_NUM, 36);
    // flowStartSeconds (标准 IPFIX 字段 0x0096，无 Enterprise Number)
    senderFields.writeUInt16BE(0x0096, 40);
    senderFields.writeUInt16BE(4, 42);

    // 合并两个模板记录：36B (接收站) + 48B (发送站) = 84B
    const allTemplateRecords = Buffer.concat([
      receiverTemplateHeader, receiverFields,  // 4 + 32 = 36B
      senderTemplateHeader, senderFields,      // 4 + 44 = 48B
    ]);

    // Template Set 头部：Set ID=2，Length = 4 (头部) + 84 (模板记录) = 88
    const setHeader = Buffer.alloc(4);
    setHeader.writeUInt16BE(2, 0);                                // Set ID = 2 (Template Set)
    setHeader.writeUInt16BE(4 + allTemplateRecords.length, 2);   // Length

    return Buffer.concat([setHeader, allTemplateRecords]);
  }

  /**
   * 构建接收站数据记录
   */
  private buildReceiverData(config: PSKReporterConfig): Buffer {
    const callsign = this.encodeVariableString(this.activeCallsign);
    const locator = this.encodeVariableString(this.activeLocator);
    const software = this.encodeVariableString(config.decodingSoftware || 'TX-5DR');
    const antenna = this.encodeVariableString(config.antennaInformation || '');

    const data = Buffer.concat([callsign, locator, software, antenna]);

    // 数据集合头部：Set ID 必须与接收站模板 Template ID 一致 (= 2)
    const setHeader = Buffer.alloc(4);
    setHeader.writeUInt16BE(2, 0);  // Set ID = 2（对应接收站 Template ID）
    setHeader.writeUInt16BE(4 + data.length, 2);

    return Buffer.concat([setHeader, data]);
  }

  /**
   * 构建发送站数据记录
   */
  private buildSenderData(spots: PSKReporterSpot[]): Buffer {
    if (spots.length === 0) {
      return Buffer.alloc(0);
    }

    const records: Buffer[] = [];

    for (const spot of spots) {
      const callsign = this.encodeVariableString(spot.senderCallsign);

      const frequency = Buffer.alloc(4);
      frequency.writeUInt32BE(spot.frequency || 0, 0);

      const snr = Buffer.alloc(1);
      snr.writeInt8(Math.max(-128, Math.min(127, spot.snr || 0)), 0);

      const mode = this.encodeVariableString(spot.mode);

      const infoSource = Buffer.alloc(1);
      infoSource.writeUInt8(spot.informationSource, 0);

      const flowStart = Buffer.alloc(4);
      flowStart.writeUInt32BE(spot.flowStartSeconds, 0);

      records.push(Buffer.concat([callsign, frequency, snr, mode, infoSource, flowStart]));
    }

    const data = Buffer.concat(records);

    // 数据集合头部：Set ID 必须与发送站模板 Template ID 一致 (= 3)
    const setHeader = Buffer.alloc(4);
    setHeader.writeUInt16BE(3, 0);  // Set ID = 3（对应发送站 Template ID）
    setHeader.writeUInt16BE(4 + data.length, 2);

    return Buffer.concat([setHeader, data]);
  }

  /**
   * 编码变长字符串 (IPFIX variable-length encoding)
   */
  private encodeVariableString(str: string): Buffer {
    const strBuffer = Buffer.from(str, 'utf8');
    if (strBuffer.length < 255) {
      const lengthBuf = Buffer.alloc(1);
      lengthBuf.writeUInt8(strBuffer.length, 0);
      return Buffer.concat([lengthBuf, strBuffer]);
    } else {
      const lengthBuf = Buffer.alloc(3);
      lengthBuf.writeUInt8(255, 0);
      lengthBuf.writeUInt16BE(strBuffer.length, 1);
      return Buffer.concat([lengthBuf, strBuffer]);
    }
  }

  /**
   * 发送 UDP 数据包
   */
  private sendUDPPacket(packet: Buffer, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.udpSocket) {
        reject(new Error('UDP socket not initialized'));
        return;
      }

      this.udpSocket.send(packet, port, host, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 获取当前状态
   */
  getStatus(): PSKReporterStatus {
    const config = this.configManager.getPSKReporterConfig();

    return {
      enabled: config.enabled,
      configValid: !!(this.activeCallsign && this.activeLocator),
      activeCallsign: this.activeCallsign || undefined,
      activeLocator: this.activeLocator || undefined,
      pendingSpots: this.pendingSpots.length,
      lastReportTime: this.lastReportTime || undefined,
      nextReportIn: this.calculateNextReportIn(),
      isReporting: this.isReporting,
      lastError: config.stats.lastError,
    };
  }

  /**
   * 计算距离下次上报的秒数
   */
  private calculateNextReportIn(): number | undefined {
    const config = this.configManager.getPSKReporterConfig();

    if (!config.enabled || !this.lastReportTime) {
      return undefined;
    }

    const elapsed = Math.floor((Date.now() - this.lastReportTime) / 1000);
    const remaining = config.reportIntervalSeconds - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * 发送状态更新事件
   */
  private emitStatus(): void {
    this.emit('statusChanged', this.getStatus());
  }

  /**
   * 配置更新时调用
   */
  async onConfigChanged(): Promise<void> {
    const config = this.configManager.getPSKReporterConfig();

    if (config.enabled && !this.reportTimer) {
      await this.start();
    } else if (!config.enabled && this.reportTimer) {
      await this.stop();
    } else if (config.enabled) {
      // 配置变更，重新解析身份
      this.resolveActiveIdentity();

      // 更新定时器间隔
      if (this.reportTimer) {
        clearInterval(this.reportTimer);
        const intervalMs = config.reportIntervalSeconds * 1000;
        this.reportTimer = setInterval(() => {
          this.sendPendingSpots();
        }, intervalMs);
      }

      this.emitStatus();
    }
  }
}

/**
 * PSKReporter 服务单例管理器
 */
let pskreporterServiceInstance: PSKReporterService | null = null;

export function getPSKReporterService(): PSKReporterService {
  if (!pskreporterServiceInstance) {
    pskreporterServiceInstance = new PSKReporterService();
  }
  return pskreporterServiceInstance;
}

export async function initializePSKReporterService(): Promise<PSKReporterService> {
  const service = getPSKReporterService();
  await service.initialize();
  return service;
}
