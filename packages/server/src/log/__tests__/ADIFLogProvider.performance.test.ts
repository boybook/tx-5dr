import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ADIFLogProvider } from '../ADIFLogProvider.js';
import { scanAdifBuffer } from '../persistence/AdifCodec.js';

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

  it('imports duplicate and mixed batches and exports 89K records without monopolizing the event loop', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-import-export-performance-'));
    const logFilePath = join(tempDir, 'large.adi');
    const options = { logFilePath, logFileName: 'large.adi', autoCreateFile: true };
    provider = new ADIFLogProvider(options);
    await provider.initialize();
    const count = 89_000;
    const padding = 'x'.repeat(180);
    const raw = (index: number, extra = '') => [
      adifField('CALL', `K1PERF${index}`),
      adifField('QSO_DATE', '20260101'),
      adifField('TIME_ON', '120000'),
      adifField('MODE', 'FT8'),
      adifField('FREQ', '14.074000'),
      index % 8 === 0 ? adifField('APP_TX5DR_ID', `fixture-${index}`) : '',
      adifField('APP_OTHER', padding),
      extra,
      '<EOR>\n',
    ].join('');
    const source = 'WSJT-X ADIF Export<EOH>\n'
      + Array.from({ length: count }, (_, index) => raw(index)).join('')
      + raw(count - 1, adifField('GRIDSQUARE', 'FN31'));

    const responsive = async <T>(operation: () => Promise<T>): Promise<T> => {
      let last = performance.now();
      let maxGap = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks += 1;
      }, 10);
      const started = performance.now();
      try {
        const result = await operation();
        await new Promise<void>(resolve => setImmediate(resolve));
        maxGap = Math.max(maxGap, performance.now() - last);
        expect(performance.now() - started).toBeLessThan(20_000);
        expect(ticks).toBeGreaterThan(0);
        expect(maxGap).toBeLessThan(1_000);
        return result;
      } finally {
        clearInterval(timer);
      }
    };

    const observedCounts = new Set<number>();
    const observer = setInterval(() => {
      void provider!.getStatistics().then(stats => observedCounts.add(stats.totalQSOs));
    }, 10);
    try {
      const imported = await responsive(() => provider!.importADIF(source));
      expect(imported).toMatchObject({ totalRead: count + 1, imported: count, merged: 1, skipped: 0 });
      expect([...observedCounts].every(value => value === 0 || value === count)).toBe(true);
    } finally {
      clearInterval(observer);
    }
    const exported = await responsive(() => provider!.exportADIF());
    expect(exported.match(/<eor>/gi)).toHaveLength(count);
    expect(exported).toContain(adifField('APP_OTHER', padding));
    const first = await provider.getLastQSOWithCallsign('K1PERF1');
    expect(exported).toContain(raw(1).trim());
    expect((await provider.getLastQSOWithCallsign(`K1PERF${count - 1}`))?.grid).toBe('FN31');

    // Updating many existing rows while interleaving new rows must reuse the
    // same mutation indexes, rather than rebuilding them for each append.
    const mixed = '<EOH>\n' + Array.from({ length: 2_000 }, (_, index) => (
      raw(index, adifField('NOTES', 'merged')) + raw(count + index)
    )).join('');
    const merged = await responsive(() => provider!.importADIF(mixed));
    expect(merged).toMatchObject({ imported: 2_000, merged: 2_000 });
    expect((await provider.getQSO(first!.id))?.notes).toBe('merged');
    await provider.close();

    provider = new ADIFLogProvider(options);
    await provider.initialize();
    expect((await provider.getStatistics()).totalQSOs).toBe(count + 2_000);
    expect((await provider.getQSO(first!.id))?.notes).toBe('merged');
    const scan = scanAdifBuffer(await readFile(logFilePath));
    expect(scan.issues).toEqual([]);
    expect(scan.incompleteTailRange).toBeUndefined();
  }, 90_000);

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
