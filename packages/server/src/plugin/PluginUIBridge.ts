import type {
  PluginUIRequestContext,
  UIBridge,
  PluginUIHandler,
  PluginUIInstanceTarget,
  PluginUIPageSessionInfo,
} from '@tx5dr/plugin-api';
import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import type { PluginPageSession } from './PluginPageSessionStore.js';

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
  private readonly operatorId: string;

  constructor(
    private readonly pluginName: string,
    private readonly instanceTarget: PluginUIInstanceTarget,
    private readonly eventEmitter: EventEmitter<DigitalRadioEngineEvents>,
    private readonly listSessions: (
      pluginName: string,
      instanceTarget: PluginUIInstanceTarget,
      pageId?: string,
    ) => PluginPageSession[],
  ) {
    this.operatorId = instanceTarget.kind === 'operator'
      ? instanceTarget.operatorId
      : '__global__';
  }

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

  pushToSession(pageSessionId: string, action: string, data?: unknown): void {
    const session = this.listSessions(this.pluginName, this.instanceTarget)
      .find((entry) => entry.sessionId === pageSessionId);
    if (!session) {
      throw new Error('page_session_not_found');
    }
    this.emitToSession(session, action, data);
  }

  listActivePageSessions(pageId: string): PluginUIPageSessionInfo[] {
    return this.listSessions(this.pluginName, this.instanceTarget, pageId)
      .map((session) => ({
        sessionId: session.sessionId,
        pageId: session.pageId,
        resource: session.resource,
      }));
  }

  pushToPage(pageId: string, action: string, data?: unknown): void {
    const sessions = this.listSessions(this.pluginName, this.instanceTarget, pageId);
    if (sessions.length === 0) {
      throw new Error('page_session_not_found');
    }
    if (sessions.length > 1) {
      throw new Error('explicit_page_session_required');
    }
    this.emitToSession(sessions[0], action, data);
  }

  private emitToSession(
    session: Pick<PluginPageSession, 'sessionId' | 'pageId'>,
    action: string,
    data?: unknown,
  ): void {
    this.eventEmitter.emit('pluginPagePush', {
      pluginName: this.pluginName,
      pageId: session.pageId,
      pageSessionId: session.sessionId,
      action,
      data,
    });
  }

  /**
   * @internal Invoked by the host when an iframe sends a `tx5dr:invoke`
   * message. Routes to the registered page handler.
   */
  async handlePageInvoke(
    pageId: string,
    action: string,
    data: unknown,
    requestContext: PluginUIRequestContext,
  ): Promise<unknown> {
    if (!this.pageHandler) {
      throw new Error(`No page handler registered for plugin ${this.pluginName}`);
    }
    return this.pageHandler.onMessage(pageId, action, data, requestContext);
  }

  /** @internal Check if a page handler has been registered. */
  hasPageHandler(): boolean {
    return this.pageHandler !== null;
  }
}
