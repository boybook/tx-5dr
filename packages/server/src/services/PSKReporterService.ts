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

// UDP 最大负载长度（避免 MTU 分片）
const MAX_PAYLOAD_LENGTH = 1400;

// PSKReporter Private Enterprise Number (IANA PEN: 30351 = 0x768F)
const ENTERPRISE_NUM = 30351;

// Template IDs（必须 >= 256，使用 PSKReporter 约定值）
const RX_TEMPLATE_ID = 0x50E2; // 20706 - 接收站模板
const TX_TEMPLATE_ID = 0x50E3; // 20707 - 发送站模板

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

      // 构建 IPFIX 数据包（可能拆分为多个包）
      const packets = this.buildIPFIXPackets(spotsToSend);

      for (const packet of packets) {
        await this.sendUDPPacket(packet, host, port);
      }

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
   * 构建 IPFIX 数据包（可能返回多个包，受 MAX_PAYLOAD_LENGTH 限制）
   * 参考 JTDX/WSJT-X 开源实现
   *
   * 包结构: Header(16B) → RxDescriptor → TxDescriptor → RxData → TxData
   */
  private buildIPFIXPackets(spots: PSKReporterSpot[]): Buffer[] {
    const config = this.configManager.getPSKReporterConfig();

    // 构建固定部分（每个包都包含）
    const rxDescriptor = this.buildRxOptionsTemplateSet();
    const txDescriptor = this.buildTxTemplateSet();
    const receiverData = this.buildReceiverData(config);

    const fixedSize = 16 + rxDescriptor.length + txDescriptor.length + receiverData.length;

    // 将 spots 按 MAX_PAYLOAD_LENGTH 分批
    const packets: Buffer[] = [];
    let remaining = [...spots];

    while (remaining.length > 0) {
      this.sequenceNumber++;

      // 逐条添加 spot，直到接近 MAX_PAYLOAD_LENGTH
      const batch: PSKReporterSpot[] = [];
      let estimatedSize = fixedSize + 4 + 2; // +4 for Tx data set header, +2 for trailing 0x0000

      for (let i = 0; i < remaining.length; i++) {
        const spot = remaining[i];
        // 估算单条 spot 的大小
        const spotSize =
          1 + Buffer.byteLength(spot.senderCallsign, 'utf8') + // callsign (variable)
          4 +  // frequency
          1 +  // snr
          1 + Buffer.byteLength(spot.mode, 'utf8') + // mode (variable)
          1 + Buffer.byteLength(spot.senderLocator || '', 'utf8') + // grid (variable)
          1 +  // infoSource
          4;   // flowStartSeconds

        if (estimatedSize + spotSize > MAX_PAYLOAD_LENGTH && batch.length > 0) {
          break;
        }
        batch.push(spot);
        estimatedSize += spotSize;
      }

      remaining = remaining.slice(batch.length);

      const senderData = this.buildSenderData(batch);

      // 计算总长度
      const totalLength = 16 + rxDescriptor.length + txDescriptor.length + receiverData.length + senderData.length;

      // 构建 IPFIX 头部
      const header = Buffer.alloc(16);
      header.writeUInt16BE(10, 0);                                    // IPFIX Version = 10
      header.writeUInt16BE(totalLength, 2);                           // Length
      header.writeUInt32BE(Math.floor(Date.now() / 1000), 4);         // Export Time
      header.writeUInt32BE(this.sequenceNumber, 8);                   // Sequence Number
      header.writeUInt32BE(this.sessionId, 12);                       // Observation Domain ID

      packets.push(Buffer.concat([header, rxDescriptor, txDescriptor, receiverData, senderData]));
    }

    return packets;
  }

  /**
   * 构建 Rx Options Template Set (Set ID=3)
   *
   * 参考 JTDX: "0003002C50E200040000" + 4 enterprise fields + "0000"
   *
   * 格式:
   *   [SetID=3 (2B)] [Length (2B)]
   *   [TemplateID=0x50E2 (2B)] [FieldCount=4 (2B)] [ScopeFieldCount=0 (2B)]
   *   [4 × Enterprise Field Specifier (8B each)]
   *   [Padding 0x0000 (2B)]
   */
  private buildRxOptionsTemplateSet(): Buffer {
    // Rx 字段定义（参考 JTDX 的 field ID）
    const rxFields = [
      { id: 0x02, len: 0xFFFF }, // Rx Call (variable)
      { id: 0x04, len: 0xFFFF }, // Rx Grid (variable)
      { id: 0x08, len: 0xFFFF }, // Rx Software (variable)
      { id: 0x09, len: 0xFFFF }, // Rx Antenna (variable)
    ];

    // 4 enterprise fields × 8B = 32B
    const fieldsData = Buffer.alloc(rxFields.length * 8);
    for (let i = 0; i < rxFields.length; i++) {
      const off = i * 8;
      fieldsData.writeUInt16BE(0x8000 | rxFields[i].id, off);     // E bit + Field ID
      fieldsData.writeUInt16BE(rxFields[i].len, off + 2);          // Length
      fieldsData.writeUInt32BE(ENTERPRISE_NUM, off + 4);            // Enterprise Number
    }

    // Template record header: TemplateID(2B) + FieldCount(2B) + ScopeFieldCount(2B) = 6B
    const templateHeader = Buffer.alloc(6);
    templateHeader.writeUInt16BE(RX_TEMPLATE_ID, 0);  // Template ID = 0x50E2
    templateHeader.writeUInt16BE(4, 2);                // Field Count = 4
    templateHeader.writeUInt16BE(0, 4);                // Scope Field Count = 0

    const padding = Buffer.alloc(2, 0); // trailing 0x0000

    // Total record: 6 + 32 + 2 = 40B
    const totalRecordLength = templateHeader.length + fieldsData.length + padding.length;

    // Set header: SetID(2B) + Length(2B) = 4B
    const setHeader = Buffer.alloc(4);
    setHeader.writeUInt16BE(3, 0);                              // Set ID = 3 (Options Template Set)
    setHeader.writeUInt16BE(4 + totalRecordLength, 2);          // Length = 4 + 40 = 44

    return Buffer.concat([setHeader, templateHeader, fieldsData, padding]);
  }

  /**
   * 构建 Tx Template Set (Set ID=2)
   *
   * 参考 JTDX: "0002003C50E30007" + 6 enterprise fields + 1 standard field
   *
   * 格式:
   *   [SetID=2 (2B)] [Length (2B)]
   *   [TemplateID=0x50E3 (2B)] [FieldCount=7 (2B)]
   *   [6 × Enterprise Field Specifier (8B each)]
   *   [1 × Standard Field Specifier (4B)]
   */
  private buildTxTemplateSet(): Buffer {
    // Template record header: TemplateID(2B) + FieldCount(2B) = 4B
    const templateHeader = Buffer.alloc(4);
    templateHeader.writeUInt16BE(TX_TEMPLATE_ID, 0);  // Template ID = 0x50E3
    templateHeader.writeUInt16BE(7, 2);                // Field Count = 7

    // 6 enterprise fields × 8B + 1 standard field × 4B = 52B
    const fieldsData = Buffer.alloc(52);
    let off = 0;

    // 1. Tx Call (Enterprise, variable) — Field ID 0x01
    fieldsData.writeUInt16BE(0x8000 | 0x01, off); fieldsData.writeUInt16BE(0xFFFF, off + 2); fieldsData.writeUInt32BE(ENTERPRISE_NUM, off + 4); off += 8;
    // 5. Tx Freq (Enterprise, 4 bytes) — Field ID 0x05
    fieldsData.writeUInt16BE(0x8000 | 0x05, off); fieldsData.writeUInt16BE(4, off + 2); fieldsData.writeUInt32BE(ENTERPRISE_NUM, off + 4); off += 8;
    // 6. Tx SNR (Enterprise, 1 byte) — Field ID 0x06
    fieldsData.writeUInt16BE(0x8000 | 0x06, off); fieldsData.writeUInt16BE(1, off + 2); fieldsData.writeUInt32BE(ENTERPRISE_NUM, off + 4); off += 8;
    // 10. Tx Mode (Enterprise, variable) — Field ID 0x0A
    fieldsData.writeUInt16BE(0x8000 | 0x0A, off); fieldsData.writeUInt16BE(0xFFFF, off + 2); fieldsData.writeUInt32BE(ENTERPRISE_NUM, off + 4); off += 8;
    // 3. Tx Grid (Enterprise, variable) — Field ID 0x03
    fieldsData.writeUInt16BE(0x8000 | 0x03, off); fieldsData.writeUInt16BE(0xFFFF, off + 2); fieldsData.writeUInt32BE(ENTERPRISE_NUM, off + 4); off += 8;
    // 11. Tx Info Source (Enterprise, 1 byte) — Field ID 0x0B
    fieldsData.writeUInt16BE(0x8000 | 0x0B, off); fieldsData.writeUInt16BE(1, off + 2); fieldsData.writeUInt32BE(ENTERPRISE_NUM, off + 4); off += 8;
    // Report time (Standard IPFIX field 0x0096 = flowStartSeconds, 4 bytes)
    fieldsData.writeUInt16BE(0x0096, off); fieldsData.writeUInt16BE(4, off + 2);

    // Total record: 4 + 52 = 56B
    const totalRecordLength = templateHeader.length + fieldsData.length;

    // Set header: SetID(2B) + Length(2B) = 4B
    const setHeader = Buffer.alloc(4);
    setHeader.writeUInt16BE(2, 0);                              // Set ID = 2 (Template Set)
    setHeader.writeUInt16BE(4 + totalRecordLength, 2);          // Length = 4 + 56 = 60

    return Buffer.concat([setHeader, templateHeader, fieldsData]);
  }

  /**
   * 构建接收站数据记录
   * Set ID = 0x50E2（对应 Rx Template ID），末尾加 0x0000 填充
   */
  private buildReceiverData(config: PSKReporterConfig): Buffer {
    const callsign = this.encodeVariableString(this.activeCallsign);
    const locator = this.encodeVariableString(this.activeLocator);
    const software = this.encodeVariableString(config.decodingSoftware || 'TX-5DR');
    const antenna = this.encodeVariableString(config.antennaInformation || '');
    const padding = Buffer.alloc(2, 0); // trailing 0x0000

    const data = Buffer.concat([callsign, locator, software, antenna, padding]);

    const setHeader = Buffer.alloc(4);
    setHeader.writeUInt16BE(RX_TEMPLATE_ID, 0);  // Set ID = 0x50E2
    setHeader.writeUInt16BE(4 + data.length, 2);

    return Buffer.concat([setHeader, data]);
  }

  /**
   * 构建发送站数据记录
   * 字段顺序必须与模板定义一致: call, freq, snr, mode, grid, infoSource, flowStart
   * Set ID = 0x50E3（对应 Tx Template ID），末尾加 0x0000 填充
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

      const grid = this.encodeVariableString(spot.senderLocator || '');

      const infoSource = Buffer.alloc(1);
      infoSource.writeUInt8(spot.informationSource, 0);

      const flowStart = Buffer.alloc(4);
      flowStart.writeUInt32BE(spot.flowStartSeconds, 0);

      // 顺序: call, freq, snr, mode, grid, infoSource, flowStart（与模板一致）
      records.push(Buffer.concat([callsign, frequency, snr, mode, grid, infoSource, flowStart]));
    }

    const padding = Buffer.alloc(2, 0); // trailing 0x0000
    const data = Buffer.concat([...records, padding]);

    const setHeader = Buffer.alloc(4);
    setHeader.writeUInt16BE(TX_TEMPLATE_ID, 0);  // Set ID = 0x50E3
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
