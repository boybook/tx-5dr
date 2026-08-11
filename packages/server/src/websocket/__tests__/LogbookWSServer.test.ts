import EventEmitter from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';

import { UserRole, WSMessageType, type OperatorStatus } from '@tx5dr/contracts';

import {
  LogbookWSServer,
  authorizeLogbookConnectionParams,
  resolveLogbookConnectionParams,
} from '../LogbookWSServer.js';

function createAccessResolver() {
  return {
    resolveLogBookId: (value: string) => value,
    getOperatorIdsForLogBook: (logBookId: string) => {
      if (logBookId === 'logbook-shared') return ['operator-1', 'operator-2', 'operator-3'];
      if (logBookId === 'logbook-other') return ['operator-4'];
      return [];
    },
  };
}

function createOperatorStatus(id: string): OperatorStatus {
  return {
    id,
    isActive: true,
    isTransmitting: false,
    context: {
      myCall: id.toUpperCase(),
      myGrid: 'PM00',
      targetCall: '',
    },
    strategy: {
      name: 'standard-qso',
      state: 'TX6',
      availableSlots: [],
    },
  };
}

function createSocket() {
  return {
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  };
}

function parseSentMessages(socket: ReturnType<typeof createSocket>) {
  return socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
}

describe('resolveLogbookConnectionParams', () => {
  it('canonicalizes a callsign before authorization and connection filtering', () => {
    const resolver = {
      resolveLogBookId: vi.fn((value: string) => value === 'n0call' ? 'logbook-N0CALL' : null),
    };

    expect(resolveLogbookConnectionParams(resolver, {
      operatorId: 'operator-1',
      logBookId: 'n0call',
    })).toEqual({
      operatorId: 'operator-1',
      logBookId: 'logbook-N0CALL',
    });
    expect(resolver.resolveLogBookId).toHaveBeenCalledWith('n0call');
  });

  it('preserves an unknown id so authorization fails closed', () => {
    expect(resolveLogbookConnectionParams({ resolveLogBookId: () => null }, {
      logBookId: 'unknown',
    })).toEqual({
      operatorId: undefined,
      logBookId: 'unknown',
    });
  });
});

describe('authorizeLogbookConnectionParams', () => {
  const resolver = createAccessResolver();

  it('allows an admin connection without filters', () => {
    expect(authorizeLogbookConnectionParams(resolver, {}, {
      role: UserRole.ADMIN,
      operatorIds: [],
    })).toEqual({ allowed: true, params: {} });
  });

  it('rejects a non-admin connection without filters', () => {
    expect(authorizeLogbookConnectionParams(resolver, {}, {
      role: UserRole.OPERATOR,
      operatorIds: ['operator-1'],
    })).toEqual({ allowed: false, reason: 'Logbook filter required' });
  });

  it('allows an owned operator and limits the connection to that operator', () => {
    expect(authorizeLogbookConnectionParams(resolver, { operatorId: 'operator-1' }, {
      role: UserRole.OPERATOR,
      operatorIds: ['operator-1', 'operator-2'],
    })).toEqual({
      allowed: true,
      params: {
        operatorId: 'operator-1',
        authorizedOperatorIds: ['operator-1'],
      },
    });
  });

  it('keeps an explicit operator scope when an authorized logbook is also requested', () => {
    expect(authorizeLogbookConnectionParams(resolver, {
      operatorId: 'operator-1',
      logBookId: 'logbook-shared',
    }, {
      role: UserRole.OPERATOR,
      operatorIds: ['operator-1', 'operator-2'],
    })).toEqual({
      allowed: true,
      params: {
        operatorId: 'operator-1',
        logBookId: 'logbook-shared',
        authorizedOperatorIds: ['operator-1'],
      },
    });
  });

  it('rejects an operator outside the token bindings', () => {
    expect(authorizeLogbookConnectionParams(resolver, { operatorId: 'operator-2' }, {
      role: UserRole.OPERATOR,
      operatorIds: ['operator-1'],
    })).toEqual({ allowed: false, reason: 'No operator access permission' });
  });

  it('limits a logbook-only connection to the token and logbook operator intersection', () => {
    expect(authorizeLogbookConnectionParams(resolver, { logBookId: 'logbook-shared' }, {
      role: UserRole.OPERATOR,
      operatorIds: ['operator-1', 'operator-3', 'operator-4'],
    })).toEqual({
      allowed: true,
      params: {
        logBookId: 'logbook-shared',
        authorizedOperatorIds: ['operator-1', 'operator-3'],
      },
    });
  });

  it.each(['logbook-other', 'logbook-unknown'])(
    'rejects an unauthorized or unknown logbook: %s',
    (logBookId) => {
      expect(authorizeLogbookConnectionParams(resolver, { logBookId }, {
        role: UserRole.OPERATOR,
        operatorIds: ['operator-1'],
      })).toEqual({ allowed: false, reason: 'No log book access permission' });
    },
  );
});

