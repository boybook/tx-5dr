/**
 * 状态机类型定义
 *
 * 提供 engineStateMachine 和 radioStateMachine 的类型定义
 */

import type { RadioError } from '../utils/errors/RadioError.js';
import type { HamlibConfig } from '@tx5dr/contracts';

// ============================================================================
// 引擎状态机类型
// ============================================================================

/**
 * 引擎状态枚举
 */
export enum EngineState {
  IDLE = 'idle',
  /**
   * 唤醒中（电台关机状态下尝试开机）
   * 仅启动 radio 资源的 control-only 链路，发送 powerstat(ON)，
   * 等待 readiness 探针通过后无缝迁移到 STARTING（promote 完整连接 + 启动音频/时隙）
   */
  WAKING = 'waking',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
}

/**
 * 引擎状态机上下文
 */
export interface EngineContext {
  /**
   * 最近一次错误信息（不影响状态，仅供查询）
   */
  error?: RadioError | Error;

  /**
   * 已启动的资源列表（用于回滚）
   */
  startedResources: string[];

  /**
   * 启动时间戳
   */
  startTimestamp?: number;

  /**
   * 停止时间戳
   */
  stopTimestamp?: number;

  /**
   * 是否为强制停止
   */
  forcedStop?: boolean;
}

/**
 * 引擎状态机事件
 */
export type EngineEvent =
  | { type: 'START' }
  | { type: 'START_SUCCESS' }
  | { type: 'START_FAILURE'; error: RadioError | Error }
  | { type: 'STOP' }
  | { type: 'FORCE_STOP'; reason?: string }
  | { type: 'STOP_SUCCESS' }
  | { type: 'STOP_FAILURE'; error: RadioError | Error }
  | { type: 'RADIO_DISCONNECTED'; reason?: string }
  | { type: 'POWER_ON' }
  | { type: 'POWER_READY' }
  | { type: 'POWER_FAILED'; error: RadioError | Error };

/**
 * 引擎状态机输入
 */
export interface EngineInput {
  /**
   * 回调函数：资源启动
   * 注意：从 WAKING → STARTING 的路径下，第一个 radio 资源会改用 promoteControlLink，
   * 但这是 onStart 内部决策，不需要状态机感知
   */
  onStart: () => Promise<void>;

  /**
   * 回调函数：资源停止
   */
  onStop: () => Promise<void>;

  /**
   * 回调函数：唤醒电台（仅建立 control-only 链路 + 发送 powerstat(ON) + 等待 readiness）
   * 成功返回时电台已响应；后续会原地推进到 STARTING 完成完整启动
   */
  onWake?: () => Promise<void>;

  /**
   * 回调函数：错误处理
   */
  onError?: (error: RadioError | Error) => void;

  /**
   * 回调函数：状态变化
   */
  onStateChange?: (state: EngineState, context: EngineContext) => void;
}

// ============================================================================
// 电台状态机类型
// ============================================================================

/**
 * 电台状态枚举
 */
export enum RadioState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
}

/**
 * 电台状态机上下文
 */
export interface RadioContext {
  /**
   * 当前配置
   */
  config?: HamlibConfig;

  /**
   * 错误信息
   */
  error?: RadioError | Error;

  /**
   * 连接时间戳
   */
  connectedTimestamp?: number;

  /**
   * 断开原因
   */
  disconnectReason?: string;

  /**
   * 最后一次健康检查时间
   */
  lastHealthCheckTimestamp?: number;

  /**
   * 连接健康状态
   */
  isHealthy: boolean;

  /**
   * 是否曾经成功连接过（区分首次失败 vs 运行中断连）
   */
  wasEverConnected: boolean;

  /**
   * 当前重连次数
   */
  reconnectAttempt: number;

  /**
   * 最大重连次数
   */
  maxReconnectAttempts: number;

  /**
   * 当前退避延迟（毫秒）
   */
  reconnectDelayMs?: number;
}

/**
 * 电台状态机事件
 */
export type RadioEvent =
  | { type: 'CONNECT'; config: HamlibConfig }
  | { type: 'CONNECT_SUCCESS' }
  | { type: 'CONNECT_FAILURE'; error: RadioError | Error }
  | { type: 'DISCONNECT'; reason?: string }
  | { type: 'DISCONNECT_SUCCESS' }
  | { type: 'CONNECTION_LOST'; reason?: string }
  | { type: 'HEALTH_CHECK' }
  | { type: 'HEALTH_CHECK_PASSED' }
  | { type: 'HEALTH_CHECK_FAILED'; error: RadioError | Error }
  | { type: 'STOP_RECONNECT' };

/**
 * 电台状态机输入
 */
export interface RadioInput {
  /**
   * 回调函数：连接电台
   */
  onConnect: (config: HamlibConfig) => Promise<void>;

  /**
   * 回调函数：断开电台
   */
  onDisconnect: (reason?: string) => Promise<void>;

  /**
   * 回调函数：健康检查
   */
  onHealthCheck?: () => Promise<boolean>;

  /**
   * 回调函数：错误处理
   */
  onError?: (error: RadioError | Error) => void;

  /**
   * 回调函数：状态变化
   */
  onStateChange?: (state: RadioState, context: RadioContext) => void;

  /**
   * 健康检查间隔（毫秒）
   */
  healthCheckInterval?: number;
}

// ============================================================================
// 通用类型
// ============================================================================

/**
 * 状态机快照
 */
export interface StateMachineSnapshot<TState extends string, TContext> {
  value: TState;
  context: TContext;
  matches: (state: TState) => boolean;
}

/**
 * 状态机选项
 */
export interface StateMachineOptions {
  /**
   * 是否启用开发模式（XState Inspect）
   */
  devTools?: boolean;

  /**
   * 状态机ID（用于调试）
   */
  id?: string;
}
