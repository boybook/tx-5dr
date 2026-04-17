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
 *
 * 核心特性：
 * 1. 启动/停止失败直接回到 IDLE（context.error 记录错误信息）
 * 2. 电台断开时自动停止引擎
 * 3. 保证状态转换的原子性
 * 4. 可视化调试（XState Inspect）
 */

import { setup, createActor, fromPromise, assign, type ActorRefFrom } from 'xstate';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EngineStateMachine');
import {
  EngineState,
  type EngineContext,
  type EngineEvent,
  type EngineInput,
  type StateMachineOptions,
} from './types.js';
import { globalInspector } from './inspector.js';

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
          logger.info('Calling onStart()');
          try {
            await engineInput.onStart();
            logger.info('onStart() succeeded');
          } catch (error) {
            logger.error('onStart() failed:', error);
            throw error;
          }
        }
      ),

      /**
       * 停止异步操作
       */
      stopActor: fromPromise<void, { engineInput: EngineInput }>(
        async ({ input: { engineInput } }) => {
          logger.info('Calling onStop()');
          try {
            await engineInput.onStop();
            logger.info('onStop() succeeded');
          } catch (error) {
            logger.error('onStop() failed:', error);
            throw error;
          }
        }
      ),

      /**
       * 唤醒异步操作（control-only link + powerstat(ON) + readiness poll）
       */
      wakeActor: fromPromise<void, { engineInput: EngineInput }>(
        async ({ input: { engineInput } }) => {
          if (!engineInput.onWake) {
            throw new Error('onWake callback not provided to engine state machine');
          }
          logger.info('Calling onWake()');
          try {
            await engineInput.onWake();
            logger.info('onWake() succeeded');
          } catch (error) {
            logger.error('onWake() failed:', error);
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
          logger.info('Recording start time');
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
        logger.info(`Recording stop time (uptime: ${Math.round(duration / 1000)}s)`);
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
        logger.warn(`Forced stop: ${reason || 'unknown reason'}`);
        return { forcedStop: true };
      }),

      /**
       * 清除错误
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
       * 注意：XState v5 中 entry action 内 self.getSnapshot().value 返回的是上一个状态，
       * 因此必须通过 params.state 显式传入当前目标状态。
       */
      notifyStateChange: ({ context }, params: { engineInput: EngineInput; state: EngineState }) => {
        if (params.engineInput.onStateChange) {
          params.engineInput.onStateChange(params.state, context);
        }
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
          { type: 'notifyStateChange', params: { engineInput: input, state: EngineState.IDLE } },
        ],
        on: {
          START: {
            target: EngineState.STARTING,
          },
          POWER_ON: {
            target: EngineState.WAKING,
          },
        },
      },

      /**
       * 唤醒中：仅启动 radio 控制链路并发送 powerstat(ON)，等待电台响应
       */
      [EngineState.WAKING]: {
        entry: [
          'clearForcedStop',
          'clearError',
          { type: 'notifyStateChange', params: { engineInput: input, state: EngineState.WAKING } },
        ],
        invoke: {
          src: 'wakeActor',
          input: { engineInput: input },
          onDone: {
            // 唤醒成功，无缝进入 STARTING 完成完整启动（radio 资源会走 promote 路径）
            target: EngineState.STARTING,
          },
          onError: {
            target: EngineState.IDLE,
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
            target: EngineState.IDLE,
            actions: ['markForcedStop'],
          },
        },
      },

      /**
       * 启动中状态
       */
      [EngineState.STARTING]: {
        entry: [
          'clearForcedStop',
          'clearError',
          'recordStartTime',
          { type: 'notifyStateChange', params: { engineInput: input, state: EngineState.STARTING } },
        ],
        invoke: {
          src: 'startActor',
          input: { engineInput: input },
          onDone: {
            target: EngineState.RUNNING,
          },
          onError: {
            target: EngineState.IDLE,
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
        entry: [{ type: 'notifyStateChange', params: { engineInput: input, state: EngineState.RUNNING } }],
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
          { type: 'notifyStateChange', params: { engineInput: input, state: EngineState.STOPPING } },
        ],
        invoke: {
          src: 'stopActor',
          input: { engineInput: input },
          onDone: {
            target: EngineState.IDLE,
          },
          onError: {
            target: EngineState.IDLE,
            actions: [
              assign(({ event }) => ({
                error: event.error as Error,
              })),
              { type: 'invokeErrorHandler', params: { engineInput: input } },
            ],
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
            logger.debug('[XState Inspect]', inspectionEvent);
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

    // 立即检查当前状态
    if (actor.getSnapshot().value === targetState) {
      clearTimeout(timeoutId);
      subscription.unsubscribe();
      resolve();
    }
  });
}

/**
 * 工具函数：等待状态机进入目标状态集合中的任意一个状态
 */
export function waitForEngineStates(
  actor: EngineActor,
  targetStates: EngineState[],
  timeout = 30000
): Promise<EngineState> {
  return new Promise((resolve, reject) => {
    const matchesTarget = (state: unknown): state is EngineState =>
      targetStates.includes(state as EngineState);

    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Waiting for states [${targetStates.join(', ')}] timed out (current state: ${actor.getSnapshot().value})`
        )
      );
    }, timeout);

    const subscription = actor.subscribe((snapshot) => {
      if (matchesTarget(snapshot.value)) {
        clearTimeout(timeoutId);
        subscription.unsubscribe();
        resolve(snapshot.value);
      }
    });

    const currentState = actor.getSnapshot().value;
    if (matchesTarget(currentState)) {
      clearTimeout(timeoutId);
      subscription.unsubscribe();
      resolve(currentState);
    }
  });
}
