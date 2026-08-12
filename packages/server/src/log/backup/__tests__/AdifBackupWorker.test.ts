import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanLogbookFileInline } from '../../persistence/LogbookScanCore.js';
import { AdifBackupWorker } from '../AdifBackupWorker.js';

function adifRecord(call: string, id = call): string {
  return `<CALL:${call.length}>${call}<APP_TX5DR_ID:${id.length}>${id}`
    + '<QSO_DATE:8>20260812<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>\n';
}

describe('AdifBackupWorker', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(directory => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  async function tempDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-backup-worker-'));
    tempDirectories.push(directory);
    return directory;
  }

  it('copies only the EOF fixed when the source handle opens', async () => {
    const directory = await tempDirectory();
    const sourcePath = path.join(directory, 'main.adi');
    const targetPath = path.join(directory, 'latest.tmp');
    const original = `<ADIF_VER:5>3.1.4<EOH>\n${adifRecord('BG5AA')}`;
    const laterAppend = adifRecord('BG5AB');
    await writeFile(sourcePath, original);

    let appendPromise: Promise<void> | undefined;
    let sourceOpened = 0;
    const summary = await new AdifBackupWorker().copyAndScan(
      sourcePath,
      targetPath,
      undefined,
      () => {
        sourceOpened += 1;
        appendPromise = appendFile(sourcePath, laterAppend);
      },
    );
    await appendPromise;

    expect(sourceOpened).toBe(1);
    expect(summary.size).toBe(Buffer.byteLength(original));
    expect(summary.recordCount).toBe(1);
    expect(await readFile(targetPath, 'utf8')).toBe(original);
    expect(await readFile(sourcePath, 'utf8')).toBe(original + laterAppend);
    await expect(scanLogbookFileInline(targetPath)).resolves.toMatchObject({
      scan: { records: expect.any(Array), incompleteTailRange: undefined },
    });
  });
});
