import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
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
          recordQSOLog: () => {},
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
        queryQSOs: vi.fn(async () => []),
        addQSO: vi.fn(async () => undefined),
        updateQSO: vi.fn(async () => undefined),
      },
    };

    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      resolveLogBookId: vi.fn(() => logBook.id),
      getLogBook: vi.fn(() => logBook),
      getOrCreateLogBookByCallsign: vi.fn(async () => logBook),
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

  it('supports global plugins binding logbook access by callsign', async () => {
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
        queryQSOs: vi.fn(async () => []),
        addQSO: vi.fn(async () => undefined),
        updateQSO: vi.fn(async () => undefined),
      },
    };

    const getOrCreateLogBookByCallsign = vi.fn(async (callsign: string) => {
      expect(callsign).toBe('BG5DRB');
      return logBook;
    });

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

    expect(getOrCreateLogBookByCallsign).toHaveBeenCalledWith('BG5DRB');
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
});
