import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CWKeyerManager } from '../CWKeyerManager.js';
import type { CWKeyerBackend } from '../CWKeyerBackend.js';

const tempDirs: string[] = [];

async function createManager() {
  const root = await mkdtemp(join(tmpdir(), 'tx5dr-cw-keyer-'));
  tempDirs.push(root);

  const backend: CWKeyerBackend = {
    type: 'cat',
    supportsManualKeying: false,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
    stopActive: vi.fn().mockResolvedValue(undefined),
    getAvailability: vi.fn().mockReturnValue({ available: true, error: null }),
  };

  const manager = new CWKeyerManager();
  (manager as unknown as { rootDir: string }).rootDir = root;
  (manager as unknown as { backends: Record<string, CWKeyerBackend> }).backends.cat = backend;

  return { manager, backend };
}

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('CWKeyerManager', () => {
  it('plays preset messages from the persisted slot text', async () => {
    const { manager, backend } = await createManager();
    await manager.updateSlot('BG5DRB', '1', { text: 'CQ CQ DE BG5DRB' });

    await manager.playMessage('c1', 'Operator', 'BG5DRB', '1', false);

    expect(backend.sendText).toHaveBeenCalledWith(
      'CQ CQ DE BG5DRB',
      20,
      expect.any(Object),
    );
  });

  it('keeps first preset playback status active while lazy-starting the backend', async () => {
    const { manager, backend } = await createManager();
    vi.useFakeTimers();
    await manager.updateSlot('BG5DRB', '1', { text: 'CQ OLD' });
    vi.mocked(backend.sendText).mockImplementation(async (_text, _wpm, signal) => {
      await signal.wait(1_000);
    });

    const playback = manager.playMessage('c1', 'Operator', 'BG5DRB', '1', false);
    await vi.waitFor(() => expect(backend.sendText).toHaveBeenCalled());

    expect(manager.getStatus()).toMatchObject({
      active: true,
      mode: 'playing',
      messageId: '1',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await playback;
    expect(manager.getStatus()).toMatchObject({ active: false, mode: 'idle' });
  });

  it('can arm repeat playback without transmitting immediately', async () => {
    const { manager, backend } = await createManager();
    vi.useFakeTimers();
    await manager.updateSlot('BG5DRB', '1', {
      text: 'CQ CQ DE BG5DRB',
      repeatEnabled: true,
      repeatIntervalSec: 2,
    });

    const playback = manager.playMessage('c1', 'Operator', 'BG5DRB', '1', true, false);

    await vi.waitFor(() => expect(manager.getStatus()).toMatchObject({
      active: true,
      mode: 'repeat-waiting',
      messageId: '1',
    }));
    expect(backend.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(backend.sendText).toHaveBeenCalledWith(
      'CQ CQ DE BG5DRB',
      20,
      expect.any(Object),
    ));

    await manager.stopActive('test cleanup');
    await playback;
  });
});
