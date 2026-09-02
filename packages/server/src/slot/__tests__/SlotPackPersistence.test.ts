import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDataDir: string | null = null;
let previousDataDir: string | undefined;

describe('SlotPackPersistence', () => {
  beforeEach(async () => {
    vi.resetModules();
    previousDataDir = process.env.TX5DR_DATA_DIR;
    tempDataDir = await mkdtemp(join(tmpdir(), 'tx5dr-slotpack-'));
    process.env.TX5DR_DATA_DIR = tempDataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) {
      delete process.env.TX5DR_DATA_DIR;
    } else {
      process.env.TX5DR_DATA_DIR = previousDataDir;
    }

    if (tempDataDir) {
      await rm(tempDataDir, { recursive: true, force: true });
      tempDataDir = null;
    }
  });

  it('lists dates from the frames log directory and filename prefix', async () => {
    if (!tempDataDir) {
      throw new Error('tempDataDir missing');
    }

    const framesLogDir = join(tempDataDir, 'frames-logs');
    await mkdir(framesLogDir, { recursive: true });
    await writeFile(join(framesLogDir, 'frames-2026-05-30.jsonl'), '{}\n');
    await writeFile(join(framesLogDir, 'frames-2026-05-31.jsonl'), '{}\n');
    await writeFile(join(framesLogDir, 'ft8-decodes-2026-05-29.jsonl'), '{}\n');
    await writeFile(join(framesLogDir, 'frames-not-a-date.txt'), '{}\n');

    const { SlotPackPersistence } = await import('../SlotPackPersistence.js');
    const persistence = new SlotPackPersistence();

    await expect(persistence.getAvailableDates()).resolves.toEqual([
      '2026-05-30',
      '2026-05-31',
    ]);

    await persistence.cleanup();
  });

  it('indexes the latest persisted snapshot for each slot', async () => {
    if (!tempDataDir) {
      throw new Error('tempDataDir missing');
    }

    const framesLogDir = join(tempDataDir, 'frames-logs');
    await mkdir(framesLogDir, { recursive: true });
    const slotPack = (slotId: string, lastUpdated: number, message: string) => ({
      slotId,
      startMs: lastUpdated - 15_000,
      endMs: lastUpdated,
      frames: [{ message, snr: -10, dt: 0, freq: 1500, confidence: 1 }],
      stats: {
        totalDecodes: 1,
        successfulDecodes: 1,
        totalFramesBeforeDedup: 1,
        totalFramesAfterDedup: 1,
        lastUpdated,
      },
      decodeHistory: [],
    });
    const records = [
      {
        storedAt: 1_780_000_000_000,
        operation: 'updated',
        slotPack: slotPack('slot-a', 1_780_000_001_000, 'old'),
        version: '1.0.0',
      },
      {
        storedAt: 1_780_000_000_100,
        operation: 'updated',
        slotPack: slotPack('slot-a', 1_780_000_002_000, 'new'),
        version: '1.0.0',
      },
    ];
    await writeFile(
      join(framesLogDir, 'frames-2026-06-01.jsonl'),
      `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
    );

    const { SlotPackPersistence } = await import('../SlotPackPersistence.js');
    const persistence = new SlotPackPersistence();
    await expect(persistence.readLatestRecords('2026-06-01')).resolves.toMatchObject([
      { slotPack: { slotId: 'slot-a', frames: [{ message: 'new' }] } },
    ]);
    await persistence.cleanup();
  });
});
