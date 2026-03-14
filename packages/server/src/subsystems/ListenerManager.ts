import type { EventEmitter } from 'eventemitter3';

/**
 * 监听器生命周期管理工具
 *
 * 精确追踪每个 listen() 调用，disposeAll() 只移除自己注册的监听器。
 * 比 removeAllListeners() 更安全，不会误清其他消费者（如 WSServer）的监听器。
 */
export class ListenerManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners: Array<{ emitter: EventEmitter<any>; event: string; handler: (...args: any[]) => void }> = [];

  /**
   * 注册事件监听器并追踪
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listen<E extends EventEmitter<any>>(emitter: E, event: string, handler: (...args: any[]) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitter.on(event as any, handler);
    this.listeners.push({ emitter, event, handler });
  }

  /**
   * 移除所有已追踪的监听器
   */
  disposeAll(): void {
    for (const { emitter, event, handler } of this.listeners) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emitter.off(event as any, handler);
    }
    this.listeners = [];
  }

  /**
   * 当前追踪的监听器数量
   */
  get count(): number {
    return this.listeners.length;
  }
}
