/* eslint-disable @typescript-eslint/no-explicit-any */
// LogbookWSServer - WebSocket消息处理需要使用any

import { WSMessageHandler } from '@tx5dr/core';
import {
  LOGBOOK_SELECT_TARGET_FEATURE,
  LogbookSelectTargetCommandSchema,
  UserRole,
  WSMessageType,
  type LogbookSelectTargetResult,
  type LogbookSelectedFrame,
} from '@tx5dr/contracts';
import type { OperatorStatus, PSKReporterReceptionSpot, PSKReporterReceptionUpdate, SlotPack } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { createLogger } from '../utils/logger.js';
import type { LogbookLiveDecodeFeed } from './LogbookLiveDecodeFeed.js';
import { getCallRejectionMessageKey, type OperatorTargetSelection } from './OperatorTargetCommandService.js';
import type {
  PSKReporterReceptionService,
  ReceptionFollow,
} from '../services/pskreporterReception/PSKReporterReceptionService.js';

const logger = createLogger('LogbookWSServer');

/** QSO target selection from logbook pages. */
export interface LogbookTargetCommands {
  /**
   * Whether the token behind a connection may manage this operator right now
   * (re-read on every command, so revoked or narrowed tokens stop at once).
   * `tokenId` is undefined when authentication is off.
   */
  canManageOperator(tokenId: string | undefined, operatorId: string): boolean;
  selectTarget(operatorId: string, callsign: string, selectedFrame: LogbookSelectedFrame): Promise<OperatorTargetSelection>;
}

/** Whether a connection's token is still valid (not revoked, not expired). */
export type LogbookTokenCheck = (tokenId: string) => boolean;

/** Close code of a page whose token was revoked or expired, as at connect time. */
const TOKEN_REVOKED_CLOSE_CODE = 4001;

interface LogbookConnection {
  id: string;
  ws: any;
  handler: WSMessageHandler;
  operatorId?: string;
  logBookId?: string;
  authorizedOperatorIds?: Set<string>;
  /** Token the page connected with; undefined when authentication is off. */
  tokenId?: string;
  /** Reception feedback interest in the connection's operator callsigns. */
  receptionFollow?: ReceptionFollow;
  /** A target selection from this page is being handled. */
  selectingTarget?: boolean;
}

interface LogBookIdResolver {
  resolveLogBookId(idOrCallsign: string): string | null;
}

interface LogBookAccessResolver extends LogBookIdResolver {
  getOperatorIdsForLogBook(logBookId: string): string[];
}

export interface LogbookConnectionParams {
  operatorId?: string;
  logBookId?: string;
  authorizedOperatorIds?: string[];
  tokenId?: string;
}

export type LogbookConnectionRejectionReason =
  | 'Logbook filter required'
  | 'No operator access permission'
  | 'No log book access permission';

export type LogbookConnectionAuthorization =
  | { allowed: true; params: LogbookConnectionParams }
  | { allowed: false; reason: LogbookConnectionRejectionReason };

export function resolveLogbookConnectionParams(
  resolver: LogBookIdResolver,
  params: { operatorId?: string; logBookId?: string },
): LogbookConnectionParams {
  const requestedId = params.logBookId;
  return {
    operatorId: params.operatorId,
    logBookId: requestedId
      ? (resolver.resolveLogBookId(requestedId) ?? requestedId)
      : undefined,
  };
}

export function authorizeLogbookConnectionParams(
  resolver: LogBookAccessResolver,
  params: LogbookConnectionParams,
  identity: { role: UserRole; operatorIds: string[] },
): LogbookConnectionAuthorization {
  if (identity.role === UserRole.ADMIN) {
    return { allowed: true, params };
  }

  if (!params.operatorId && !params.logBookId) {
    return { allowed: false, reason: 'Logbook filter required' };
  }

  const tokenOperatorIds = new Set(identity.operatorIds);
  if (params.operatorId && !tokenOperatorIds.has(params.operatorId)) {
    return { allowed: false, reason: 'No operator access permission' };
  }

  let authorizedLogbookOperatorIds: string[] | undefined;
  if (params.logBookId) {
    authorizedLogbookOperatorIds = resolver
      .getOperatorIdsForLogBook(params.logBookId)
      .filter(operatorId => tokenOperatorIds.has(operatorId));
    if (authorizedLogbookOperatorIds.length === 0) {
      return { allowed: false, reason: 'No log book access permission' };
    }
  }

  return {
    allowed: true,
    params: {
      ...params,
      authorizedOperatorIds: params.operatorId
        ? [params.operatorId]
        : Array.from(new Set(authorizedLogbookOperatorIds)),
    },
  };
}

