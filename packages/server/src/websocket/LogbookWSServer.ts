import { WSMessageHandler } from '@tx5dr/core';
import { WSMessageType } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';

interface LogbookConnection {
  id: string;
  ws: any;
  handler: WSMessageHandler;
  operatorId?: string;
  logBookId?: string;
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
    this.engine.on('logbookUpdated' as any, (data: { logBookId: string }) => {
      this.broadcastChangeNotice({ logBookId: data.logBookId });
    });
  }

  addConnection(ws: any, params?: { operatorId?: string; logBookId?: string }) {
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

  cleanup() {
    for (const c of this.connections.values()) {
      try { c.ws.close(); } catch {}
    }
    this.connections.clear();
  }
}
