import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents, QSORecord } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import type { LoadedPlugin, PluginManagerDeps } from '../types.js';
import { PluginContextFactory } from '../PluginContextFactory.js';
import { LogManager } from '../../log/LogManager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createDeps(eventEmitter: EventEmitter<DigitalRadioEngineEvents>): PluginManagerDeps {
  return {
    eventEmitter,
    getOperators: () => [],
    getCurrentMode: () => MODES.FT8,
    getOperatorById: (id) => id === 'operator-1'
      ? {
          config: {
            id,
            myCallsign: 'BG4IAJ',
            myGrid: 'OM96',
            frequency: 7_074_000,
            mode: MODES.FT8,
          },
          getTransmitCycles: () => [0],
          isTargetBeingWorkedByOthers: () => false,
          recordQSOLog: async (record: QSORecord) => record,
          notifySlotsUpdated: () => {},
          notifyStateChanged: () => {},
          start: () => {},
          stop: () => {},
          setTransmitCycles: () => {},
          isTransmitting: false,
        } as any
      : undefined,
    getOperatorAutomationSnapshot: () => null,
    requestOperatorCall: () => {},
    getRadioFrequency: async () => 7_074_000,
    setRadioFrequency: () => {},
    getRadioBand: () => '40m',
    getRadioConnected: () => true,
    getLatestSlotPack: () => null,
    interruptOperatorTransmission: async () => {},
    hasWorkedCallsign: async () => false,
    resetOperatorRuntime: () => {},
    dataDir: '/tmp',
  };
}

function createPlugin(): LoadedPlugin {
  return {
    definition: {
      name: 'test-plugin',
      version: '1.0.0',
      type: 'utility',
    },
    isBuiltIn: false,
  };
}