/**
 * 日志本专用 WebSocket 服务器
 * - 仅发送轻量的日志本变更通知
 * - 连接可按 operatorId/logBookId 过滤
 */
export class LogbookWSServer {
  private connections = new Map<string, LogbookConnection>();
  private idCounter = 0;

  constructor(
    private engine: DigitalRadioEngine,
    private reception?: PSKReporterReceptionService,
    private liveDecodes?: LogbookLiveDecodeFeed,
    private targetCommands?: LogbookTargetCommands,
    private isTokenStillValid?: LogbookTokenCheck,
  ) {
    this.setupEngineListeners();
    this.setupReceptionListeners();
    this.setupLiveDecodeListeners();
  }

  /**
   * Operator whose logbook judges a connection's live decodes (new DXCC,
   * worked before). Operators sharing a logbook judge alike, so the first
   * visible one stands for all; an unfiltered admin view gets none.
   */
  private resolveLiveOperatorId(conn: LogbookConnection): string | undefined {
    if (conn.operatorId) return conn.operatorId;
    if (conn.authorizedOperatorIds && conn.authorizedOperatorIds.size > 0) {
      return conn.authorizedOperatorIds.values().next().value;
    }
    if (conn.logBookId) {
      return this.engine.operatorManager.getLogManager().getOperatorIdsForLogBook(conn.logBookId)[0];
    }
    return undefined;
  }

  private setupLiveDecodeListeners() {
    if (!this.liveDecodes) return;
    this.engine.on('slotPackUpdated' as any, (slotPack: SlotPack) => {
      this.broadcastLiveDecodes(slotPack).catch((error) => {
        logger.warn('Failed to send live decodes to logbook pages', error);
      });
    });
  }

  /**
   * Closes pages whose token was revoked or expired since they connected, so
   * they stop receiving the live stream (checked once per slot).
   */
  private closeRevokedConnections(): void {
    const check = this.isTokenStillValid;
    if (!check) return;
    for (const conn of Array.from(this.connections.values())) {
      if (!conn.tokenId || check(conn.tokenId)) continue;
      logger.info('Closing a logbook page whose token is no longer valid', { connectionId: conn.id });
      this.removeConnection(conn.id);
      try { conn.ws.close(TOKEN_REVOKED_CLOSE_CODE, 'Token expired'); } catch { /* already closed */ }
    }
  }

  private async broadcastLiveDecodes(slotPack: SlotPack): Promise<void> {
    const feed = this.liveDecodes;
    this.closeRevokedConnections();
    if (!feed || this.connections.size === 0) return;
    // Analyse once per operator, however many pages show it.
    const connectionsByOperator = new Map<string, LogbookConnection[]>();
    for (const conn of this.connections.values()) {
      const operatorId = this.resolveLiveOperatorId(conn);
      if (!operatorId) continue;
      const list = connectionsByOperator.get(operatorId) ?? [];
      list.push(conn);
      connectionsByOperator.set(operatorId, list);
    }
    await Promise.all(Array.from(connectionsByOperator, async ([operatorId, connections]) => {
      const update = await feed.buildUpdate(slotPack, operatorId);
      for (const conn of connections) {
        if (this.connections.has(conn.id)) {
          this.send(conn, WSMessageType.LOGBOOK_LIVE_DECODES, update);
        }
      }
    }));
  }

