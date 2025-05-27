// QSO状态机的状态
export enum QSOState {
  IDLE = 'idle',                    // 空闲状态
  LISTENING = 'listening',          // 监听状态
  CALLING_CQ = 'calling_cq',        // 呼叫CQ
  RESPONDING = 'responding',        // 响应呼叫
  EXCHANGING_REPORT = 'exchanging_report', // 交换信号报告
  CONFIRMING = 'confirming',        // 确认QSO
  COMPLETED = 'completed',          // QSO完成
  FAILED = 'failed',               // QSO失败
}

// FT8时间周期相关
export enum FT8Cycle {
  EVEN = 0,  // 偶数周期（0, 30秒）
  ODD = 1,   // 奇数周期（15, 45秒）
}

// FT8消息类型
export enum FT8MessageType {
  CQ = 'cq',                       // CQ呼叫
  CQ_DX = 'cq_dx',                 // CQ DX呼叫
  RESPONSE = 'response',           // 响应呼叫
  SIGNAL_REPORT = 'signal_report', // 信号报告
  ROGER_REPORT = 'roger_report',   // 确认信号报告
  RRR = 'rrr',                     // RRR确认
  SEVENTY_THREE = '73',            // 73告别
  CUSTOM = 'custom',               // 自定义消息
  UNKNOWN = 'unknown',             // 未知消息类型
}

// QSO记录状态
export enum QSOStatus {
  IN_PROGRESS = 'in_progress',     // 进行中
  COMPLETED = 'completed',         // 已完成
  FAILED = 'failed',               // 失败
  CANCELLED = 'cancelled',         // 取消
}

// 时间周期信息
export interface CycleInfo {
  cycle: FT8Cycle;
  startTime: number;  // Unix时间戳
  endTime: number;    // Unix时间戳
  isTransmitting: boolean;
}

// FT8消息解析结果
export interface ParsedFT8Message {
  type: FT8MessageType;
  callsign1?: string;      // 第一个呼号
  callsign2?: string;      // 第二个呼号
  grid?: string;           // 网格定位
  report?: string;         // 信号报告
  rawMessage: string;      // 原始消息
  isValid: boolean;        // 是否为有效的FT8消息
}

// QSO联系记录
export interface QSORecord {
  id: string;
  callsign: string;        // 对方呼号
  grid?: string;           // 对方网格定位
  frequency: number;       // 频率
  mode: string;            // 模式（FT8）
  startTime: number;       // 开始时间
  endTime?: number;        // 结束时间
  reportSent?: string;     // 发送的信号报告
  reportReceived?: string; // 接收的信号报告
  status: QSOStatus;       // QSO状态
  messages: ParsedFT8Message[]; // 消息历史
}

// QSO状态机上下文
export interface QSOContext {
  currentState: QSOState;
  targetCallsign?: string;
  myCallsign: string;
  myGrid: string;
  frequency: number;
  reportSent?: string;
  reportReceived?: string;
  lastTransmission?: string;
  cyclesSinceLastTransmission: number;
  timeoutCycles: number;   // 超时周期数
}

// 系统配置
export interface SystemConfig {
  myCallsign: string;
  myGrid: string;
  autoReply: boolean;      // 是否自动回复
  maxQSOTimeout: number;   // QSO超时时间（周期数）
  transmitPower: number;   // 发射功率
  frequency: number;       // 工作频率
} 