describe('LogbookWSServer health notices', () => {
  it('projects a logbook-only health event onto its associated operators', () => {
    const engine = new EventEmitter() as EventEmitter & {
      operatorManager: {
        getLogManager: () => {
          getOperatorIdsForLogBook: (logBookId: string) => string[];
        };
      };
    };
    engine.operatorManager = {
      getLogManager: () => ({
        getOperatorIdsForLogBook: (logBookId: string) => logBookId === 'logbook-N0CALL'
          ? ['operator-1']
          : [],
      }),
    };
    const send = vi.fn();
    const socket = {
      on: vi.fn(),
      send,
      close: vi.fn(),
    };
    const server = new LogbookWSServer(engine as any);
    server.addConnection(socket, { operatorId: 'operator-1' });

    engine.emit('logbookHealthChanged', { logBookId: 'logbook-N0CALL' });

    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({
      type: WSMessageType.LOGBOOK_CHANGE_NOTICE,
      data: {
        logBookId: 'logbook-N0CALL',
        operatorId: 'operator-1',
      },
    });
  });
});

describe('LogbookWSServer operator visibility', () => {
  function createEngine() {
    const engine = new EventEmitter() as EventEmitter & {
      operatorManager: {
        getLogManager: () => {
          getOperatorIdsForLogBook: (logBookId: string) => string[];
        };
      };
    };
    engine.operatorManager = {
      getLogManager: () => ({
        getOperatorIdsForLogBook: () => [],
      }),
    };
    return engine;
  }

  it('limits a logbook-only connection while preserving unrestricted admin delivery', () => {
    const engine = createEngine();
    const scopedSocket = createSocket();
    const adminSocket = createSocket();
    const server = new LogbookWSServer(engine as any);
    server.addConnection(scopedSocket, {
      logBookId: 'logbook-shared',
      authorizedOperatorIds: ['operator-1'],
    });
    server.addConnection(adminSocket);

    const operator1 = createOperatorStatus('operator-1');
    const operator2 = createOperatorStatus('operator-2');
    engine.emit('operatorStatusUpdate', operator2);
    engine.emit('operatorsList', { operators: [operator1, operator2] });

    const scopedMessages = parseSentMessages(scopedSocket);
    expect(scopedMessages).toHaveLength(1);
    expect(scopedMessages[0]).toMatchObject({
      type: WSMessageType.OPERATORS_LIST,
      data: { operators: [{ id: 'operator-1' }] },
    });

    const adminMessages = parseSentMessages(adminSocket);
    expect(adminMessages).toHaveLength(2);
    expect(adminMessages[0]).toMatchObject({
      type: WSMessageType.OPERATOR_STATUS_UPDATE,
      data: { id: 'operator-2' },
    });
    expect(adminMessages[1].data.operators.map((operator: OperatorStatus) => operator.id))
      .toEqual(['operator-1', 'operator-2']);
  });

  it('keeps a concrete operator filter narrower than its authorization snapshot', () => {
    const engine = createEngine();
    const socket = createSocket();
    const server = new LogbookWSServer(engine as any);
    server.addConnection(socket, {
      operatorId: 'operator-1',
      authorizedOperatorIds: ['operator-1', 'operator-2'],
    });

    const operator1 = createOperatorStatus('operator-1');
    const operator2 = createOperatorStatus('operator-2');
    engine.emit('operatorStatusUpdate', operator1);
    engine.emit('operatorStatusUpdate', operator2);
    engine.emit('operatorsList', { operators: [operator1, operator2] });

    const messages = parseSentMessages(socket);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: WSMessageType.OPERATOR_STATUS_UPDATE,
      data: { id: 'operator-1' },
    });
    expect(messages[1]).toMatchObject({
      type: WSMessageType.OPERATORS_LIST,
      data: { operators: [{ id: 'operator-1' }] },
    });
  });
});
