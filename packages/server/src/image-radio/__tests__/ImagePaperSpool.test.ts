import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImagePaperSpool } from '../ImagePaperSpool.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function boundary(boundaryId: string, lineIndex: number, trusted: boolean, kind: 'initial' | 'vis' | 'protocolEnd' = 'initial') {
  return {
    boundaryId, lineIndex, trusted, kind,
    codecMode: 'robot36', width: 4, pixelFormat: 'rgb8' as const, timestamp: Date.now(),
  };
}

describe('ImagePaperSpool', () => {
  it('freezes exact boundary ranges across disk chunks and live rows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-paper-spool-'));
    dirs.push(dir);
    const spool = new ImagePaperSpool(dir);
    await spool.initialize();
    spool.start('sstv', 1, boundary('initial', 0, false));
    spool.addBoundary(boundary('trusted', 10, true, 'vis'));
    for (let line = 10; line < 310; line += 1) {
      spool.appendRow({ lineIndex: line, width: 4, pixelFormat: 'rgb8', revision: 0, pixels: new Uint8Array(12).fill(line % 256) });
    }

    const range = spool.latestManualRange();
    expect(range).toEqual({ startLine: 10, endLine: 310 });
    const snapshot = await spool.snapshotRange(range!.startLine, range!.endLine);
    expect(snapshot).toMatchObject({ width: 4, height: 300, startLine: 10, endLine: 310, truncated: false });
    expect(snapshot.pixels[0]).toBe(10);
    expect(snapshot.pixels.at(-1)).toBe(53);
  });

  it('uses protocol end as the next manual-save anchor', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-paper-spool-'));
    dirs.push(dir);
    const spool = new ImagePaperSpool(dir);
    await spool.initialize();
    spool.start('sstv', 1, boundary('trusted', 0, true, 'vis'));
    for (let line = 0; line < 4; line += 1) spool.appendRow({ lineIndex: line, width: 4, pixelFormat: 'rgb8', revision: 0, pixels: new Uint8Array(12) });
    spool.addBoundary(boundary('end', 4, false, 'protocolEnd'));
    spool.appendRow({ lineIndex: 4, width: 4, pixelFormat: 'rgb8', revision: 0, pixels: new Uint8Array(12) });

    expect(spool.latestManualRange()).toEqual({ startLine: 4, endLine: 5 });
  });

  it('drops old chunks at the independent cache quota and reports truncation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-paper-spool-'));
    dirs.push(dir);
    const truncated: number[] = [];
    const spool = new ImagePaperSpool(dir, 1_000, (line) => truncated.push(line));
    await spool.initialize();
    spool.start('sstv', 1, boundary('initial', 0, false));
    for (let line = 0; line < 300; line += 1) spool.appendRow({ lineIndex: line, width: 4, pixelFormat: 'rgb8', revision: 0, pixels: new Uint8Array(12) });

    expect(truncated.at(-1)).toBe(256);
    expect(spool.getSession()?.firstAvailableLine).toBe(256);
  });
});
