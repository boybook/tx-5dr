/* eslint-disable @typescript-eslint/no-explicit-any */
// LogbookWSServer - WebSocket消息处理需要使用any

import { WSMessageHandler } from '@tx5dr/core';
import { UserRole, WSMessageType } from '@tx5dr/contracts';
import type { OperatorStatus, PSKReporterReceptionSpot, PSKReporterReceptionUpdate } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type {
  PSKReporterReceptionService,
  ReceptionFollow,
} from '../services/pskreporterReception/PSKReporterReceptionService.js';

interface LogbookConnection {
  id: string;
  ws: any;
  handler: WSMessageHandler;
  operatorId?: string;
  logBookId?: string;
  authorizedOperatorIds?: Set<string>;
  /** Reception feedback interest in the connection's operator callsigns. */
  receptionFollow?: ReceptionFollow;
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
  ) {
    this.setupEngineListeners();
    this.setupReceptionListeners();
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

    // 透传消息（目前无需接收客户端消息，仅保持接口一致）
    ws.on('message', (raw: any) => {
      try { handler.handleRawMessage(typeof raw === 'string' ? raw : raw?.toString?.()); } catch {}
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
    };
    this.connections.set(id, conn);
    if (this.reception) {
      conn.receptionFollow = this.reception.follow(this.resolveFollowedCallsigns(conn));
      this.sendReceptionSnapshot(conn);
    }
    return id;
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
      const authorizedOperatorIds = conn.authorizedOperatorIds;
      const authorizedOperators = authorizedOperatorIds
        ? operators.filter(op => authorizedOperatorIds.has(op.id))
        : operators;
      if (conn.operatorId) {
        const filtered = authorizedOperators.filter((op) => op.id === conn.operatorId);
        this.send(conn, WSMessageType.OPERATORS_LIST, { operators: filtered });
      } else {
        this.send(conn, WSMessageType.OPERATORS_LIST, { operators: authorizedOperators });
      }
    }
  }

  cleanup() {
    for (const c of this.connections.values()) {
      c.receptionFollow?.release();
      try { c.ws.close(); } catch {}
    }
    this.connections.clear();
  }
}
