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
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  ERROR = 'error',
}

/**
 * 引擎状态机上下文
 */
export interface EngineContext {
  /**
   * 错误信息（当状态为 error 时）
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
  | { type: 'RETRY' }
  | { type: 'RESET' };

/**
 * 引擎状态机输入
 */
export interface EngineInput {
  /**
   * 回调函数：资源启动
   */
  onStart: () => Promise<void>;

  /**
   * 回调函数：资源停止
   */
  onStop: () => Promise<void>;

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
  ERROR = 'error',
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
   * 重连尝试次数
   */
  reconnectAttempts: number;

  /**
   * 最大重连次数（-1 表示无限重连）
   */
  maxReconnectAttempts: number;

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
  | { type: 'RECONNECT' }
  | { type: 'RECONNECT_SUCCESS' }
  | { type: 'RECONNECT_FAILURE'; error: RadioError | Error }
  | { type: 'STOP_RECONNECTING' }
  | { type: 'HEALTH_CHECK' }
  | { type: 'HEALTH_CHECK_PASSED' }
  | { type: 'HEALTH_CHECK_FAILED'; error: RadioError | Error }
  | { type: 'RESET' };

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
   * 最大重连次数（-1 表示无限重连）
   */
  maxReconnectAttempts?: number;

  /**
   * 重连延迟（毫秒）
   */
  reconnectDelay?: number;

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
