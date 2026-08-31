import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogManager, type LogBookInstance } from '../LogManager.js';
import { LegacyLogbookMaintenance } from '../persistence/LegacyLogbookMaintenance.js';
import { tx5drPaths } from '../../utils/app-paths.js';

describe('LogManager callsign logbook creation', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await LogManager.getInstance().close();
  });

  it('shares concurrent initialization and starts one maintenance loop', async () => {
    const manager = LogManager.getInstance();
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-log-manager-'));
    let releasePath: (() => void) | undefined;
    const pathGate = new Promise<void>((resolve) => {
      releasePath = resolve;
    });
    const getDataFile = vi.spyOn(tx5drPaths, 'getDataFile').mockImplementation(async (fileName) => {
      await pathGate;
      return path.join(directory, fileName);
    });
    const startMaintenance = vi
      .spyOn(LegacyLogbookMaintenance.prototype, 'start')
      .mockImplementation(() => undefined);

    try {
      const first = manager.initialize();
      const second = manager.initialize();
      await Promise.resolve();

      expect(getDataFile).toHaveBeenCalledTimes(1);
      expect(startMaintenance).not.toHaveBeenCalled();

      releasePath!();
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      await manager.initialize();

      expect(startMaintenance).toHaveBeenCalledTimes(1);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('clears a failed initialization so a later call can retry', async () => {
    const manager = LogManager.getInstance();
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-log-manager-retry-'));
    const getDataFile = vi.spyOn(tx5drPaths, 'getDataFile')
      .mockRejectedValueOnce(new Error('path lookup failed'))
      .mockImplementation(async fileName => path.join(directory, fileName));
    const startMaintenance = vi
      .spyOn(LegacyLogbookMaintenance.prototype, 'start')
      .mockImplementation(() => undefined);

    try {
      await expect(manager.initialize()).rejects.toThrow('path lookup failed');
      await expect(manager.initialize()).resolves.toBeUndefined();

      expect(getDataFile).toHaveBeenCalledTimes(2);
      expect(startMaintenance).toHaveBeenCalledTimes(1);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for top-level initialization before stopping maintenance', async () => {
    const manager = LogManager.getInstance();
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-log-manager-close-race-'));
    let releasePath: (() => void) | undefined;
    const pathGate = new Promise<void>((resolve) => {
      releasePath = resolve;
    });
    vi.spyOn(tx5drPaths, 'getDataFile').mockImplementation(async (fileName) => {
      await pathGate;
      return path.join(directory, fileName);
    });
    const startMaintenance = vi
      .spyOn(LegacyLogbookMaintenance.prototype, 'start')
      .mockImplementation(() => undefined);
    const stopMaintenance = vi
      .spyOn(LegacyLogbookMaintenance.prototype, 'stop')
      .mockResolvedValue(undefined);
    const state = manager as unknown as {
      isInitialized: boolean;
      legacyMaintenance?: LegacyLogbookMaintenance;
    };

    try {
      const initialization = manager.initialize();
      const closing = manager.close();
      let closeResolved = false;
      void closing.then(() => {
        closeResolved = true;
      });
      await Promise.resolve();

      expect(closeResolved).toBe(false);
      expect(startMaintenance).not.toHaveBeenCalled();
      expect(stopMaintenance).not.toHaveBeenCalled();

      releasePath!();
      await expect(Promise.all([initialization, closing])).resolves.toEqual([undefined, undefined]);

      expect(startMaintenance).toHaveBeenCalledTimes(1);
      expect(stopMaintenance).toHaveBeenCalledTimes(1);
      expect(state.legacyMaintenance).toBeUndefined();
      expect(state.isInitialized).toBe(false);

      await expect(manager.initialize()).resolves.toBeUndefined();
      expect(startMaintenance).toHaveBeenCalledTimes(2);
      expect(state.isInitialized).toBe(true);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reuses one in-flight creation for concurrent callsign lookups', async () => {
    const manager = LogManager.getInstance();
    let releaseCreation: (() => void) | null = null;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const logBook: LogBookInstance = {
      id: 'logbook-BG4IAJ',
      name: 'BG4IAJ QSO Log',
      filePath: '/tmp/BG4IAJ.adi',
      storageKind: 'custom',
      provider: {
        close: vi.fn().mockResolvedValue(undefined),
      } as any,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isActive: true,
      binding: { kind: 'primary', callsign: 'BG4IAJ' },
    };
    const createLogBook = vi.spyOn(manager, 'createLogBook').mockImplementation(async () => {
      await creationGate;
      return logBook;
    });

    const first = manager.getOrCreateLogBookByCallsign('bg4iaj');
    const second = manager.getOrCreateLogBookByCallsign('BG4IAJ');

    await Promise.resolve();
    expect(createLogBook).toHaveBeenCalledTimes(1);

    releaseCreation!();
    await expect(Promise.all([first, second])).resolves.toEqual([logBook, logBook]);
  });

  it('restores a missing callsign binding from an existing managed logbook', async () => {
    const manager = LogManager.getInstance();
    const logBook: LogBookInstance = {
      id: 'logbook-BG4IAJ',
      name: 'BG4IAJ QSO Log',
      filePath: '/tmp/BG4IAJ.adi',
      storageKind: 'managed',
      provider: { close: vi.fn().mockResolvedValue(undefined) } as any,
      createdAt: 1,
      lastUsed: 1,
      isActive: true,
      binding: { kind: 'primary', callsign: 'BG4IAJ' },
    };
    const books = (manager as unknown as { logBooks: Map<string, LogBookInstance> }).logBooks;
    books.set(logBook.id, logBook);
    const createLogBook = vi.spyOn(manager, 'createLogBook');

    await expect(manager.getOrCreateLogBookByCallsign('bg4iaj')).resolves.toBe(logBook);

    expect(manager.resolveLogBookId('BG4IAJ')).toBe(logBook.id);
    expect(createLogBook).not.toHaveBeenCalled();
  });

  it('unregisters one operator without removing a shared callsign binding', async () => {
    const manager = LogManager.getInstance();
    const logBook: LogBookInstance = {
      id: 'logbook-BG4IAJ',
      name: 'BG4IAJ QSO Log',
      filePath: '/tmp/BG4IAJ.adi',
      storageKind: 'managed',
      provider: { close: vi.fn().mockResolvedValue(undefined) } as any,
      createdAt: 1,
      lastUsed: 1,
      isActive: true,
      binding: { kind: 'primary', callsign: 'BG4IAJ' },
    };
    const books = (manager as unknown as { logBooks: Map<string, LogBookInstance> }).logBooks;
    const bindings = (manager as unknown as { callsignLogBookMap: Map<string, string> }).callsignLogBookMap;
    books.set(logBook.id, logBook);
    bindings.set('BG4IAJ', logBook.id);
    manager.registerOperatorCallsign('op1', 'BG4IAJ');
    manager.registerOperatorCallsign('op2', 'BG4IAJ');

    manager.unregisterOperatorCallsign('op1');

    expect(manager.getOperatorCallsign('op1')).toBeNull();
    expect(manager.getOperatorIdsForLogBook(logBook.id)).toEqual(['op2']);
    expect(manager.resolveLogBookId('BG4IAJ')).toBe(logBook.id);
  });

  it('reuses and hides a deterministic plugin session without changing callsign resolution', async () => {
    const manager = LogManager.getInstance();
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const books = (manager as unknown as { logBooks: Map<string, LogBookInstance> }).logBooks;
    const createLogBook = vi.spyOn(manager, 'createLogBook').mockImplementation(async (config) => {
      await creationGate;
      const logBook: LogBookInstance = {
        id: config.id,
        name: config.name,
        filePath: `/tmp/${config.id}.adi`,
        storageKind: 'managed',
        provider: { close: vi.fn().mockResolvedValue(undefined) } as any,
        createdAt: 1,
        lastUsed: 1,
        isActive: true,
        binding: config.binding!,
      };
      books.set(logBook.id, logBook);
      return logBook;
    });
    const descriptor = {
      pluginName: 'contest-plugin',
      stationCallsign: 'BG4IAJ/P',
      sessionKey: 'contest:2026',
      title: 'Contest 2026',
    };

    const first = manager.getOrCreatePluginSessionLogBook(descriptor);
    const second = manager.getOrCreatePluginSessionLogBook({ ...descriptor, stationCallsign: 'BG4IAJ' });
    await Promise.resolve();
    expect(createLogBook).toHaveBeenCalledOnce();
    releaseCreation();
    const [firstLogBook, secondLogBook] = await Promise.all([first, second]);

    expect(secondLogBook).toBe(firstLogBook);
    expect(firstLogBook.binding).toEqual({
      kind: 'plugin-session',
      pluginName: 'contest-plugin',
      stationCallsign: 'BG4IAJ',
      sessionKey: 'contest:2026',
      retention: 'durable',
    });
    expect(manager.getLogBooks()).toEqual([]);
    expect(manager.resolveLogBookId(firstLogBook.id)).toBeNull();
    expect(manager.getPluginSessionLogBook(firstLogBook.id, 'contest-plugin', 'BG4IAJ/P')).toBe(firstLogBook);
    expect(manager.getPluginSessionLogBook(firstLogBook.id, 'other-plugin', 'BG4IAJ')).toBeNull();
  });

  it('rejects unsafe plugin session descriptors before creating files', async () => {
    const manager = LogManager.getInstance();
    const createLogBook = vi.spyOn(manager, 'createLogBook');
    await expect(manager.getOrCreatePluginSessionLogBook({
      pluginName: 'contest-plugin',
      stationCallsign: 'BG4IAJ',
      sessionKey: '../outside',
      title: 'Contest',
    })).rejects.toThrow('Invalid plugin logbook session key');
    expect(createLogBook).not.toHaveBeenCalled();
  });

  it('reopens the same plugin session ADIF with its committed records after restart', async () => {
    const manager = LogManager.getInstance();
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-plugin-session-restart-'));
    vi.spyOn(tx5drPaths, 'getDataFile').mockImplementation(async fileName => path.join(directory, fileName));
    vi.spyOn(LegacyLogbookMaintenance.prototype, 'start').mockImplementation(() => undefined);
    vi.spyOn(LegacyLogbookMaintenance.prototype, 'stop').mockResolvedValue(undefined);
    const descriptor = {
      pluginName: 'contest-plugin',
      stationCallsign: 'BG4IAJ',
      sessionKey: 'contest:2026',
      title: 'Contest 2026',
    };
    const qso = {
      id: 'session-qso-1',
      callsign: 'JA1AAA',
      frequency: 14_091_000,
      mode: 'FT8',
      startTime: Date.UTC(2026, 7, 29, 12),
      messageHistory: [],
      myCallsign: 'BG4IAJ',
      contestId: 'TEST-CONTEST',
    };

    try {
      await manager.initialize();
      const first = await manager.getOrCreatePluginSessionLogBook(descriptor);
      await vi.waitFor(() => expect(first.provider.getHealth().writable).toBe(true));
      await first.provider.addQSO(qso, 'operator-1');
      const firstId = first.id;
      await manager.close();

      await manager.initialize();
      const reopened = await manager.getOrCreatePluginSessionLogBook(descriptor);
      await vi.waitFor(() => expect(reopened.provider.getHealth().readable).toBe(true));
      expect(reopened.id).toBe(firstId);
      await expect(reopened.provider.queryQSOs({})).resolves.toEqual([
        expect.objectContaining({ id: 'session-qso-1', callsign: 'JA1AAA' }),
      ]);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drains every registered logbook when one close fails', async () => {
    const manager = LogManager.getInstance();
    const failedClose = vi.fn().mockRejectedValue(new Error('first drain failed'));
    const successfulClose = vi.fn().mockResolvedValue(undefined);
    const books = (manager as unknown as { logBooks: Map<string, LogBookInstance> }).logBooks;
    books.set('first', {
      id: 'first',
      name: 'First',
      filePath: '/tmp/first.adi',
      storageKind: 'custom',
      provider: { close: failedClose } as any,
      createdAt: 1,
      lastUsed: 1,
      isActive: true,
      binding: { kind: 'custom' },
    });
    books.set('second', {
      id: 'second',
      name: 'Second',
      filePath: '/tmp/second.adi',
      storageKind: 'custom',
      provider: { close: successfulClose } as any,
      createdAt: 1,
      lastUsed: 1,
      isActive: true,
      binding: { kind: 'custom' },
    });

    await expect(manager.close()).resolves.toBeUndefined();
    expect(failedClose).toHaveBeenCalledOnce();
    expect(successfulClose).toHaveBeenCalledOnce();
  });

  it('starts draining healthy logbooks without waiting for another initialization', async () => {
    const manager = LogManager.getInstance();
    let finishSlowInitialization: (() => void) | undefined;
    const slowInitialization = new Promise<void>((resolve) => {
      finishSlowInitialization = resolve;
    });
    const slowClose = vi.fn().mockResolvedValue(undefined);
    const healthyClose = vi.fn().mockResolvedValue(undefined);
    const books = (manager as unknown as { logBooks: Map<string, LogBookInstance> }).logBooks;
    const initializations = (manager as unknown as {
      initializationById: Map<string, Promise<unknown>>;
    }).initializationById;
    books.set('slow', {
      id: 'slow',
      name: 'Slow',
      filePath: '/tmp/slow.adi',
      storageKind: 'custom',
      provider: { close: slowClose } as any,
      createdAt: 1,
      lastUsed: 1,
      isActive: true,
      binding: { kind: 'custom' },
    });
    books.set('healthy', {
      id: 'healthy',
      name: 'Healthy',
      filePath: '/tmp/healthy.adi',
      storageKind: 'custom',
      provider: { close: healthyClose } as any,
      createdAt: 1,
      lastUsed: 1,
      isActive: true,
      binding: { kind: 'custom' },
    });
    initializations.set('slow', slowInitialization);

    const closing = manager.close();
    await vi.waitFor(() => expect(healthyClose).toHaveBeenCalledOnce());
    expect(slowClose).not.toHaveBeenCalled();

    finishSlowInitialization!();
    await closing;
    expect(slowClose).toHaveBeenCalledOnce();
  });

  it('waits for background initialization before deleting a logbook', async () => {
    const manager = LogManager.getInstance();
    let finishInitialization: (() => void) | undefined;
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const books = (manager as unknown as { logBooks: Map<string, LogBookInstance> }).logBooks;
    const initializations = (manager as unknown as {
      initializationById: Map<string, Promise<unknown>>;
    }).initializationById;
    books.set('loading', {
      id: 'loading',
      name: 'Loading',
      filePath: '/tmp/loading.adi',
      storageKind: 'custom',
      provider: { close } as any,
      createdAt: 1,
      lastUsed: 1,
      isActive: true,
      binding: { kind: 'custom' },
    });
    initializations.set('loading', initialization);

    const deletion = manager.deleteLogBook('loading');
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    finishInitialization!();
    await deletion;
    expect(close).toHaveBeenCalledOnce();
    expect(books.has('loading')).toBe(false);
  });
});
