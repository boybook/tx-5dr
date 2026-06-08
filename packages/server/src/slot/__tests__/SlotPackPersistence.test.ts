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
});
