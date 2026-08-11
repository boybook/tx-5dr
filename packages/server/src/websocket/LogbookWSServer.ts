/* eslint-disable @typescript-eslint/no-explicit-any */
// LogbookWSServer - WebSocket消息处理需要使用any

import { WSMessageHandler } from '@tx5dr/core';
import { UserRole, WSMessageType } from '@tx5dr/contracts';
import type { OperatorStatus } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';

interface LogbookConnection {
  id: string;
  ws: any;
  handler: WSMessageHandler;
  operatorId?: string;
  logBookId?: string;
  authorizedOperatorIds?: Set<string>;
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

  constructor(private engine: DigitalRadioEngine) {
    this.setupEngineListeners();
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
    });
    this.engine.on('operatorsList' as any, (data: { operators: OperatorStatus[] }) => {
      this.broadcastOperatorsList(data.operators);
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
      this.connections.delete(id);
    });
    ws.on('error', () => {
      this.connections.delete(id);
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
    return id;
  }

  private send(conn: LogbookConnection, type: string, data?: any) {
    try {
      const msg = conn.handler.createAndSerializeMessage(type, data);
      conn.ws.send(msg);
    } catch (e) {
      // 出错则移除连接
      this.connections.delete(conn.id);
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
      try { c.ws.close(); } catch {}
    }
    this.connections.clear();
  }
}
