import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CWKeyerManager } from '../CWKeyerManager.js';
import type { CWKeyerBackend } from '../CWKeyerBackend.js';

const tempDirs: string[] = [];

async function createManager(options: { catAvailable?: boolean; catError?: string | null; keyPort?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tx5dr-cw-keyer-'));
  tempDirs.push(root);

  const backend: CWKeyerBackend = {
    type: 'cat',
    supportsManualKeying: false,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
    stopActive: vi.fn().mockResolvedValue(undefined),
    getAvailability: vi.fn().mockReturnValue({
      available: options.catAvailable ?? true,
      error: options.catError ?? null,
    }),
  };
  const serialBackend: CWKeyerBackend = {
    type: 'serial',
    supportsManualKeying: true,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
    stopActive: vi.fn().mockResolvedValue(undefined),
    getAvailability: vi.fn().mockReturnValue({ available: Boolean(options.keyPort), error: options.keyPort ? null : 'CW serial key port is not configured' }),
    keyDown: vi.fn().mockResolvedValue(undefined),
    keyUp: vi.fn().mockResolvedValue(undefined),
  };

  const manager = new CWKeyerManager();
  (manager as unknown as { rootDir: string }).rootDir = root;
  const managerBackends = (manager as unknown as { backends: Record<string, CWKeyerBackend> }).backends;
  managerBackends.cat = backend;
  managerBackends.serial = serialBackend;
  if (options.keyPort) {
    (manager as unknown as { config: { keyPort: string } }).config.keyPort = options.keyPort;
  }

  return { manager, backend, serialBackend };
}

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('CWKeyerManager', () => {
  it('defaults to CAT when the active radio reports CAT CW support', async () => {
    const { manager } = await createManager({ catAvailable: true, keyPort: '/dev/cw' });

    expect(manager.getConfig()).toMatchObject({ backend: 'cat' });
    expect(manager.getStatus()).toMatchObject({ backend: 'cat', backendAvailable: false });
    manager.refreshRuntimeState();
    expect(manager.getStatus()).toMatchObject({ backend: 'cat', backendAvailable: true });
  });

  it('defaults to serial when CAT CW is unsupported and a key port is configured', async () => {
    const { manager } = await createManager({
      catAvailable: false,
      catError: 'Active radio does not report CAT/radio CW text sending support (SEND_MORSE or ICOM CW 0x17)',
      keyPort: '/dev/cw',
    });

    expect(manager.getConfig()).toMatchObject({ backend: 'serial', keyPort: '/dev/cw' });
    manager.refreshRuntimeState();
    expect(manager.getStatus()).toMatchObject({ backend: 'serial', backendAvailable: true });
  });

  it('keeps explicit CAT selection and reports unavailable when CAT CW is unsupported', async () => {
    const { manager } = await createManager({
      catAvailable: false,
      catError: 'Active radio does not report CAT/radio CW text sending support (SEND_MORSE or ICOM CW 0x17)',
      keyPort: '/dev/cw',
    });

    await manager.updateConfig({ backend: 'cat' });

    expect(manager.getConfig()).toMatchObject({ backend: 'cat' });
    expect(manager.getStatus()).toMatchObject({
      backend: 'cat',
      backendAvailable: false,
      backendError: 'Active radio does not report CAT/radio CW text sending support (SEND_MORSE or ICOM CW 0x17)',
    });
  });

  it('creates and persists practical default preset messages for a new callsign', async () => {
    const { manager } = await createManager();

    const panel = await manager.getPanel('BG5DRB');

    expect(panel.slotCount).toBe(8);
    expect(panel.slots.slice(0, 8).map(slot => ({ label: slot.label, text: slot.text }))).toEqual([
      { label: 'CQ', text: 'CQ CQ DE {MYCALL} {MYCALL} K' },
      { label: 'CALL', text: '{HISCALL} DE {MYCALL} {MYCALL} K' },
      { label: 'RST', text: '{HISCALL} DE {MYCALL} UR 599 599 BK' },
      { label: 'TU', text: '{HISCALL} DE {MYCALL} R R TU 73 SK' },
      { label: 'MYCALL', text: 'DE {MYCALL} {MYCALL} K' },
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
