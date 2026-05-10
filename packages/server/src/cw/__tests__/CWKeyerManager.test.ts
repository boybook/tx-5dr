import { mkdtemp, readFile, rm } from 'fs/promises';
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
  it('creates and persists practical default preset messages for a new callsign', async () => {
    const { manager } = await createManager();

    const panel = await manager.getPanel('BG5DRB');

    expect(panel.slotCount).toBe(8);
    expect(panel.slots.slice(0, 8).map(slot => ({ label: slot.label, text: slot.text }))).toEqual([
      { label: 'CQ', text: 'CQ CQ DE {MYCALL} {MYCALL} K' },
      { label: '呼叫', text: '{HISCALL} DE {MYCALL} {MYCALL} K' },
      { label: '报告', text: '{HISCALL} DE {MYCALL} UR 599 599 BK' },
      { label: 'TU', text: '{HISCALL} DE {MYCALL} R R TU 73 SK' },
      { label: '重发呼号', text: 'DE {MYCALL} {MYCALL} K' },
      { label: 'QRZ?', text: 'QRZ? DE {MYCALL} K' },
      { label: 'AGN?', text: 'AGN? AGN? DE {MYCALL} K' },
      { label: 'SRI', text: 'SRI CALL? DE {MYCALL} K' },
    ]);

    const rootDir = (manager as unknown as { rootDir: string }).rootDir;
    const persisted = JSON.parse(await readFile(join(rootDir, 'BG5DRB', 'manifest.json'), 'utf8'));
    expect(persisted.slots[0].text).toBe('CQ CQ DE {MYCALL} {MYCALL} K');
  });

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

  it('uses frontend placeholder values for preset playback', async () => {
    const { manager, backend } = await createManager();
    await manager.updateSlot('BG5DRB', '1', { text: '{HISCALL} DE {MYCALL} 599' });

    await manager.playMessage('c1', 'Operator', 'BG5DRB', '1', false, true, {
      myCall: 'bg5drb',
      hisCall: 'k1abc',
    });

    expect(backend.sendText).toHaveBeenCalledWith(
      'K1ABC DE BG5DRB 599',
      20,
      expect.any(Object),
    );
  });

  it('keeps old clients compatible by falling back to callsign for MYCALL', async () => {
    const { manager, backend } = await createManager();
    await manager.updateSlot('BG5DRB', '1', { text: 'CQ DE {MYCALL}' });

    await manager.playMessage('c1', 'Operator', 'BG5DRB', '1', false);

    expect(backend.sendText).toHaveBeenCalledWith(
      'CQ DE BG5DRB',
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

  it('uses the same placeholder context when repeat sends the latest slot text', async () => {
    const { manager, backend } = await createManager();
    vi.useFakeTimers();
    await manager.updateSlot('BG5DRB', '1', {
      text: 'CQ {HISCALL} DE {MYCALL}',
      repeatEnabled: true,
      repeatIntervalSec: 2,
    });

    const playback = manager.playMessage('c1', 'Operator', 'BG5DRB', '1', true, false, {
      myCall: 'BG5DRB',
      hisCall: 'K1ABC',
    });

    await vi.waitFor(() => expect(manager.getStatus()).toMatchObject({
      active: true,
      mode: 'repeat-waiting',
      messageId: '1',
    }));

    await manager.updateSlot('BG5DRB', '1', { text: '{HISCALL} DE {MYCALL} TU' });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(backend.sendText).toHaveBeenCalledWith(
      'K1ABC DE BG5DRB TU',
      20,
      expect.any(Object),
    ));

    await manager.stopActive('test cleanup');
    await playback;
  });
});
