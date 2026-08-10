import EventEmitter from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';

import { WSMessageType } from '@tx5dr/contracts';

import { LogbookWSServer, resolveLogbookConnectionParams } from '../LogbookWSServer.js';

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
