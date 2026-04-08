import type { PluginTimers } from '@tx5dr/plugin-api';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginTimers');

/**
 * 插件定时器管理
 * 所有定时器在 clearAll() 时统一清除（onUnload 时调用）
 */
export class PluginTimerManager implements PluginTimers {
  private timers = new Map<string, NodeJS.Timeout>();
  private pluginName: string;
  private onTimerFired: (timerId: string) => void;

  constructor(pluginName: string, onTimerFired: (timerId: string) => void) {
    this.pluginName = pluginName;
    this.onTimerFired = onTimerFired;
  }

  set(id: string, intervalMs: number): void {
    this.clear(id);
    logger.debug(`Timer set: plugin=${this.pluginName}, id=${id}, intervalMs=${intervalMs}`);
    this.timers.set(id, setInterval(() => {
      logger.debug(`Timer fired: plugin=${this.pluginName}, id=${id}`);
      this.onTimerFired(id);
    }, intervalMs));
  }

  clear(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearInterval(t);
      this.timers.delete(id);
      logger.debug(`Timer cleared: plugin=${this.pluginName}, id=${id}`);
    }
  }

  clearAll(): void {
    for (const [id, t] of this.timers) {
      clearInterval(t);
      logger.debug(`Timer cleared on unload: plugin=${this.pluginName}, id=${id}`);
    }
    this.timers.clear();
  }
}
