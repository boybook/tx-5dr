/**
 * 电台状态机
 *
 * 管理物理电台的连接状态转换
 * - disconnected: 断开连接
 * - connecting: 连接中
 * - connected: 已连接
 * - reconnecting: 重连中（仅手动触发）
 * - error: 错误状态
 *
 * 核心特性：
 * 1. 手动触发重连（用户点击连接按钮）
 * 2. 连接健康检查
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
import { globalInspector } from '../index.js';

/**
 * 创建电台状态机
 */
export function createRadioStateMachine(
  input: RadioInput,
  options: StateMachineOptions = {}
) {
  const healthCheckInterval = input.healthCheckInterval ?? 3000; // 默认3秒

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
          console.log('🔌 [RadioStateMachine] 调用 onConnect()');

          // 验证 config 是否存在
          if (!config) {
            const error = new Error('电台配置缺失：无法进行连接操作');
            console.error('❌ [RadioStateMachine] onConnect() 失败:', error);
            throw error;
          }

          try {
            await radioInput.onConnect(config);
            console.log('✅ [RadioStateMachine] onConnect() 成功');
          } catch (error) {
            console.error('❌ [RadioStateMachine] onConnect() 失败:', error);
            throw error;
          }
        }
      ),

      /**
       * 断开 Actor（异步操作）
       */
      disconnectActor: fromPromise<void, { radioInput: RadioInput; reason?: string }>(
        async ({ input: { radioInput, reason } }) => {
          console.log(`🔌 [RadioStateMachine] 调用 onDisconnect(${reason || ''})`);
          try {
            await radioInput.onDisconnect(reason);
            console.log('✅ [RadioStateMachine] onDisconnect() 成功');
          } catch (error) {
            console.error('❌ [RadioStateMachine] onDisconnect() 失败:', error);
            throw error;
          }
        }
      ),
    },
    actions: {

      /**
       * 保存配置
       */
      saveConfig: ({ context, event }) => {
        if (event.type === 'CONNECT') {
          context.config = event.config;
          console.log('💾 [RadioStateMachine] 保存配置');
        }
      },

      /**
       * 记录连接时间
       */
      recordConnectedTime: ({ context }) => {
        context.connectedTimestamp = Date.now();
        context.isHealthy = true;
        console.log('⏱️  [RadioStateMachine] 记录连接时间');
      },

      /**
       * 记录断开原因
       */
      recordDisconnectReason: ({ context, event }) => {
        if (
          event.type === 'DISCONNECT' ||
          event.type === 'CONNECTION_LOST'
        ) {
          context.disconnectReason = event.reason;
          context.isHealthy = false;
          console.log(
            `⚠️  [RadioStateMachine] 记录断开原因: ${event.reason || '未知'}`
          );
        }
      },


      /**
       * 设置错误
       */
      setError: ({ context, event }) => {
        if (
          event.type === 'CONNECT_FAILURE' ||
          event.type === 'RECONNECT_FAILURE' ||
          event.type === 'HEALTH_CHECK_FAILED'
        ) {
          context.error = event.error;
          context.isHealthy = false;
          console.error(
            `❌ [RadioStateMachine] 错误: ${event.error.message}`
          );
        }
      },

      /**
       * 清除错误
       */
      clearError: ({ context }) => {
        context.error = undefined;
        console.log('🧹 [RadioStateMachine] 清除错误状态');
      },

      /**
       * 更新健康检查时间
       */
      updateHealthCheckTime: ({ context }) => {
        context.lastHealthCheckTimestamp = Date.now();
      },

      /**
       * 标记健康
       */
      markHealthy: ({ context }) => {
        context.isHealthy = true;
      },

      /**
       * 标记不健康
       */
      markUnhealthy: ({ context }) => {
        context.isHealthy = false;
      },

      /**
       * 通知状态变化
       */
      notifyStateChange: ({ context, self }, params: { input: RadioInput }) => {
        const state = self.getSnapshot().value as RadioState;
        if (params.input.onStateChange) {
          params.input.onStateChange(state, context);
        }
      },

      /**
       * 调用错误处理
       */
      invokeErrorHandler: ({ context }, params: { input: RadioInput }) => {
        if (params.input.onError && context.error) {
          params.input.onError(context.error);
        }
      },

      /**
       * 调用断开连接处理
       */
      invokeDisconnectHandler: ({ context }, params: { input: RadioInput }) => {
        if (params.input.onDisconnect) {
          params.input.onDisconnect(context.disconnectReason);
        }
      },
    },
    guards: {
      /**
       * 检查是否有错误
       */
      hasError: ({ context }) => {
        return context.error !== undefined;
      },
    },
    delays: {
      /**
       * 健康检查间隔
       */
      healthCheckInterval: () => healthCheckInterval,
    },
  }).createMachine({
    id: options.id || 'radioStateMachine',
    initial: RadioState.DISCONNECTED,
    context: {
      isHealthy: false,
    },
    states: {
      /**
       * 断开连接状态
       */
      [RadioState.DISCONNECTED]: {
        entry: [
          'clearError',
          'recordDisconnectReason',
          { type: 'invokeDisconnectHandler', params: { input } },
          { type: 'notifyStateChange', params: { input } },
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
        entry: [{ type: 'notifyStateChange', params: { input } }],
        invoke: {
          src: 'connectActor',
          input: ({ context, event }) => {
            // 优先使用事件中的 config（首次连接），如果没有则使用 context 中保存的 config（重连）
            const eventConfig = (event as Extract<RadioEvent, { type: 'CONNECT' }>).config;
            const config = eventConfig || context.config;

            if (!config) {
              console.error('❌ [RadioStateMachine] 无法获取电台配置，event 和 context 中都没有 config');
            }

            return {
              radioInput: input,
              config: config!,
            };
          },
          onDone: {
            target: RadioState.CONNECTED,
            actions: ['recordConnectedTime'],
          },
          onError: {
            // 连接失败，进入错误状态，等待用户手动重试
            target: RadioState.ERROR,
            actions: [
              ({ event, context }: any) => {
                context.error = event.error;
                console.error(
                  '❌ [RadioStateMachine] 连接失败:',
                  event.error
                );
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
        entry: ['markHealthy', { type: 'notifyStateChange', params: { input } }],
        on: {
          DISCONNECT: {
            target: RadioState.DISCONNECTED,
            actions: ['recordDisconnectReason'],
          },
          CONNECTION_LOST: {
            // 连接丢失，进入断开状态，不自动重连
            target: RadioState.DISCONNECTED,
            actions: ['recordDisconnectReason'],
          },
          HEALTH_CHECK_FAILED: {
            // 健康检查失败，进入错误状态，不自动重连
            target: RadioState.ERROR,
            actions: ['setError', { type: 'invokeErrorHandler', params: { input } }],
          },
        },
        // 定期健康检查
        after: {
          healthCheckInterval: {
            actions: ['updateHealthCheckTime'],
            reenter: true,
          },
        },
      },

      /**
       * 重连中状态（仅供手动触发，不自动转换）
       */
      [RadioState.RECONNECTING]: {
        entry: [
          'markUnhealthy',
          { type: 'notifyStateChange', params: { input } },
        ],
        on: {
          RECONNECT: {
            // 用户手动触发重连
            target: RadioState.CONNECTING,
          },
          STOP_RECONNECTING: {
            target: RadioState.DISCONNECTED,
          },
          DISCONNECT: {
            target: RadioState.DISCONNECTED,
            actions: ['recordDisconnectReason'],
          },
        },
      },

      /**
       * 错误状态
       */
      [RadioState.ERROR]: {
        entry: [
          'setError',
          'markUnhealthy',
          { type: 'invokeErrorHandler', params: { input } },
          { type: 'notifyStateChange', params: { input } },
        ],
        on: {
          RESET: {
            target: RadioState.DISCONNECTED,
            actions: ['clearError'],
          },
          RECONNECT: {
            target: RadioState.CONNECTING,
            actions: ['clearError'],
          },
          DISCONNECT: {
            target: RadioState.DISCONNECTED,
            actions: ['clearError'],
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
            console.log('[XState Inspect]', inspectionEvent);
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
          `等待状态 ${targetState} 超时 (当前状态: ${actor.getSnapshot().value})`
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

    // 立即检查当前状态
    if (actor.getSnapshot().value === targetState) {
      clearTimeout(timeoutId);
      subscription.unsubscribe();
      resolve();
    }
  });
}
