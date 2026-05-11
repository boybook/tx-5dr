import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogManager, type LogBookInstance } from '../LogManager.js';

describe('LogManager callsign logbook creation', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await LogManager.getInstance().close();
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
      provider: {
        close: vi.fn().mockResolvedValue(undefined),
      } as any,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isActive: true,
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
});
