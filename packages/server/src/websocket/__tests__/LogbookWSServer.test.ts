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
      getOperatorsStatus: () => [],
    } as typeof engine.operatorManager;
    const send = vi.fn();
    const socket = {
      on: vi.fn(),
      send,
      close: vi.fn(),
    };
    const server = new LogbookWSServer(engine as any);
    server.addConnection(socket, { operatorId: 'operator-1' });
    send.mockClear();

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
      getOperatorsStatus: () => [createOperatorStatus('operator-1'), createOperatorStatus('operator-2')],
    } as typeof engine.operatorManager;
    return engine;
  }

  // Regression: the list was only broadcast when operators were added or
  // removed, so a page opened on an idle station had no operator to call with.
  it('sends each page the operators it may see as soon as it connects', () => {
    const server = new LogbookWSServer(createEngine() as any);
    const scopedSocket = createSocket();
    const adminSocket = createSocket();
    const concreteSocket = createSocket();
    server.addConnection(scopedSocket, { logBookId: 'logbook-shared', authorizedOperatorIds: ['operator-1'] });
    server.addConnection(adminSocket);
    server.addConnection(concreteSocket, { operatorId: 'operator-2', authorizedOperatorIds: ['operator-1', 'operator-2'] });

    const operatorIds = (socket: ReturnType<typeof createSocket>) => parseSentMessages(socket)
      .find(message => message.type === WSMessageType.OPERATORS_LIST)
      ?.data.operators.map((operator: OperatorStatus) => operator.id);
    expect(operatorIds(scopedSocket)).toEqual(['operator-1']);
    expect(operatorIds(adminSocket)).toEqual(['operator-1', 'operator-2']);
    expect(operatorIds(concreteSocket)).toEqual(['operator-2']);
  });

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
    scopedSocket.send.mockClear();
    adminSocket.send.mockClear();

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
    socket.send.mockClear();

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

describe('LogbookWSServer reception feedback', () => {
  function createReceptionEngine(callsigns: Record<string, string>) {
    const engine = new EventEmitter() as EventEmitter & { operatorManager: unknown };
    engine.operatorManager = {
      getLogManager: () => ({ getOperatorIdsForLogBook: () => [] }),
      getOperator: (id: string) => (callsigns[id] ? { config: { myCallsign: callsigns[id] } } : undefined),
      getOperatorsStatus: () => [],
    };
    return engine;
  }

  function createReception() {
    const reception = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const follows: Array<{ callsigns: string[]; released: boolean }> = [];
    Object.assign(reception, {
      windowMs: 1_800_000,
      getState: () => 'live',
      getSpots: vi.fn(() => []),
      follow: vi.fn((initial: string[]) => {
        const entry = {
          callsigns: [...initial],
          released: false,
          update(next: string[]) { entry.callsigns = [...next]; },
          release() { entry.released = true; },
        };
        follows.push(entry);
        return entry;
      }),
    });
    return { reception, follows };
  }

  function receptionMessages(socket: ReturnType<typeof createSocket>) {
    return parseSentMessages(socket).filter(message => message.type === WSMessageType.PSKREPORTER_RECEPTION_UPDATE);
  }

  it('follows each page operator callsign and routes spots only to that page', () => {
    const engine = createReceptionEngine({ 'operator-1': 'BG5DRB', 'operator-2': 'BA1ZZZ' });
    const { reception, follows } = createReception();
    const server = new LogbookWSServer(engine as any, reception as any);
    const first = createSocket();
    const second = createSocket();
    server.addConnection(first, { operatorId: 'operator-1' });
    server.addConnection(second, { operatorId: 'operator-2' });

    expect(follows.map(follow => follow.callsigns)).toEqual([['BG5DRB'], ['BA1ZZZ']]);
    expect(receptionMessages(first)).toEqual([expect.objectContaining({
      data: { kind: 'snapshot', state: 'live', callsigns: ['BG5DRB'], windowMs: 1_800_000, spots: [] },
    })]);

    reception.emit('spots', [
      { id: 'a', senderCallsign: 'BG5DRB', receiverCallsign: 'VK2JEH' },
      { id: 'b', senderCallsign: 'BA1ZZZ', receiverCallsign: 'OH2JJA' },
    ]);
    expect(receptionMessages(first).at(-1)?.data).toMatchObject({
      kind: 'append',
      spots: [{ id: 'a' }],
    });
    expect(receptionMessages(second).at(-1)?.data.spots).toEqual([
      expect.objectContaining({ id: 'b' }),
    ]);

    // A connection blip only updates the state; turning the feature off resends the content.
    (reception as Record<string, unknown>).getState = () => 'reconnecting';
    reception.emit('stateChanged', 'reconnecting');
    expect(receptionMessages(first).at(-1)?.data).toMatchObject({ kind: 'append', state: 'reconnecting', spots: [] });
    (reception as Record<string, unknown>).getState = () => 'disabled';
    reception.emit('stateChanged', 'disabled');
    expect(receptionMessages(first).at(-1)?.data).toMatchObject({ kind: 'snapshot', state: 'disabled' });

    const closeHandler = first.on.mock.calls.find(([event]) => event === 'close')?.[1] as () => void;
    closeHandler();
    expect(follows[0]?.released).toBe(true);
    expect(follows[1]?.released).toBe(false);
  });
});
