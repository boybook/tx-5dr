import type { UIBridge, PluginUIHandler } from '@tx5dr/plugin-api';
import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginUIBridge');

/**
 * 插件 UI 数据桥接
 *
 * - `send()`: 将面板数据通过引擎事件发出，经 WSServer 广播到前端
 * - `registerPageHandler()`: 注册自定义 iframe 页面消息处理器
 * - `pushToPage()`: 主动推送消息到 iframe 页面
 */
export class PluginUIBridge implements UIBridge {
  private pageHandler: PluginUIHandler | null = null;

  constructor(
    private pluginName: string,
    private operatorId: string,
    private eventEmitter: EventEmitter<DigitalRadioEngineEvents>,
  ) {}

  send(panelId: string, data: unknown): void {
    logger.debug(`Plugin UI data: plugin=${this.pluginName}, panel=${panelId}`);
    this.eventEmitter.emit('pluginData', {
      pluginName: this.pluginName,
      operatorId: this.operatorId,
      panelId,
      data,
    });
  }

  registerPageHandler(handler: PluginUIHandler): void {
    this.pageHandler = handler;
    logger.debug(`Page handler registered for plugin=${this.pluginName}`);
  }

  pushToPage(pageId: string, action: string, data?: unknown): void {
    this.eventEmitter.emit('pluginPagePush' as keyof DigitalRadioEngineEvents, {
      pluginName: this.pluginName,
      pageId,
      action,
      data,
    } as never);
  }

  /**
   * @internal Invoked by the host when an iframe sends a `tx5dr:invoke`
   * message. Routes to the registered page handler.
   */
  async handlePageInvoke(pageId: string, action: string, data: unknown): Promise<unknown> {
    if (!this.pageHandler) {
      throw new Error(`No page handler registered for plugin ${this.pluginName}`);
    }
    return this.pageHandler.onMessage(pageId, action, data);
  }

  /** @internal Check if a page handler has been registered. */
  hasPageHandler(): boolean {
    return this.pageHandler !== null;
  }
}
