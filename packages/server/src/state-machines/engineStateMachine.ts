/* eslint-disable @typescript-eslint/no-explicit-any */
// EngineStateMachine - XState动作需要使用any

/**
 * 引擎状态机 (XState v5)
 *
 * 管理 DigitalRadioEngine 的生命周期状态转换
 * - idle: 空闲状态
 * - starting: 启动中（资源初始化）
 * - running: 运行中
 * - stopping: 停止中（资源清理）
 * - error: 错误状态
 *
 * 核心特性：
 * 1. 启动失败自动回滚已启动的资源
 * 2. 电台断开时自动停止引擎
 * 3. 保证状态转换的原子性
 * 4. 可视化调试（XState Inspect）
 */

import { setup, createActor, fromPromise, assign, type ActorRefFrom } from 'xstate';
import {
  EngineState,
  type EngineContext,
  type EngineEvent,
  type EngineInput,
  type StateMachineOptions,
} from './types.js';
import { globalInspector } from '../index.js';

/**
 * 创建引擎状态机
 */
export function createEngineStateMachine(
  input: EngineInput,
  options: StateMachineOptions = {}
) {
  const machine = setup({
    types: {
      context: {} as EngineContext,
      events: {} as EngineEvent,
      input: {} as { engineInput: EngineInput },
    },
    actors: {
      /**
       * 启动异步操作
       */
      startActor: fromPromise<void, { engineInput: EngineInput }>(
        async ({ input: { engineInput } }) => {
          console.log('🚀 [EngineStateMachine] 调用 onStart()');
          try {
            await engineInput.onStart();
            console.log('✅ [EngineStateMachine] onStart() 成功');
          } catch (error) {
            console.error('❌ [EngineStateMachine] onStart() 失败:', error);
            throw error;
          }
        }
      ),

      /**
       * 停止异步操作
       */
      stopActor: fromPromise<void, { engineInput: EngineInput }>(
        async ({ input: { engineInput } }) => {
          console.log('🛑 [EngineStateMachine] 调用 onStop()');
          try {
            await engineInput.onStop();
            console.log('✅ [EngineStateMachine] onStop() 成功');
          } catch (error) {
            console.error('❌ [EngineStateMachine] onStop() 失败:', error);
            throw error;
          }
        }
      ),
    },
    actions: {
      /**
       * 记录启动时间
       */
      recordStartTime: assign({
        startTimestamp: () => {
          console.log('⏱️  [EngineStateMachine] 记录启动时间');
          return Date.now();
        },
      }),

      /**
       * 记录停止时间
       */
      recordStopTime: assign(({ context }) => {
        const stopTimestamp = Date.now();
        const duration = context.startTimestamp
          ? stopTimestamp - context.startTimestamp
          : 0;
        console.log(
          `⏱️  [EngineStateMachine] 记录停止时间 (运行时长: ${Math.round(duration / 1000)}秒)`
        );
        return { stopTimestamp };
      }),

      /**
       * 标记为强制停止
       */
      markForcedStop: assign(({ event }) => {
        const reason =
          event.type === 'FORCE_STOP' || event.type === 'RADIO_DISCONNECTED'
            ? (event as any).reason
            : undefined;
        console.warn(
          `⚠️  [EngineStateMachine] 强制停止: ${reason || '未知原因'}`
        );
        return { forcedStop: true };
      }),

      /**
       * 设置错误
       */
      setError: assign(({ event }) => {
        if (event.type === 'START_FAILURE' || event.type === 'STOP_FAILURE') {
          console.error(`❌ [EngineStateMachine] 错误: ${event.error.message}`);
          return { error: event.error };
        }
        return {};
      }),

      /**
       * 清除错误和forcedStop标志
       */
      clearError: assign({
        error: undefined,
      }) as any,

      /**
       * 清除强制停止标志
       */
      clearForcedStop: assign({
        forcedStop: false,
      }) as any,

      /**
       * 调用错误处理回调
       */
      invokeErrorHandler: ({ context }, params: { engineInput: EngineInput }) => {
        if (params.engineInput.onError && context.error) {
          params.engineInput.onError(context.error);
        }
      },

      /**
       * 调用状态变化回调
       */
      notifyStateChange: ({ context, self }, params: { engineInput: EngineInput }) => {
        const state = self.getSnapshot().value as EngineState;
        if (params.engineInput.onStateChange) {
          params.engineInput.onStateChange(state, context);
        }
      },

      /**
       * 日志: 清除错误状态
       */
      logClearError: () => {
        console.log('🧹 [EngineStateMachine] 清除错误状态');
      },
    },
  }).createMachine({
    id: options.id || 'engineStateMachine',
    initial: EngineState.IDLE,
    context: {
      startedResources: [],
      forcedStop: false,
    },
    states: {
      /**
       * 空闲状态
       */
      [EngineState.IDLE]: {
        entry: [
          'logClearError',
          'clearError',
          { type: 'notifyStateChange', params: { engineInput: input } },
        ],
        on: {
          START: {
            target: EngineState.STARTING,
          },
        },
      },

      /**
       * 启动中状态
       */
      [EngineState.STARTING]: {
        entry: [
          'clearForcedStop',
          'recordStartTime',
          { type: 'notifyStateChange', params: { engineInput: input } },
        ],
        invoke: {
          src: 'startActor',
          input: { engineInput: input },
          onDone: {
            target: EngineState.RUNNING,
          },
          onError: {
            target: EngineState.ERROR,
            actions: [
              assign(({ event }) => ({
                error: event.error as Error,
              })),
              { type: 'invokeErrorHandler', params: { engineInput: input } },
            ],
          },
        },
        on: {
          FORCE_STOP: {
            target: EngineState.STOPPING,
            actions: ['markForcedStop'],
          },
          RADIO_DISCONNECTED: {
            target: EngineState.STOPPING,
            actions: ['markForcedStop'],
          },
        },
      },

      /**
       * 运行中状态
       */
      [EngineState.RUNNING]: {
        entry: [{ type: 'notifyStateChange', params: { engineInput: input } }],
        on: {
          STOP: {
            target: EngineState.STOPPING,
          },
          FORCE_STOP: {
            target: EngineState.STOPPING,
            actions: ['markForcedStop'],
          },
          RADIO_DISCONNECTED: {
            target: EngineState.STOPPING,
            actions: ['markForcedStop'],
          },
        },
      },

      /**
       * 停止中状态
       */
      [EngineState.STOPPING]: {
        entry: [
          'recordStopTime',
          { type: 'notifyStateChange', params: { engineInput: input } },
        ],
        invoke: {
          src: 'stopActor',
          input: { engineInput: input },
          onDone: {
            target: EngineState.IDLE,
          },
          onError: {
            target: EngineState.ERROR,
            actions: [
              assign(({ event }) => ({
                error: event.error as Error,
              })),
              { type: 'invokeErrorHandler', params: { engineInput: input } },
            ],
          },
        },
      },

      /**
       * 错误状态
       */
      [EngineState.ERROR]: {
        entry: [
          'setError',
          { type: 'invokeErrorHandler', params: { engineInput: input } },
          { type: 'notifyStateChange', params: { engineInput: input } },
        ],
        on: {
          RESET: {
            target: EngineState.IDLE,
            actions: ['clearError'],
          },
          RETRY: {
            target: EngineState.STARTING,
            actions: ['clearError'],
          },
          STOP: {
            target: EngineState.STOPPING,
          },
        },
      },
    },
  });

  return machine;
}

/**
 * 创建引擎状态机 Actor
 */
export function createEngineActor(
  input: EngineInput,
  options: StateMachineOptions = {}
) {
  const machine = createEngineStateMachine(input, options);

  const actor = createActor(machine, {
    input: { engineInput: input },
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
 * 引擎状态机 Actor 类型
 */
export type EngineActor = ActorRefFrom<ReturnType<typeof createEngineStateMachine>>;

/**
 * 工具函数：判断当前状态
 */
export function isEngineState(
  actor: EngineActor,
  state: EngineState | EngineState[]
): boolean {
  const currentState = actor.getSnapshot().value;
  if (Array.isArray(state)) {
    return state.includes(currentState as EngineState);
  }
  return currentState === state;
}

/**
 * 工具函数：获取当前上下文
 */
export function getEngineContext(actor: EngineActor): EngineContext {
  return actor.getSnapshot().context;
}

/**
 * 工具函数：等待状态转换
 */
export function waitForEngineState(
  actor: EngineActor,
  targetState: EngineState,
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
