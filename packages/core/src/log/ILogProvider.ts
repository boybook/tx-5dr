import { QSORecord } from '@tx5dr/contracts';

/**
 * 日志查询选项
 */
export interface LogQueryOptions {
  /**
   * 呼号（支持模糊匹配）
   */
  callsign?: string;
  
  /**
   * 网格定位
   */
  grid?: string;
  
  /**
   * 频率范围
   */
  frequencyRange?: {
    min: number;
    max: number;
  };
  
  /**
   * 时间范围
   */
  timeRange?: {
    start: number;
    end: number;
  };
  
  /**
   * 模式（FT8, FT4等）
   */
  mode?: string;
  
  /**
   * 操作员ID（用于多操作员场景）
   */
  operatorId?: string;
  
  /**
   * 限制返回记录数
   */
  limit?: number;

  /**
   * 偏移量（用于分页）
   */
  offset?: number;

  /**
   * 排序方式
   */
  orderBy?: 'time' | 'callsign' | 'frequency';
  
  /**
   * 排序方向
   */
  orderDirection?: 'asc' | 'desc';
}

/**
 * 日志统计信息
 */
export interface LogStatistics {
  /**
   * 总QSO数
   */
  totalQSOs: number;
  
  /**
   * 唯一呼号数
   */
  uniqueCallsigns: number;
  
  /**
   * 唯一网格数
   */
  uniqueGrids: number;
  
  /**
   * 按模式统计
   */
  byMode: Map<string, number>;
  
  /**
   * 按频段统计
   */
  byBand: Map<string, number>;
  
  /**
   * 最后一次QSO时间
   */
  lastQSOTime?: number;
}

/**
 * 呼号分析结果
 */
export interface CallsignAnalysis {
  /**
   * 是否是新呼号（之前未通联过）
   */
  isNewCallsign: boolean;
  
  /**
   * 上次通联记录
   */
  lastQSO?: QSORecord;
  
  /**
   * 总通联次数
   */
  qsoCount: number;
  
  /**
   * 是否是新网格
   */
  isNewGrid: boolean;
  
  /**
   * 是否是新前缀
   */
  isNewPrefix: boolean;
  
  /**
   * 是否是新CQ分区
   */
  isNewCQZone: boolean;
  
  /**
   * 是否是新ITU分区
   */
  isNewITUZone: boolean;
  
  /**
   * 呼号前缀
   */
  prefix?: string;
  
  /**
   * CQ分区
   */
  cqZone?: number;
  
  /**
   * ITU分区
   */
  ituZone?: number;
  
  /**
   * DXCC实体
   */
  dxccEntity?: string;
}

/**
 * 电台操作员日志Provider接口
 */
export interface ILogProvider {
  /**
   * 初始化日志Provider
   * @param options 初始化选项
   */
  initialize(options?: any): Promise<void>;
  
  /**
   * 添加QSO记录
   * @param record QSO记录
   * @param operatorId 操作员ID（可选，用于多操作员场景）
   */
  addQSO(record: QSORecord, operatorId?: string): Promise<void>;
  
  /**
   * 更新QSO记录
   * @param id 记录ID
   * @param updates 更新内容
   */
  updateQSO(id: string, updates: Partial<QSORecord>): Promise<void>;
  
  /**
   * 删除QSO记录
   * @param id 记录ID
   */
  deleteQSO(id: string): Promise<void>;
  
  /**
   * 根据ID获取QSO记录
   * @param id 记录ID
   */
  getQSO(id: string): Promise<QSORecord | null>;
  
  /**
   * 查询QSO记录
   * @param options 查询选项
   */
  queryQSOs(options?: LogQueryOptions): Promise<QSORecord[]>;
  
  /**
   * 检查是否已经与某呼号通联过
   * @param callsign 呼号
   * @param operatorId 操作员ID（可选）
   */
  hasWorkedCallsign(callsign: string, operatorId?: string): Promise<boolean>;
  
  /**
   * 获取与某呼号的最后一次通联记录
   * @param callsign 呼号
   * @param operatorId 操作员ID（可选）
   */
  getLastQSOWithCallsign(callsign: string, operatorId?: string): Promise<QSORecord | null>;
  
  /**
   * 分析呼号信息
   * @param callsign 呼号
   * @param grid 网格（可选）
   * @param operatorId 操作员ID（可选）
   */
  analyzeCallsign(callsign: string, grid?: string, operatorId?: string): Promise<CallsignAnalysis>;
  
  /**
   * 获取日志统计信息
   * @param operatorId 操作员ID（可选）
   */
  getStatistics(operatorId?: string): Promise<LogStatistics>;
  
  /**
   * 导出日志（ADIF格式）
   * @param options 查询选项
   */
  exportADIF(options?: LogQueryOptions): Promise<string>;
  
  /**
   * 导出日志（CSV格式）
   * @param options 查询选项
   */
  exportCSV(options?: LogQueryOptions): Promise<string>;
  
  /**
   * 导入日志（ADIF格式）
   * @param adifContent ADIF内容
   * @param operatorId 操作员ID（可选）
   */
  importADIF(adifContent: string, operatorId?: string): Promise<void>;
  
  /**
   * 关闭日志Provider
   */
  close(): Promise<void>;
} 