  private async sendRecentLiveDecodes(conn: LogbookConnection): Promise<void> {
    const feed = this.liveDecodes;
    const operatorId = this.resolveLiveOperatorId(conn);
    if (!feed || !operatorId) return;
    for (const slotPack of feed.getRecentSlotPacks()) {
      const update = await feed.buildUpdate(slotPack, operatorId);
      if (!this.connections.has(conn.id)) return;
      this.send(conn, WSMessageType.LOGBOOK_LIVE_DECODES, update);
    }
  }

  private setupReceptionListeners() {
    const reception = this.reception;
    if (!reception) return;
    reception.on('spots', (spots) => {
      for (const conn of this.connections.values()) {
        const callsigns = conn.receptionFollow?.callsigns;
        if (!callsigns || callsigns.length === 0) continue;
        const own = spots.filter(spot => callsigns.includes(spot.senderCallsign));
        if (own.length > 0) {
          this.sendReception(conn, 'append', own);
        }
      }
    });
    let lastState = reception.getState();
    reception.on('stateChanged', (state) => {
      // Turning the feature on or off changes what is stored; other changes
      // (connecting, reconnecting) only change the state, so pages keep their
      // spots instead of receiving a full snapshot on every network blip.
      const contentChanged = state === 'disabled' || lastState === 'disabled';
      lastState = state;
      for (const conn of this.connections.values()) {
        if (contentChanged) {
          this.sendReceptionSnapshot(conn);
        } else {
          this.sendReception(conn, 'append', []);
        }
      }
    });
  }

  /** Callsigns of the operators a connection shows; empty for an unfiltered admin view. */
  private resolveFollowedCallsigns(conn: LogbookConnection): string[] {
    const operatorManager = this.engine.operatorManager;
    let operatorIds: string[] = [];
    if (conn.operatorId) {
      operatorIds = [conn.operatorId];
    } else if (conn.authorizedOperatorIds) {
      operatorIds = Array.from(conn.authorizedOperatorIds);
    } else if (conn.logBookId) {
      operatorIds = operatorManager.getLogManager().getOperatorIdsForLogBook(conn.logBookId);
    }
    return operatorIds.flatMap((operatorId) => {
      const callsign = operatorManager.getOperator(operatorId)?.config.myCallsign;
      return callsign ? [callsign] : [];
    });
  }

  /** Follow changed operator callsigns; sends a fresh snapshot when the set changed. */
  private refreshReceptionFollows() {
    if (!this.reception) return;
    for (const conn of this.connections.values()) {
      const follow = conn.receptionFollow;
      if (!follow) continue;
      const before = follow.callsigns.join(',');
      follow.update(this.resolveFollowedCallsigns(conn));
      if (follow.callsigns.join(',') !== before) {
        this.sendReceptionSnapshot(conn);
      }
    }
  }

  private sendReceptionSnapshot(conn: LogbookConnection) {
    const follow = conn.receptionFollow;
    if (!this.reception || !follow) return;
    this.sendReception(conn, 'snapshot', this.reception.getSpots(follow.callsigns));
  }

  private sendReception(
    conn: LogbookConnection,
    kind: PSKReporterReceptionUpdate['kind'],
    spots: PSKReporterReceptionSpot[],
  ) {
    const reception = this.reception;
    const follow = conn.receptionFollow;
    if (!reception || !follow) return;
    const update: PSKReporterReceptionUpdate = {
      kind,
      state: reception.getState(),
      callsigns: [...follow.callsigns],
      windowMs: reception.windowMs,
      spots,
    };
    this.send(conn, WSMessageType.PSKREPORTER_RECEPTION_UPDATE, update);
  }

