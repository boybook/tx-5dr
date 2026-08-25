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
  it('stores calibration separately from immutable FAX row chunks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-paper-spool-'));
    dirs.push(dir);
    const spool = new ImagePaperSpool(dir);
    await spool.initialize();
    spool.start('fax', 1, { ...boundary('fax', 0, false), codecMode: 'ioc576/120/fm', width: 4, pixelFormat: 'gray8' });
    spool.appendRow({ lineIndex: 0, width: 4, pixelFormat: 'gray8', revision: 0, pixels: new Uint8Array([1, 2, 3, 4]) });
    const before = await spool.snapshotRange(0, 1);
    const calibration = spool.addFaxCalibrationPoint('fax', {
      revision: 1, referenceLine: 0, phasePixels: 1, clockPpm: 25,
      confidence: 0.9, source: 'phasing', status: 'locked',
    });
    expect(calibration?.autoPoints).toHaveLength(1);
    expect(spool.setFaxCalibration({ boundaryId: 'fax', autoEnabled: true, phasePixels: 2, clockPpm: -10 })?.revision).toBe(2);
    expect((await spool.snapshotRange(0, 1)).pixels).toEqual(before.pixels);
    expect(spool.getManifest()?.segments[0].calibration?.manualPhasePixels).toBe(2);
  });

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

  it('never includes local transmit preview rows in a received manual range', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-paper-spool-'));
    dirs.push(dir);
    const spool = new ImagePaperSpool(dir);
    await spool.initialize();
    spool.start('sstv', 1, boundary('initial', 0, false));
    for (let line = 0; line < 4; line += 1) spool.appendRow({ lineIndex: line, width: 4, pixelFormat: 'rgb8', revision: 0, pixels: new Uint8Array(12) });
    spool.addBoundary({ ...boundary('tx-start', 4, false), kind: 'localTxStart', source: 'localTx' as const, txSessionId: 'tx-1' });
    for (let line = 4; line < 6; line += 1) spool.appendRow({ lineIndex: line, width: 4, pixelFormat: 'rgb8', revision: 0, pixels: new Uint8Array(12) });
    expect(spool.latestManualRange()).toEqual({ startLine: 0, endLine: 4 });

    spool.addBoundary({ ...boundary('tx-end', 6, false), kind: 'localTxEnd', source: 'rx' as const, txSessionId: 'tx-1', txOutcome: 'completed' as const });
    expect(spool.latestManualRange()).toEqual({ startLine: 0, endLine: 4 });
    spool.appendRow({ lineIndex: 6, width: 4, pixelFormat: 'rgb8', revision: 0, pixels: new Uint8Array(12) });
    expect(spool.latestManualRange()).toEqual({ startLine: 6, endLine: 7 });
    expect((await spool.snapshotRange(4, 6)).source).toBe('localTx');
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
