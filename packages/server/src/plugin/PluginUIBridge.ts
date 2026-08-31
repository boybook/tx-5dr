import type {
  PluginUIRequestContext,
  UIBridge,
  PluginUIHandler,
  PluginUIHandlerRegistration,
  PluginUIInstanceTarget,
  PluginUIPageSessionInfo,
} from '@tx5dr/plugin-api';
import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents, PluginPanelDescriptor, PluginPanelMetaPayload } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import type { PluginPageSession } from './PluginPageSessionStore.js';
import { snapshotPluginData } from './plugin-data-boundary.js';

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
  private readonly scopedPageHandlers = new Map<string, PluginUIHandler>();
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
    private readonly onPanelMeta?: (payload: PluginPanelMetaPayload) => void,
    private readonly onPanelContributions?: (
      pluginName: string,
      instanceTarget: PluginUIInstanceTarget,
      groupId: string,
      panels: PluginPanelDescriptor[],
    ) => void,
    private readonly onRefreshOperatorProjection?: (operatorId: string) => void,
  ) {
    this.operatorId = instanceTarget.kind === 'operator'
      ? instanceTarget.operatorId
      : '__global__';
  }

  send(panelId: string, data: unknown): void {
    const snapshot = snapshotPluginData(data, 'json');
    logger.debug(`Plugin UI data: plugin=${this.pluginName}, panel=${panelId}`);
    this.eventEmitter.emit('pluginData', {
      pluginName: this.pluginName,
      operatorId: this.operatorId,
      panelId,
      data: snapshot,
    });
  }

  setPanelMeta(panelId: string, meta: import('@tx5dr/plugin-api').PanelMeta): void {
    const snapshot = snapshotPluginData(meta, 'json');
    logger.debug(`Plugin UI meta: plugin=${this.pluginName}, panel=${panelId}`, snapshot);
    const payload: PluginPanelMetaPayload = {
      pluginName: this.pluginName,
      operatorId: this.operatorId,
      panelId,
      meta: snapshot,
    };
    this.onPanelMeta?.(payload);
    this.eventEmitter.emit('pluginPanelMeta', payload);
  }

  setPanelContributions(groupId: string, panels: PluginPanelDescriptor[]): void {
    logger.debug(`Plugin UI panel contributions: plugin=${this.pluginName}, group=${groupId}, count=${panels.length}`);
    if (!this.onPanelContributions) {
      throw new Error('panel_contributions_not_supported');
    }
    const snapshot = snapshotPluginData(panels, 'json');
    this.onPanelContributions(this.pluginName, this.instanceTarget, groupId, snapshot);
  }

  clearPanelContributions(groupId: string): void {
    this.setPanelContributions(groupId, []);
  }

  refreshOperatorProjection(): void {
    if (this.instanceTarget.kind !== 'operator') {
      throw new Error('operator_projection_requires_operator_instance');
    }
    this.onRefreshOperatorProjection?.(this.instanceTarget.operatorId);
  }

  registerPageHandler(
    handler: PluginUIHandler,
    registration?: PluginUIHandlerRegistration,
  ): void {
    if (registration?.pageIds !== undefined) {
      const pageIds = [...new Set(registration.pageIds.map((pageId) => pageId.trim()).filter(Boolean))];
      if (pageIds.length === 0) throw new Error('page_handler_page_ids_required');
      for (const pageId of pageIds) this.scopedPageHandlers.set(pageId, handler);
      logger.debug(`Scoped page handler registered for plugin=${this.pluginName}, pages=${pageIds.join(',')}`);
      return;
    }
    this.pageHandler = handler;
    logger.debug(`Fallback page handler registered for plugin=${this.pluginName}`);
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
    const snapshot = snapshotPluginData(data, 'json');
    this.eventEmitter.emit('pluginPagePush', {
      pluginName: this.pluginName,
      pageId: session.pageId,
      pageSessionId: session.sessionId,
      action,
      data: snapshot,
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
    const handler = this.scopedPageHandlers.get(pageId) ?? this.pageHandler;
    if (!handler) {
      throw new Error(`No page handler registered for plugin ${this.pluginName}`);
    }
    return handler.onMessage(pageId, action, data, requestContext);
  }

  /** @internal Check if a page handler has been registered. */
  hasPageHandler(): boolean {
    return this.pageHandler !== null || this.scopedPageHandlers.size > 0;
  }

  /** @internal Stops accepting page messages before plugin teardown begins. */
  clearPageHandler(): void {
    this.pageHandler = null;
    this.scopedPageHandlers.clear();
  }
}
