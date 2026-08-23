import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ADIFLogProvider } from '../ADIFLogProvider.js';

function adifField(name: string, value: string): string {
  return `<${name}:${value.length}>${value}`;
}

describe('ADIFLogProvider large-logbook performance', () => {
  let provider: ADIFLogProvider | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await provider?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    provider = undefined;
    tempDir = undefined;
  });

  it('keeps band-scoped lookups and rewrites fast with 70K records', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-large-logbook-'));
    const logFilePath = join(tempDir, 'large.adi');
    const records: string[] = [];

    for (let index = 0; index < 70_000; index += 1) {
      const callsign = index === 12_345 ? 'BG7OO' : `K${index % 10}ABC${index}`;
      const seconds = String(index % 60).padStart(2, '0');
      const minutes = String(Math.floor(index / 60) % 60).padStart(2, '0');
      const hours = String(Math.floor(index / 3600) % 24).padStart(2, '0');
      const frequency = index === 12_345 ? '50.313000' : (index % 2 === 0 ? '7.074000' : '14.074000');
      records.push([
        adifField('CALL', callsign),
        adifField('QSO_DATE', '20260101'),
        adifField('TIME_ON', `${hours}${minutes}${seconds}`),
        adifField('MODE', 'FT8'),
        adifField('FREQ', frequency),
        '<EOR>',
      ].join(''));
    }

    await writeFile(logFilePath, `TX-5DR Test\n<ADIF_VER:5>3.1.4\n<EOH>\n\n${records.join('\n')}\n`, 'utf8');
    provider = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: false,
      logFileName: 'large.adi',
    });
    await provider.initialize();

    expect(await provider.hasWorkedCallsign('BG7OO', { band: '6m' })).toBe(true);
    expect(await provider.hasWorkedCallsign('BG7OO', { band: '20m' })).toBe(false);

    const lookupStartedAt = performance.now();
    for (let index = 0; index < 5_000; index += 1) {
      await provider.hasWorkedCallsign(
        index % 2 === 0 ? 'BG7OO' : 'W1AW',
        { band: index % 2 === 0 ? '6m' : '20m' },
      );
    }
    expect(performance.now() - lookupStartedAt).toBeLessThan(1_000);

    const target = await provider.getLastQSOWithCallsign('BG7OO');
    const rewriteStartedAt = performance.now();
    await provider.updateQSO(target!.id, { notes: '70k rewrite benchmark' });
    expect(performance.now() - rewriteStartedAt).toBeLessThan(20_000);
    await expect(provider.getQSO(target!.id)).resolves.toMatchObject({
      notes: '70k rewrite benchmark',
    });
  }, 90_000);

  it('commits a field-scale sync batch through one bounded rewrite', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-sync-batch-performance-'));
    const logFilePath = join(tempDir, 'sync.adi');
    const records: string[] = [];
    const padding = 'x'.repeat(420);

    for (let index = 0; index < 3_526; index += 1) {
      const seconds = String(index % 60).padStart(2, '0');
      const minutes = String(Math.floor(index / 60) % 60).padStart(2, '0');
      const hours = String(Math.floor(index / 3600) % 24).padStart(2, '0');
      records.push([
        adifField('CALL', `K${index % 10}SYNC${index}`),
        adifField('QSO_DATE', '20260101'),
        adifField('TIME_ON', `${hours}${minutes}${seconds}`),
        adifField('MODE', 'FT8'),
        adifField('FREQ', index % 2 === 0 ? '7.074000' : '14.074000'),
        adifField('COMMENT', padding),
        '<EOR>',
      ].join(''));
    }

    await writeFile(logFilePath, `TX-5DR Test\n<ADIF_VER:5>3.1.4\n<EOH>\n\n${records.join('\n')}\n`, 'utf8');
    provider = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: false,
      logFileName: 'sync.adi',
    });
    await provider.initialize();
    const snapshot = await provider.readQsoSnapshot();
    expect(snapshot.records).toHaveLength(3_526);

    const startedAt = performance.now();
    const result = await provider.applyQsoBatch(
      snapshot.records.slice(0, 2_854).map(record => ({
        type: 'update' as const,
        qsoId: record.id,
        updates: { lotwQslSent: 'Y' as const },
      })),
      { expectedRevision: snapshot.revision },
    );
    const elapsedMs = performance.now() - startedAt;

    expect(result.outcomes).toHaveLength(2_854);
    expect(result.outcomes.every(outcome => outcome.status === 'updated')).toBe(true);
    expect(elapsedMs).toBeLessThan(20_000);
  }, 45_000);
});