  private setupEngineListeners() {
    // 当新增QSO或日志本统计更新时，推送轻量通知
    this.engine.on('qsoRecordAdded' as any, (data: { operatorId: string; logBookId: string }) => {
      this.broadcastChangeNotice({ logBookId: data.logBookId, operatorId: data.operatorId });
    });
    this.engine.on('qsoRecordUpdated' as any, (data: { operatorId: string; logBookId: string }) => {
      this.broadcastChangeNotice({ logBookId: data.logBookId, operatorId: data.operatorId });
    });
    this.engine.on('logbookUpdated' as any, (data: { logBookId: string; operatorId?: string }) => {
      this.broadcastChangeNotice({ logBookId: data.logBookId, operatorId: data.operatorId });
    });
    this.engine.on('logbookHealthChanged' as any, (data: { logBookId: string }) => {
      const operatorIds = this.engine.operatorManager
        .getLogManager()
        .getOperatorIdsForLogBook(data.logBookId);
      if (operatorIds.length === 0) {
        this.broadcastChangeNotice({ logBookId: data.logBookId });
        return;
      }
      for (const operatorId of operatorIds) {
        this.broadcastChangeNotice({ logBookId: data.logBookId, operatorId });
      }
    });
    // 推送操作员状态更新（用于通联日志页面的实时虚线渲染）
    this.engine.on('operatorStatusUpdate' as any, (status: OperatorStatus) => {
      this.broadcastOperatorStatusUpdate(status);
      this.refreshReceptionFollows();
    });
    this.engine.on('operatorsList' as any, (data: { operators: OperatorStatus[] }) => {
      this.broadcastOperatorsList(data.operators);
      this.refreshReceptionFollows();
    });
  }

  addConnection(ws: any, params?: LogbookConnectionParams) {
    const id = `log_${++this.idCounter}`;
    const handler = new WSMessageHandler();

    ws.on('message', (raw: any) => {
      const text = typeof raw === 'string' ? raw : raw?.toString?.();
      const conn = this.connections.get(id);
      if (conn && typeof text === 'string') this.handleClientMessage(conn, text);
    });
    ws.on('close', () => {
      this.removeConnection(id);
    });
    ws.on('error', () => {
      this.removeConnection(id);
    });

    const conn: LogbookConnection = {
      id,
      ws,
      handler,
      operatorId: params?.operatorId,
      logBookId: params?.logBookId,
      authorizedOperatorIds: params?.authorizedOperatorIds
        ? new Set(params.authorizedOperatorIds)
        : undefined,
      tokenId: params?.tokenId,
    };
    this.connections.set(id, conn);
    // The page authenticated with its URL token, so its session is ready now;
    // the features tell it which commands this server accepts.
    if (this.targetCommands) {
      this.send(conn, WSMessageType.SERVER_HANDSHAKE_COMPLETE, { supportedFeatures: [LOGBOOK_SELECT_TARGET_FEATURE] });
    }
    // The list is otherwise only broadcast when operators are added or
    // removed, so a page opened on an idle station would know none of them.
    this.sendOperatorsList(conn, this.engine.operatorManager.getOperatorsStatus());
    if (this.reception) {
      conn.receptionFollow = this.reception.follow(this.resolveFollowedCallsigns(conn));
      this.sendReceptionSnapshot(conn);
    }
    this.sendRecentLiveDecodes(conn).catch((error) => {
      logger.warn('Failed to send recent live decodes to a logbook page', error);
    });
    return id;
  }

  private handleClientMessage(conn: LogbookConnection, text: string) {
    let message: { type?: unknown; data?: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === WSMessageType.LOGBOOK_SELECT_TARGET) {
      this.handleSelectTarget(conn, message.data).catch((error) => {
        logger.warn('Failed to handle a logbook target selection', error);
      });
    }
  }

  /**
   * Whether an operator is one of those the connection is shown (see
   * sendOperatorsList). Restricted tokens always carry their operator list;
   * an unrestricted connection (administrator, or authentication off) sees
   * every operator.
   */
  private isOperatorInScope(conn: LogbookConnection, operatorId: string): boolean {
    if (conn.operatorId) return conn.operatorId === operatorId;
    if (conn.authorizedOperatorIds) return conn.authorizedOperatorIds.has(operatorId);
    return true;
  }

