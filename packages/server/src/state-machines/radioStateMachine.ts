/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 电台状态机
 *
 * 管理物理电台的连接状态转换
 * - disconnected: 断开连接
 * - connecting: 连接中
 * - connected: 已连接
 * - reconnecting: 自动重连中
 *
 * 核心特性：
 * 1. 首次连接失败 → 回到 DISCONNECTED + 错误通知
 * 2. 运行中断连 → 自动重连（指数退避，最多5次）
 * 3. 连接健康检查
 */

import { setup, createActor, fromPromise, type ActorRefFrom } from 'xstate';
import {
  RadioState,
  type RadioContext,
  type RadioEvent,
  type RadioInput,
  type StateMachineOptions,
} from './types.js';
import type { HamlibConfig } from '@tx5dr/contracts';
import { globalInspector } from './inspector.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioStateMachine');

/** 指数退避延迟序列（毫秒） */
const RECONNECT_DELAYS = [2000, 4000, 8000, 16000, 30000];

/**
 * 创建电台状态机
 */
export function createRadioStateMachine(
  input: RadioInput,
  options: StateMachineOptions = {}
) {
  const healthCheckInterval = input.healthCheckInterval ?? 3000;

  const machine = setup({
    types: {
      context: {} as RadioContext,
      events: {} as RadioEvent,
      input: {} as RadioInput,
    },
    actors: {
      /**
       * 连接 Actor（异步操作）
       */
      connectActor: fromPromise<void, { radioInput: RadioInput; config: HamlibConfig }>(
        async ({ input: { radioInput, config } }) => {
          logger.info('Calling onConnect()');
          if (!config) {
            throw new Error('Radio config missing: cannot connect');
          }
          try {
            await radioInput.onConnect(config);
            logger.info('onConnect() succeeded');
          } catch (error) {
            logger.error('onConnect() failed:', error);
            throw error;
          }
        }
      ),

      /**
       * 重连 Actor（带退避延迟的连接尝试）
       */
      reconnectActor: fromPromise<void, { radioInput: RadioInput; config: HamlibConfig; delayMs: number }>(
        async ({ input: { radioInput, config, delayMs } }) => {
          logger.debug(`Waiting ${delayMs}ms before reconnect...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          logger.info('Starting reconnect attempt');
          await radioInput.onConnect(config);
          logger.info('Reconnect succeeded');
        }
      ),
    },
    actions: {
      saveConfig: ({ context, event }) => {
        if (event.type === 'CONNECT') {
          context.config = event.config;
          logger.debug('Config saved');
        }
      },

      recordConnectedTime: ({ context }) => {
        context.connectedTimestamp = Date.now();
        context.isHealthy = true;
        logger.info('Connected - recording connection time');
      },

      recordDisconnectReason: ({ context, event }) => {
        if (event.type === 'DISCONNECT' || event.type === 'CONNECTION_LOST') {
          context.disconnectReason = event.reason;
          context.isHealthy = false;
          logger.info(`Disconnect reason recorded: ${event.reason || 'unknown'}`);
        }
      },

      setError: ({ context, event }) => {
        if (event.type === 'CONNECT_FAILURE' || event.type === 'HEALTH_CHECK_FAILED') {
          context.error = event.error;
          context.isHealthy = false;
          logger.error(`Error: ${event.error.message}`);
        }
      },

      clearError: ({ context }) => {
        context.error = undefined;
        logger.debug('Error state cleared');
      },

      updateHealthCheckTime: ({ context }) => {
        context.lastHealthCheckTimestamp = Date.now();
      },

      markHealthy: ({ context }) => {
        context.isHealthy = true;
      },

      markUnhealthy: ({ context }) => {
        context.isHealthy = false;
      },

      /** 标记曾经成功连接过 */
      markEverConnected: ({ context }) => {
        context.wasEverConnected = true;
        logger.info('Marked as ever-connected');
      },

      /** 递增重连次数 */
      incrementReconnectAttempt: ({ context }) => {
        context.reconnectAttempt++;
        logger.debug(`Reconnect attempt: ${context.reconnectAttempt}/${context.maxReconnectAttempts}`);
      },

      /** 计算退避延迟 */
      calculateReconnectDelay: ({ context }) => {
        const idx = Math.min(context.reconnectAttempt - 1, RECONNECT_DELAYS.length - 1);
        context.reconnectDelayMs = RECONNECT_DELAYS[idx];
        logger.debug(`Backoff delay: ${context.reconnectDelayMs}ms`);
      },

      /** 重置重连状态 */
      resetReconnectState: ({ context }) => {
        context.reconnectAttempt = 0;
        context.reconnectDelayMs = undefined;
      },

      invokeErrorHandler: ({ context }, params: { input: RadioInput }) => {
        if (params.input.onError && context.error) {
          params.input.onError(context.error);
        }
      },
    },
    guards: {
      /** 是否应该自动重连（曾经成功连接过） */
      shouldAutoReconnect: ({ context }) => context.wasEverConnected === true,

      /** 是否还有重试次数 */
      hasRetriesRemaining: ({ context }) => context.reconnectAttempt < context.maxReconnectAttempts,
    },
    delays: {
      healthCheckInterval: () => healthCheckInterval,
    },
  }).createMachine({
    id: options.id || 'radioStateMachine',
    initial: RadioState.DISCONNECTED,
    context: {
      isHealthy: false,
      wasEverConnected: false,
      reconnectAttempt: 0,
      maxReconnectAttempts: 5,
    },
    states: {
      /**
       * 断开连接状态
       */
      [RadioState.DISCONNECTED]: {
        entry: [
          'clearError',
          'recordDisconnectReason',
          'resetReconnectState',
        ],
        on: {
          CONNECT: {
            target: RadioState.CONNECTING,
            actions: ['saveConfig'],
          },
        },
      },

      /**
       * 连接中状态
       */
      [RadioState.CONNECTING]: {
        invoke: {
          src: 'connectActor',
          input: ({ context, event }) => {
            const eventConfig = (event as Extract<RadioEvent, { type: 'CONNECT' }>).config;
            const config = eventConfig || context.config;
            if (!config) {
              logger.error('Unable to get radio config');
            }
            return { radioInput: input, config: config! };
          },
          onDone: {
            target: RadioState.CONNECTED,
            actions: ['recordConnectedTime', 'markEverConnected'],
          },
          onError: {
            // 首次连接失败 → 回到 DISCONNECTED（不进 ERROR）
            target: RadioState.DISCONNECTED,
            actions: [
              ({ event, context }: any) => {
                context.error = event.error;
                logger.error('Connection failed:', event.error);
              },
              { type: 'invokeErrorHandler', params: { input } },
            ],
          },
        },
        on: {
          DISCONNECT: {
            target: RadioState.DISCONNECTED,
            actions: ['recordDisconnectReason'],
          },
        },
      },

      /**
       * 已连接状态
       */
      [RadioState.CONNECTED]: {
        entry: ['markHealthy', 'markEverConnected'],
        on: {
          DISCONNECT: {
            target: RadioState.DISCONNECTED,
            actions: ['recordDisconnectReason'],
          },
          CONNECTION_LOST: [
            {
              guard: 'shouldAutoReconnect',
              target: RadioState.RECONNECTING,
              actions: ['recordDisconnectReason'],
            },
            {
              target: RadioState.DISCONNECTED,
              actions: ['recordDisconnectReason'],
            },
          ],
          HEALTH_CHECK_FAILED: [
            {
              guard: 'shouldAutoReconnect',
              target: RadioState.RECONNECTING,
              actions: ['setError'],
            },
            {
              target: RadioState.DISCONNECTED,
              actions: ['setError', { type: 'invokeErrorHandler', params: { input } }],
            },
          ],
        },
        after: {
          healthCheckInterval: {
            actions: ['updateHealthCheckTime'],
            reenter: true,
          },
        },
      },

      /**
       * 自动重连状态
       * XState 在 re-enter 时会先 exit 再 entry，invoke 的 actor 会被取消并重新创建
       */
      [RadioState.RECONNECTING]: {
        entry: [
          'incrementReconnectAttempt',
          'calculateReconnectDelay',
        ],
        invoke: {
          src: 'reconnectActor',
          input: ({ context }) => ({
            radioInput: input,
            config: context.config!,
            delayMs: context.reconnectDelayMs || 2000,
          }),
          onDone: {
            target: RadioState.CONNECTED,
            actions: ['recordConnectedTime', 'resetReconnectState'],
          },
          onError: [
            {
              guard: 'hasRetriesRemaining',
              target: RadioState.RECONNECTING,
              reenter: true,
            },
            {
              target: RadioState.DISCONNECTED,
              actions: ['resetReconnectState'],
            },
          ],
        },
        on: {
          STOP_RECONNECT: {
            target: RadioState.DISCONNECTED,
            actions: ['resetReconnectState'],
          },
          DISCONNECT: {
            target: RadioState.DISCONNECTED,
            actions: ['resetReconnectState', 'recordDisconnectReason'],
          },
        },
      },

    },
  });

  return machine;
}

/**
 * 创建电台状态机 Actor
 */
export function createRadioActor(
  input: RadioInput,
  options: StateMachineOptions = {}
) {
  const machine = createRadioStateMachine(input, options);

  const actor = createActor(machine, {
    input: input,
    inspect:
      globalInspector?.inspect ||
      (options.devTools
        ? (inspectionEvent) => {
            logger.debug('[XState Inspect]', inspectionEvent);
          }
        : undefined),
  });

  return actor;
}

/**
 * 电台状态机 Actor 类型
 */
export type RadioActor = ActorRefFrom<ReturnType<typeof createRadioStateMachine>>;

/**
 * 工具函数：判断当前状态
 */
export function isRadioState(
  actor: RadioActor,
  state: RadioState | RadioState[]
): boolean {
  const currentState = actor.getSnapshot().value;
  if (Array.isArray(state)) {
    return state.includes(currentState as RadioState);
  }
  return currentState === state;
}

/**
 * 工具函数：获取当前上下文
 */
export function getRadioContext(actor: RadioActor): RadioContext {
  return actor.getSnapshot().context;
}

/**
 * 工具函数：等待状态转换
 */
export function waitForRadioState(
  actor: RadioActor,
  targetState: RadioState,
  timeout = 30000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Waiting for state ${targetState} timed out (current state: ${actor.getSnapshot().value})`
        )
      );
    }, timeout);

    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.value === targetState) {
        clearTimeout(timeoutId);
        subscription.unsubscribe();
        resolve();
      }
    });

    if (actor.getSnapshot().value === targetState) {
      clearTimeout(timeoutId);
      subscription.unsubscribe();
      resolve();
    }
  });
}
