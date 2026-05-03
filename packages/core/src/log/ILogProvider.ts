import type {
  DxccStatus,
  LogBookDxccSummary,
  LogBookImportResult,
  QSORecord,
} from '@tx5dr/contracts';

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
   * 波段（如 '20m', '40m'），按 getBandFromFrequency 派生比较
   */
  band?: string;

  /**
   * DXCC 状态筛选
   */
  dxccStatus?: 'deleted';

  /**
   * QSL 流程筛选
   */
  qslFlow?: 'two_way_confirmed' | 'not_two_way_confirmed';

  /**
   * 排除的模式列表（用于过滤掉数字模式等）
   */
  excludeModes?: string[];

  /**
   * QSL 确认状态筛选
   * confirmed: 至少一个平台已确认 (lotwQslReceived='Y'|'V' 或 qrzQslReceived='Y')
   * uploaded: 至少一个平台已上传但无确认
   * none: 未上传到任何平台
   */
  qslStatus?: 'confirmed' | 'uploaded' | 'none';

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

  /**
   * 第一次 QSO 时间
   */
  firstQSOTime?: number;

  /**
   * DXCC 摘要
   */
  dxcc?: LogBookDxccSummary;
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
   * 是否是新 DXCC 实体
   */
  isNewDxccEntity: boolean;

  /**
   * 是否是当前波段的新 DXCC 实体
   */
  isNewBandDxccEntity: boolean;

  /**
   * 该 DXCC 是否已确认
   */
  isConfirmedDxcc: boolean;
  
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

  /**
   * DXCC 实体编号
   */
  dxccId?: number;

  /**
   * DXCC current/deleted 状态
   */
  dxccStatus?: DxccStatus;

  /**
   * 美国 subdivision code（州/属地），仅在可解析时提供
   */
  state?: string;

  /**
   * subdivision 置信度
   */
  stateConfidence?: 'high' | 'low';

  /**
   * 是否需要人工复核
   */
  dxccNeedsReview?: boolean;

  /**
   * DXCC 解析命中类型
   */
  dxccMatchKind?: 'prefix' | 'regex' | 'heuristic' | 'unknown';

  /**
   * DXCC 解析数据源
   */
  dxccDataSource?: 'local' | 'hamqth';

  /**
   * DXCC 解析器/数据版本
   */
  dxccResolverVersion?: string;
}

/**
 * 电台操作员日志Provider接口
 */
export interface ILogProvider {
  /**
   * 初始化日志Provider
   * @param options 初始化选项
   */
  initialize(options?: Record<string, unknown>): Promise<void>;
  
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
   * Count QSO records matching filters without materializing results.
   * No sort, no pagination — single-pass iteration only.
   */
  countQSOs(options?: LogQueryOptions): Promise<number>;
  
  /**
   * 检查是否已经与某呼号通联过
   * @param callsign 呼号
   * @param operatorId 操作员ID（可选）
   */
  hasWorkedCallsign(
    callsign: string,
    options?: { operatorId?: string; band?: string }
  ): Promise<boolean>;
  
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
  analyzeCallsign(
    callsign: string,
    grid?: string,
    options?: { operatorId?: string; band?: string }
  ): Promise<CallsignAnalysis>;
  
  /**
   * 获取日志统计信息
   * @param operatorId 操作员ID（可选）
   */
  getStatistics(operatorId?: string): Promise<LogStatistics>;

  /**
   * 获取 DXCC 统计摘要
   * @param operatorId 操作员ID（可选）
   */
  getDXCCSummary(operatorId?: string): Promise<LogBookDxccSummary>;
  
  /**
   * 导出日志（ADIF格式）
   * @param options 查询选项
   */
  exportADIF(options?: LogQueryOptions, exportOptions?: { fallbackGrid?: string }): Promise<string>;
  
  /**
   * 导出日志（CSV格式）
   * @param options 查询选项
   */
  exportCSV(options?: LogQueryOptions): Promise<string>;
  
  /**
   * 导入日志（ADIF格式）
   * @param adifContent ADIF内容
   */
  importADIF(adifContent: string): Promise<LogBookImportResult>;

  /**
   * 导入日志（TX-5DR CSV格式）
   * @param csvContent CSV内容
   */
  importCSV(csvContent: string): Promise<LogBookImportResult>;
  
  /**
   * 关闭日志Provider
   */
  close(): Promise<void>;
} 