describe('PluginContextFactory logbook access', () => {
  it('returns the provider committed record for operator-bound add and update', async () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const committedAdd: QSORecord = {
      id: 'provider-add-id',
      callsign: 'BG2CM',
      frequency: 14_074_000,
      mode: 'SSB',
      submode: 'USB',
      startTime: 1,
      messageHistory: ['committed add'],
    };
    const committedUpdate: QSORecord = {
      ...committedAdd,
      mode: 'FM',
      submode: undefined,
      messageHistory: ['committed update'],
    };
    const addQSO = vi.fn(async () => structuredClone(committedAdd));
    const updateQSO = vi.fn(async () => structuredClone(committedUpdate));
    const logBook = {
      id: 'logbook-BG4IAJ',
      provider: { addQSO, updateQSO },
    };
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      resolveLogBookId: vi.fn(() => logBook.id),
      getLogBook: vi.fn(() => logBook),
      getOperatorIdsForLogBook: vi.fn(() => ['operator-1']),
    } as any);

    const factory = new PluginContextFactory(createDeps(eventEmitter));
    const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ctx-commit-'));
    tempDirs.push(storageDir);
    const ctx = await factory.create(
      createPlugin(),
      'operator-1',
      'operator',
      storageDir,
      () => {},
      () => ({}),
    );
    const input: QSORecord = {
      id: 'caller-id',
      callsign: 'bg2cm',
      frequency: 14_074_000,
      mode: 'USB',
      startTime: 1,
      messageHistory: ['caller add'],
    };
    const updates: Partial<QSORecord> = {
      mode: 'FM',
      messageHistory: ['caller update'],
    };

    await expect(ctx.logbook.addQSO(input)).resolves.toEqual(committedAdd);
    await expect(ctx.logbook.updateQSO(input.id, updates)).resolves.toEqual(committedUpdate);
    expect(addQSO).toHaveBeenCalledWith(input, 'operator-1');
    expect(updateQSO).toHaveBeenCalledWith(input.id, updates);
  });

  it('emits full logbookUpdated payload for operator-bound notifyUpdated', async () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const events: Array<{ logBookId: string; statistics: unknown; operatorId?: string }> = [];
    eventEmitter.on('logbookUpdated' as any, (payload) => {
      events.push(payload as { logBookId: string; statistics: unknown; operatorId?: string });
    });

    const logBook = {
      id: 'logbook-BG4IAJ',
      provider: {
        getStatistics: vi.fn(async () => ({
          totalQSOs: 12,
          uniqueCallsigns: 9,
          firstQSOTime: Date.UTC(2024, 0, 2, 3, 4, 5),
          lastQSOTime: Date.UTC(2024, 2, 4, 5, 6, 7),
          dxcc: {
            worked: { current: 8, total: 9, deleted: 1 },
            confirmed: { current: 7, total: 8, deleted: 1 },
            reviewCount: 2,
            byBand: [],
            byMode: [],
          },
        })),
      },
    };

    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      resolveLogBookId: vi.fn(() => logBook.id),
      getLogBook: vi.fn(() => logBook),
      getOperatorIdsForLogBook: vi.fn(() => []),
    } as any);

    const factory = new PluginContextFactory(createDeps(eventEmitter));
    const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ctx-'));
    tempDirs.push(storageDir);

    const ctx = await factory.create(
      createPlugin(),
      'operator-1',
      'operator',
      storageDir,
      () => {},
      () => ({}),
    );

    await ctx.logbook.notifyUpdated();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      logBookId: 'logbook-BG4IAJ',
      statistics: {
        totalQSOs: 12,
        totalOperators: 0,
        uniqueCallsigns: 9,
        firstQSO: '2024-01-02T03:04:05.000Z',
        lastQSO: '2024-03-04T05:06:07.000Z',
        dxcc: {
          worked: { current: 8, total: 9, deleted: 1 },
          confirmed: { current: 7, total: 8, deleted: 1 },
          reviewCount: 2,
          byBand: [],
          byMode: [],
        },
      },
      operatorId: 'operator-1',
    });
  });

  it('supports global plugins binding an existing logbook by callsign without creating one', async () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const events: Array<{ logBookId: string; statistics: unknown; operatorId?: string }> = [];
    eventEmitter.on('logbookUpdated' as any, (payload) => {
      events.push(payload as { logBookId: string; statistics: unknown; operatorId?: string });
    });

    const logBook = {
      id: 'logbook-BG5DRB',
      provider: {
        getStatistics: vi.fn(async () => ({
          totalQSOs: 3,
          uniqueCallsigns: 3,
          firstQSOTime: undefined,
          lastQSOTime: undefined,
          dxcc: undefined,
        })),
      },
    };

    const getOrCreateLogBookByCallsign = vi.fn();

    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      resolveLogBookId: vi.fn(() => logBook.id),
      getLogBook: vi.fn(() => logBook),
      getOrCreateLogBookByCallsign,
      getOperatorIdsForLogBook: vi.fn(() => ['operator-2']),
    } as any);

    const factory = new PluginContextFactory(createDeps(eventEmitter));
    const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ctx-global-'));
    tempDirs.push(storageDir);

    const ctx = await factory.create(
      createPlugin(),
      undefined,
      'global',
      storageDir,
      () => {},
      () => ({}),
    );

    await ctx.logbook.forCallsign('bg5drb').notifyUpdated();

    expect(getOrCreateLogBookByCallsign).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      logBookId: 'logbook-BG5DRB',
      statistics: {
        totalQSOs: 3,
        totalOperators: 1,
        uniqueCallsigns: 3,
        firstQSO: undefined,
        lastQSO: undefined,
        dxcc: undefined,
      },
      operatorId: 'operator-2',
    });
  });

  it('never creates a missing logbook through global callsign access', async () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const getOrCreateLogBookByCallsign = vi.fn();
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      resolveLogBookId: vi.fn(() => null),
      getLogBook: vi.fn(() => null),
      getOrCreateLogBookByCallsign,
      getOperatorIdsForLogBook: vi.fn(() => []),
    } as any);

    const factory = new PluginContextFactory(createDeps(eventEmitter));
    const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ctx-missing-'));
    tempDirs.push(storageDir);
    const ctx = await factory.create(
      createPlugin(),
      undefined,
      'global',
      storageDir,
      () => {},
      () => ({}),
    );
    const logbook = ctx.logbook.forCallsign('bg5drb');
    const record: QSORecord = {
      id: 'qso-1',
      callsign: 'N0CALL',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: 0,
      messageHistory: [],
    };

    await expect(logbook.getLogBookId()).resolves.toBeNull();
    await expect(logbook.queryQSOs({})).resolves.toEqual([]);
    await expect(logbook.countQSOs()).resolves.toBe(0);
    await expect(logbook.getStatistics()).resolves.toBeNull();
    await expect(logbook.addQSO(record)).rejects.toMatchObject({ code: 'LOGBOOK_UNAVAILABLE' });
    await expect(logbook.updateQSO(record.id, { notes: 'updated' }))
      .rejects.toMatchObject({ code: 'LOGBOOK_UNAVAILABLE' });
    await expect(logbook.notifyUpdated()).resolves.toBeUndefined();
    expect(getOrCreateLogBookByCallsign).not.toHaveBeenCalled();
  });
});