  private async handleSelectTarget(conn: LogbookConnection, data: unknown): Promise<void> {
    const commands = this.targetCommands;
    if (!commands) return;
    const parsed = LogbookSelectTargetCommandSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn('Ignoring a malformed logbook target selection');
      return;
    }
    const { requestId, operatorId, selectedFrame } = parsed.data;
    const callsign = parsed.data.callsign.trim().toUpperCase();
    const reply = (result: Omit<LogbookSelectTargetResult, 'requestId' | 'operatorId' | 'callsign'>) => {
      this.send(conn, WSMessageType.LOGBOOK_SELECT_TARGET_RESULT, { requestId, operatorId, callsign, ...result });
    };
    if (!this.isOperatorInScope(conn, operatorId) || !commands.canManageOperator(conn.tokenId, operatorId)) {
      logger.warn('Rejected a logbook target selection without operator permission', { operatorId, callsign });
      reply({ status: 'rejected', reason: 'forbidden', userMessageKey: 'logbook:globe.callForbidden' });
      return;
    }
    // Each selection can key the transmitter: one at a time per page.
    if (conn.selectingTarget) {
      reply({ status: 'rejected', reason: 'busy', userMessageKey: 'logbook:globe.callBusy' });
      return;
    }
    conn.selectingTarget = true;
    logger.info('Logbook page selected a QSO target', { operatorId, callsign });
    try {
      const result = await commands.selectTarget(operatorId, callsign, selectedFrame);
      if (this.connections.has(conn.id)) reply(result);
    } catch (error) {
      logger.warn('Logbook target selection failed', error);
      if (this.connections.has(conn.id)) {
        reply({ status: 'rejected', reason: 'unavailable', userMessageKey: getCallRejectionMessageKey('unavailable') });
      }
    } finally {
      conn.selectingTarget = false;
    }
  }

  private removeConnection(id: string) {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    conn.receptionFollow?.release();
  }

  private send(conn: LogbookConnection, type: string, data?: any) {
    try {
      const msg = conn.handler.createAndSerializeMessage(type, data);
      conn.ws.send(msg);
    } catch (e) {
      // 出错则移除连接
      this.removeConnection(conn.id);
    }
  }

  private match(conn: LogbookConnection, payload: { logBookId?: string; operatorId?: string }) {
    // 若连接未声明过滤参数，允许全部
    if (!conn.operatorId && !conn.logBookId) return true;
    // 优先按 operatorId 匹配
    if (conn.operatorId && payload.operatorId) {
      return conn.operatorId === payload.operatorId;
    }
    // 其次按 logBookId 匹配
    if (conn.logBookId && payload.logBookId) {
      return conn.logBookId === payload.logBookId;
    }
    // 若无法判定（例如连接只有operatorId，但payload只有logBookId），则不发送
    return false;
  }

  broadcastChangeNotice(data: { logBookId: string; operatorId?: string }) {
    const payload = { logBookId: data.logBookId, operatorId: data.operatorId };
    for (const conn of this.connections.values()) {
      if (this.match(conn, payload)) {
        this.send(conn, WSMessageType.LOGBOOK_CHANGE_NOTICE, payload);
      }
    }
  }

  broadcastOperatorStatusUpdate(status: OperatorStatus) {
    for (const conn of this.connections.values()) {
      if (conn.authorizedOperatorIds && !conn.authorizedOperatorIds.has(status.id)) {
        continue;
      }
      if (conn.operatorId && conn.operatorId !== status.id) {
        continue;
      }
      this.send(conn, WSMessageType.OPERATOR_STATUS_UPDATE, status);
    }
  }

  broadcastOperatorsList(operators: OperatorStatus[]) {
    for (const conn of this.connections.values()) {
      this.sendOperatorsList(conn, operators);
    }
  }

  /** The operators a connection may see: its own operator, or those its token covers. */
  private sendOperatorsList(conn: LogbookConnection, operators: OperatorStatus[]) {
    const authorizedOperatorIds = conn.authorizedOperatorIds;
    const authorizedOperators = authorizedOperatorIds
      ? operators.filter(op => authorizedOperatorIds.has(op.id))
      : operators;
    const visible = conn.operatorId
      ? authorizedOperators.filter((op) => op.id === conn.operatorId)
      : authorizedOperators;
    this.send(conn, WSMessageType.OPERATORS_LIST, { operators: visible });
  }

  cleanup() {
    for (const c of this.connections.values()) {
      c.receptionFollow?.release();
      try { c.ws.close(); } catch {}
    }
    this.connections.clear();
  }
}
