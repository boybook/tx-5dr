import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';

import { ADIFLogProvider } from '../ADIFLogProvider.js';
import { MutationBlockedError, PersistenceCoordinator } from '../../utils/persistence/index.js';

async function createProvider() {
  const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-log-import-'));
  const provider = new ADIFLogProvider({
    logFilePath: join(tempDir, 'logbook.adi'),
    autoCreateFile: true,
    logFileName: 'logbook.adi',
  });
  await provider.initialize();
  return { provider, tempDir };
}

function buildAdif(records: string[]): string {
  return `TX-5DR Test
<ADIF_VER:5>3.1.4
<EOH>

${records.join('\n')}
`;
}

function adifField(name: string, value: string): string {
  return `<${name}:${value.length}>${value}`;
}

function expectOrdered(content: string, needles: string[]): void {
  let previousIndex = -1;
  for (const needle of needles) {
    const index = content.indexOf(needle);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

describe('ADIFLogProvider import', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    PersistenceCoordinator.getInstance().allowNewMutationsForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('merges duplicate ADIF records by filling missing fields', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const initial = buildAdif([
      '<CALL:5>BG2AA<QSO_DATE:8>20260101<TIME_ON:6>120000<MODE:3>FT8<FREQ:9>14.074000<EOR>',
    ]);
    const complement = buildAdif([
      '<CALL:5>BG2AA<QSO_DATE:8>20260101<TIME_ON:6>120000<MODE:3>FT8<FREQ:9>14.074000<GRIDSQUARE:6>PM01AA<LOTW_QSL_RCVD:1>Y<EOR>',
    ]);

    const firstResult = await provider.importADIF(initial);
    const secondResult = await provider.importADIF(complement);
    const qsos = await provider.queryQSOs();

    expect(firstResult.imported).toBe(1);
    expect(secondResult.imported).toBe(0);
    expect(secondResult.merged).toBe(1);
    expect(qsos).toHaveLength(1);
    expect(qsos[0].grid).toBe('PM01AA');
    expect(qsos[0].lotwQslReceived).toBe('Y');

    await provider.close();
  });

  it('does not create the metadata sidecar during initial load when it is missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-log-meta-lazy-'));
    tempDirs.push(tempDir);
    const provider = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook.adi'),
      autoCreateFile: true,
      logFileName: 'logbook.adi',
    });

    await provider.initialize();

    const entries = await readdir(tempDir);
    expect(entries).toContain('logbook.adi');
    expect(entries).not.toContain('logbook.meta.json');

    await provider.close();
  });

  it('recreates a missing nested logbook directory during initial load', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-log-dir-recreate-'));
    tempDirs.push(tempDir);
    const provider = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook', 'BG4IAJ.adi'),
      autoCreateFile: true,
      logFileName: 'logbook/BG4IAJ.adi',
    });

    await provider.initialize();

    const content = await readFile(join(tempDir, 'logbook', 'BG4IAJ.adi'), 'utf-8');
    expect(content).toContain('<EOH>');

    await provider.close();
  });

  it('imports TX-5DR CSV exports', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const csv = [
      'Date,Time,Callsign,Grid,Frequency (MHz),Mode,Report Sent,Report Received,My Callsign,My Grid,Comments',
      '2026-01-01,12:00:00,BG2AA,PM01AA,14.074000,FT8,-10,-08,BG2XYZ,PM00AA,"CQ TEST | RR73"',
    ].join('\n');

    const result = await provider.importCSV(csv);
    const qsos = await provider.queryQSOs();

    expect(result.detectedFormat).toBe('csv');
    expect(result.totalRead).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(qsos).toHaveLength(1);
    expect(qsos[0].messageHistory).toEqual(['CQ TEST', 'RR73']);
    expect(qsos[0].myCallsign).toBe('BG2XYZ');

    await provider.close();
  });

  it('exports untouched external ADIF records using the original record text', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const rawRecord = '<call:5>BG2AA  <qso_date:8>20260101 <time_on:6>120000  <freq:9>14.074000 <mode:3>FT8 <gridsquare:6>PM01AA<eor>';

    await provider.importADIF(buildAdif([rawRecord]));
    const exported = await provider.exportADIF(undefined, { fallbackGrid: 'PM00AA' });

    expect(exported).toContain(`${rawRecord}\n`);
    expect(exported).not.toContain('<CALL:5>BG2AA<QSO_DATE:8>20260101');
    expect(exported).not.toContain('<BAND:3>20m');
    expect(exported).not.toContain('<MY_GRIDSQUARE:6>PM00AA');

    await provider.close();
  });

  it('keeps original external ADIF records after provider reload', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const rawRecord = '<call:5>BG2BB <qso_date:8>20260102<time_on:6>130000<mode:3>FT8<freq:9>14.074000<eor>';

    await provider.importADIF(buildAdif([rawRecord]));
    await provider.close();

    const reloaded = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook.adi'),
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    const exported = await reloaded.exportADIF();

    expect(exported).toContain(`${rawRecord}\n`);
    expect(exported).not.toContain('<CALL:5>BG2BB');
    expect(exported).not.toContain('<BAND:3>20m');

    await reloaded.close();
  });

  it('exports edited external ADIF records using the TX-5DR format', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const rawRecord = '<call:5>BG2CC <qso_date:8>20260103<time_on:6>140000<mode:3>FT8<freq:9>14.074000<eor>';

    await provider.importADIF(buildAdif([rawRecord]));
    const qsos = await provider.queryQSOs();
    expect(qsos).toHaveLength(1);

    await provider.updateQSO(qsos[0].id, { notes: 'edited' });
    const exported = await provider.exportADIF();

    expect(exported).not.toContain(rawRecord);
    expect(exported).toContain('<CALL:5>BG2CC');
    expect(exported).toContain('<NOTES:6>edited');
    expect(exported).toContain('<BAND:3>20m');

    await provider.close();
  });

  it('exports manually created records using the TX-5DR format', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'manual-export-format',
      callsign: 'BG2DD',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-04T15:00:00Z'),
      messageHistory: [],
    }, 'op1');

    const exported = await provider.exportADIF(undefined, { fallbackGrid: 'PM00AA' });

    expect(exported).toContain('<CALL:5>BG2DD');
    expect(exported).toContain('<QSO_DATE:8>20260104');
    expect(exported).toContain('<BAND:3>20m');
    expect(exported).toContain('<MY_GRIDSQUARE:6>PM00AA');

    await provider.close();
  });

  it('exports ADIF oldest-to-newest even when the caller requests descending order', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'adif-order-new',
      callsign: 'NEW1',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-20T12:20:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.addQSO({
      id: 'adif-order-old',
      callsign: 'OLD1',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-20T12:00:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.addQSO({
      id: 'adif-order-mid',
      callsign: 'MID1',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-20T12:10:00Z'),
      messageHistory: [],
    }, 'op1');

    const queryDesc = await provider.queryQSOs({ orderBy: 'time', orderDirection: 'desc' });
    expect(queryDesc.map(qso => qso.callsign)).toEqual(['NEW1', 'MID1', 'OLD1']);

    const exported = await provider.exportADIF({ orderBy: 'time', orderDirection: 'desc' });
    expectOrdered(exported, ['<CALL:4>OLD1', '<CALL:4>MID1', '<CALL:4>NEW1']);

    await provider.close();
  });

  it('writes checkpoint ADIF snapshots oldest-to-newest after reversed external imports', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);
    const logFilePath = join(tempDir, 'logbook.adi');

    const newerRaw = '<call:5>BG2N1 <qso_date:8>20260121<time_on:6>121000<freq:9>14.075000<mode:3>FT8<app_other:3>NEW<eor>';
    const olderRaw = '<call:5>BG2O1 <qso_date:8>20260121<time_on:6>120000<freq:9>14.074000<mode:3>FT8<app_other:3>OLD<eor>';
    await provider.importADIF(buildAdif([newerRaw, olderRaw]));
    await provider.addQSO({
      id: 'checkpoint-order-latest',
      callsign: 'BG2ZZ',
      frequency: 14076000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-21T12:20:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.flush();

    const saved = await readFile(logFilePath, 'utf-8');
    expectOrdered(saved, [olderRaw, newerRaw, '<CALL:5>BG2ZZ']);

    await provider.close();
  });

  it('preserves duplicate external raw ADIF records with strong match keys across flush and reload', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const lateRaw = '<call:5>BG2RX  <qso_date:8>20260115 <time_on:6>121000 <freq:9>14.075000 <mode:3>FT8 <APP_OTHER:3>YES<eor>';
    const earlyRaw = '<call:5>BG2RX <qso_date:8>20260115<time_on:6>120000<freq:9>14.074000<mode:3>FT8<APP_OTHER:5>HELLO<eor>';

    await provider.importADIF(buildAdif([lateRaw, earlyRaw]));
    await provider.flush();
    await provider.close();

    const reloaded = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook.adi'),
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    const exported = await reloaded.exportADIF();
    expect(exported).toContain(`${earlyRaw}\n`);
    expect(exported).toContain(`${lateRaw}\n`);
    expect(exported).not.toContain('<CALL:5>BG2RX');
    expectOrdered(exported, [earlyRaw, lateRaw]);

    await reloaded.close();
  });

  it('preserves unparseable external ADIF records and keeps normal new QSOs at the bottom', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const rawWithoutTime = '<CALL:5>BADNT<QSO_DATE:8>20260116<MODE:3>FT8<FREQ:9>14.074000<EOR>';
    const rawWithTime = '<QSO_DATE:8>20260116<TIME_ON:6>120000<MODE:3>FT8<FREQ:9>14.074000<APP_X:3>RAW<EOR>';

    const result = await provider.importADIF(buildAdif([rawWithTime, rawWithoutTime]));
    expect(result.skipped).toBe(2);
    await provider.addQSO({
      id: 'unparseable-order-new',
      callsign: 'BG2OK',
      frequency: 14076000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-16T12:10:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.flush();

    const saved = await readFile(join(tempDir, 'logbook.adi'), 'utf-8');
    const exported = await provider.exportADIF();
    expectOrdered(saved, [rawWithoutTime, rawWithTime, '<CALL:5>BG2OK']);
    expectOrdered(exported, [rawWithoutTime, rawWithTime, '<CALL:5>BG2OK']);

    await provider.close();
  });

  it('exports standard ADIF COMMENT/NOTES fields for my location, operator, and FT4 submode', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'ft4-export',
      callsign: 'BG2AA',
      frequency: 14074000,
      mode: 'FT4',
      submode: 'FT4',
      startTime: Date.parse('2026-01-01T23:59:55Z'),
      endTime: Date.parse('2026-01-02T00:00:10Z'),
      messageHistory: ['CQ TEST'],
      myCallsign: 'BG2XYZ',
      myGrid: 'PM00AA',
      myState: 'CA',
      myCounty: 'LA',
      myIota: 'AS-007',
      notes: 'Manual note',
    }, 'op1');

    const exported = await provider.exportADIF();

    expect(exported).toContain('<MODE:4>MFSK');
    expect(exported).toContain('<SUBMODE:3>FT4');
    expect(exported).toContain('<QSO_DATE_OFF:8>20260102');
    expect(exported).toContain('<MY_STATE:2>CA');
    expect(exported).toContain('<MY_CNTY:2>LA');
    expect(exported).toContain('<MY_IOTA:6>AS-007');
    expect(exported).toContain('<APP_TX5DR_MESSAGE_HISTORY:7>CQ TEST');
    expect(exported).not.toContain('<COMMENT:7>CQ TEST');
    expect(exported).toContain('<NOTES:11>Manual note');
    expect(exported).toContain('<OPERATOR:6>BG2XYZ');
    expect(exported).not.toContain('<NOTE:11>Manual note');
    expect(exported).not.toContain('<STATE:2>CA');

    await provider.close();
  });

  it('rewrites imported ADIF records with canonical COMMENT after local edits', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const rawRecord = '<call:5>BG2AA<qso_date:8>20260101<time_on:6>120000<freq:9>14.074000<mode:3>FT8<rst_sent:3>-12<rst_rcvd:3>-09<eor>';

    await provider.importADIF(buildAdif([rawRecord]));
    expect(await provider.exportADIF()).toContain(`${rawRecord}\n`);

    const qso = (await provider.queryQSOs())[0]!;
    await provider.updateQSO(qso.id, { comment: 'TU' });
    const exported = await provider.exportADIF();

    expect(exported).not.toContain(`${rawRecord}\n`);
    expect(exported).toContain('<COMMENT:30>FT8  Sent: -12  Rcvd: -09 | TU');

    await provider.close();
  });

  it('exports WSJT-X compatible signal reports in COMMENT while keeping message history private', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'ft8-report-comment',
      callsign: 'BG2AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      reportSent: '-12',
      reportReceived: '-09',
      messageHistory: ['BG2AA BG2XYZ -09', 'BG2XYZ BG2AA R-12'],
      myCallsign: 'BG2XYZ',
      myGrid: 'PM00AA',
      comment: 'TU',
    }, 'op1');

    const exported = await provider.exportADIF();

    expect(exported).toContain('<COMMENT:30>FT8  Sent: -12  Rcvd: -09 | TU');
    expect(exported).toMatch(/<APP_TX5DR_MESSAGE_HISTORY:\d+>BG2AA BG2XYZ -09 \| BG2XYZ BG2AA R-12/);

    await provider.close();
  });

  it('stores voice sideband QSOs as standard SSB ADIF with submode', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'voice-usb-export',
      callsign: 'N0CALL',
      frequency: 14270000,
      mode: 'USB',
      startTime: Date.parse('2026-04-17T12:00:00Z'),
      endTime: Date.parse('2026-04-17T12:05:00Z'),
      reportSent: '59',
      reportReceived: '59',
      messageHistory: [],
      myCallsign: 'BG5DRB',
      myGrid: 'PM01AA',
    }, 'op1');

    await provider.flush();
    const qso = await provider.getQSO('voice-usb-export');
    const saved = await readFile(join(tempDir, 'logbook.adi'), 'utf-8');

    expect(qso?.mode).toBe('SSB');
    expect(qso?.submode).toBe('USB');
    expect(saved).toContain('<MODE:3>SSB');
    expect(saved).toContain('<SUBMODE:3>USB');

    await provider.close();
  });

  it('replays durable journal transactions after add/update/delete without an ADIF checkpoint', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'journal-replay-kept',
      callsign: 'BG2JR',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-05T12:00:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.updateQSO('journal-replay-kept', { notes: 'updated from journal' });
    await provider.addQSO({
      id: 'journal-replay-deleted',
      callsign: 'BG2JD',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-05T12:15:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.deleteQSO('journal-replay-deleted');

    const snapshot = await readFile(join(tempDir, 'logbook.adi'), 'utf-8');
    expect(snapshot).not.toContain('BG2JR');

    const reloaded = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook.adi'),
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    const qsos = await reloaded.queryQSOs();
    expect(qsos.map(qso => qso.id)).toEqual(['journal-replay-kept']);
    expect(qsos[0].notes).toBe('updated from journal');

    await reloaded.close();
    await provider.close();
  });

  it('truncates a partial/corrupt journal tail while preserving valid transactions', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'journal-partial-valid',
      callsign: 'BG2JP',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-06T12:00:00Z'),
      messageHistory: [],
    }, 'op1');
    const journalPath = join(tempDir, 'logbook.journal.jsonl');
    await appendFile(journalPath, '{"txId":"BROKEN_TRAILER"', 'utf-8');

    const reloaded = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook.adi'),
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    expect(await reloaded.getQSO('journal-partial-valid')).not.toBeNull();
    const journalContent = await readFile(journalPath, 'utf-8');
    expect(journalContent).not.toContain('BROKEN_TRAILER');
    expect(journalContent.endsWith('\n')).toBe(true);

    await reloaded.close();
    await provider.close();
  });

  it('does not replay a complete-looking journal tail without a durable newline', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'journal-no-newline-tail',
      callsign: 'BG2JN',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-06T12:30:00Z'),
      messageHistory: [],
    }, 'op1');
    const journalPath = join(tempDir, 'logbook.journal.jsonl');
    const journalContent = await readFile(journalPath, 'utf-8');
    await writeFile(journalPath, journalContent.replace(/\n$/, ''), 'utf-8');

    const reloaded = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook.adi'),
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    expect(await reloaded.getQSO('journal-no-newline-tail')).toBeNull();
    await expect(readFile(journalPath, 'utf-8')).resolves.toBe('');

    await reloaded.close();
    await provider.close();
  });

  it('preserves unparseable external ADIF lines across repeated checkpoints', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-log-import-'));
    tempDirs.push(tempDir);
    const logFilePath = join(tempDir, 'logbook.adi');
    const rawUnparseable = '<CALL:5>BADXX<QSO_DATE:8>20260108<MODE:3>FT8<FREQ:9>14.074000<EOR>';
    await writeFile(logFilePath, buildAdif([rawUnparseable]), 'utf-8');

    const provider = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await provider.initialize();

    await provider.addQSO({
      id: 'checkpoint-preserve-1',
      callsign: 'BG2P1',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-08T12:00:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.flush();

    await provider.addQSO({
      id: 'checkpoint-preserve-2',
      callsign: 'BG2P2',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-08T12:15:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.flush();

    const saved = await readFile(logFilePath, 'utf-8');
    expect(saved).toContain(rawUnparseable);

    await provider.close();
  });

  it('serializes checkpoint with queued journal writes', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const writes = Array.from({ length: 20 }, (_, index) => provider.addQSO({
      id: `checkpoint-queued-${index}`,
      callsign: `B${index}CQ`,
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-07T12:00:00Z') + index * 60_000,
      messageHistory: [],
    }, 'op1'));

    await Promise.all([...writes, provider.flush()]);

    const reloaded = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook.adi'),
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    expect(await reloaded.countQSOs()).toBe(20);
    await expect(stat(join(tempDir, 'logbook.journal.jsonl'))).resolves.toMatchObject({ size: 0 });

    await reloaded.close();
    await provider.close();
  });

  it('recovers a corrupt checkpoint snapshot from backup plus archived journals', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);
    const logFilePath = join(tempDir, 'logbook.adi');

    await provider.addQSO({
      id: 'checkpoint-recovery-a',
      callsign: 'BG2A',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-09T12:00:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.flush();

    await provider.addQSO({
      id: 'checkpoint-recovery-b',
      callsign: 'BG2B',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-09T12:15:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.flush();

    const archives = (await readdir(tempDir)).filter(name => /^logbook\.journal\.jsonl\.\d{4}-/.test(name));
    expect(archives.length).toBeGreaterThanOrEqual(2);
    await writeFile(logFilePath, 'truncated snapshot without header', 'utf-8');

    const reloaded = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    const ids = (await reloaded.queryQSOs()).map(qso => qso.id).sort();
    expect(ids).toEqual(['checkpoint-recovery-a', 'checkpoint-recovery-b']);
    await expect(readFile(logFilePath, 'utf-8')).resolves.toContain('BG2B');

    await reloaded.close();
    await provider.close();
  });

  it('fails closed when the ADIF snapshot is corrupt and no journal can recover it', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-log-import-'));
    tempDirs.push(tempDir);
    const logFilePath = join(tempDir, 'logbook.adi');
    await writeFile(logFilePath, 'not an adif snapshot', 'utf-8');

    const provider = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });

    await expect(provider.initialize()).rejects.toThrow(/Unable to recover ADIF log snapshot/);
    await expect(readFile(logFilePath, 'utf-8')).resolves.toBe('not an adif snapshot');
  });

  it('replays archived journals only to the last valid transaction and preserves corrupt tails', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);
    const logFilePath = join(tempDir, 'logbook.adi');

    await provider.addQSO({
      id: 'archived-journal-valid',
      callsign: 'BG2AJ',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-10T12:00:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.flush();

    const archivedName = (await readdir(tempDir)).find(name => /^logbook\.journal\.jsonl\.\d{4}-/.test(name));
    expect(archivedName).toBeTruthy();
    const archivedPath = join(tempDir, archivedName!);
    await appendFile(archivedPath, '{"txId":"BROKEN_TRAILER"', 'utf-8');
    await writeFile(logFilePath, 'broken checkpoint snapshot', 'utf-8');

    const reloaded = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    expect(await reloaded.getQSO('archived-journal-valid')).not.toBeNull();
    await expect(readFile(archivedPath, 'utf-8')).resolves.not.toContain('BROKEN_TRAILER');
    const corruptCopies = (await readdir(tempDir)).filter(name => name.startsWith(`${archivedName}.corrupt-`));
    expect(corruptCopies.length).toBeGreaterThan(0);

    await reloaded.close();
    await provider.close();
  });

  it('rejects new logbook mutations after shutdown blocking without appending journal entries', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'blocked-existing',
      callsign: 'BG2BL',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-11T12:00:00Z'),
      messageHistory: [],
    }, 'op1');
    const journalPath = join(tempDir, 'logbook.journal.jsonl');
    const before = await readFile(journalPath, 'utf-8');

    PersistenceCoordinator.getInstance().blockNewMutations();

    await expect(provider.addQSO({
      id: 'blocked-add',
      callsign: 'BG2BA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-11T12:15:00Z'),
      messageHistory: [],
    }, 'op1')).rejects.toBeInstanceOf(MutationBlockedError);
    await expect(provider.updateQSO('blocked-existing', { notes: 'blocked' })).rejects.toBeInstanceOf(MutationBlockedError);
    await expect(provider.deleteQSO('blocked-existing')).rejects.toBeInstanceOf(MutationBlockedError);
    await expect(provider.importADIF(buildAdif([
      '<CALL:5>BG2IM<QSO_DATE:8>20260111<TIME_ON:6>123000<MODE:3>FT8<FREQ:9>14.074000<EOR>',
    ]))).rejects.toBeInstanceOf(MutationBlockedError);

    await expect(readFile(journalPath, 'utf-8')).resolves.toBe(before);

    PersistenceCoordinator.getInstance().allowNewMutationsForTests();
    await provider.close();
  });

  it('drains logbook writes that were queued before shutdown blocking', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const writes = Array.from({ length: 5 }, (_, index) => provider.addQSO({
      id: `queued-before-block-${index}`,
      callsign: `BQ${index}DR`,
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-12T12:00:00Z') + index * 60_000,
      messageHistory: [],
    }, 'op1'));

    PersistenceCoordinator.getInstance().blockNewMutations();
    await expect(Promise.all(writes)).resolves.toHaveLength(5);
    expect(await provider.countQSOs()).toBe(5);

    PersistenceCoordinator.getInstance().allowNewMutationsForTests();
    await provider.close();
  });

  it('normalizes legacy sideband modes when loading the ADIF cache', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-log-import-'));
    tempDirs.push(tempDir);
    const logFilePath = join(tempDir, 'logbook.adi');
    await writeFile(logFilePath, buildAdif([
      '<CALL:6>N0CALL<QSO_DATE:8>20260417<TIME_ON:6>120000<MODE:3>USB<FREQ:9>14.270000<EOR>',
    ]), 'utf-8');

    const provider = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: false,
      logFileName: 'logbook.adi',
    });
    await provider.initialize();

    const qsos = await provider.queryQSOs();
    const saved = await readFile(logFilePath, 'utf-8');

    expect(qsos).toHaveLength(1);
    expect(qsos[0].mode).toBe('SSB');
    expect(qsos[0].submode).toBe('USB');
    expect(saved).toContain('<MODE:3>SSB');
    expect(saved).toContain('<SUBMODE:3>USB');
    expect(saved).not.toContain('<MODE:3>USB');

    await provider.close();
  });

  it('clears stale sideband submode when a QSO is updated to a non-SSB mode', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'voice-to-fm',
      callsign: 'N0CALL',
      frequency: 145500000,
      mode: 'USB',
      startTime: Date.parse('2026-04-17T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    await provider.updateQSO('voice-to-fm', { mode: 'FM' });
    await provider.flush();
    const qso = await provider.getQSO('voice-to-fm');
    const saved = await readFile(join(tempDir, 'logbook.adi'), 'utf-8');

    expect(qso?.mode).toBe('FM');
    expect(qso?.submode).toBeUndefined();
    expect(saved).toContain('<MODE:2>FM');
    expect(saved).not.toContain('<SUBMODE:3>USB');

    await provider.close();
  });

  it('filters standard sideband records by displayed USB and aggregate SSB modes', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'voice-usb-filter',
      callsign: 'N0USB',
      frequency: 14270000,
      mode: 'USB',
      startTime: Date.parse('2026-04-17T12:00:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.addQSO({
      id: 'voice-lsb-filter',
      callsign: 'N0LSB',
      frequency: 7270000,
      mode: 'LSB',
      startTime: Date.parse('2026-04-17T12:10:00Z'),
      messageHistory: [],
    }, 'op1');
    await provider.addQSO({
      id: 'voice-fm-filter',
      callsign: 'N0FM',
      frequency: 145500000,
      mode: 'FM',
      startTime: Date.parse('2026-04-17T12:20:00Z'),
      messageHistory: [],
    }, 'op1');

    const usbQsos = await provider.queryQSOs({ mode: 'USB' });
    const ssbQsos = await provider.queryQSOs({ mode: 'SSB' });
    const fmQsos = await provider.queryQSOs({ mode: 'FM' });

    expect(usbQsos.map(qso => qso.id)).toEqual(['voice-usb-filter']);
    expect(ssbQsos.map(qso => qso.id).sort()).toEqual(['voice-lsb-filter', 'voice-usb-filter']);
    expect(fmQsos.map(qso => qso.id)).toEqual(['voice-fm-filter']);

    await provider.close();
  });

  it('imports standard MY_* fields, NOTES, and FT4 submode without misreading contacted station fields', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const adif = buildAdif([
      '<CALL:5>BG2AA<QSO_DATE:8>20260101<TIME_ON:6>235955<QSO_DATE_OFF:8>20260102<TIME_OFF:6>000010<MODE:4>MFSK<SUBMODE:3>FT4<FREQ:9>14.074000<STATE:2>TX<CNTY:3>DAL<IOTA:6>EU-001<MY_STATE:2>CA<MY_CNTY:2>LA<MY_IOTA:6>AS-007<NOTES:11>Manual note<EOR>',
    ]);

    await provider.importADIF(adif);
    const qsos = await provider.queryQSOs();

    expect(qsos).toHaveLength(1);
    expect(qsos[0].mode).toBe('FT4');
    expect(qsos[0].submode).toBe('FT4');
    expect(qsos[0].myState).toBe('CA');
    expect(qsos[0].myCounty).toBe('LA');
    expect(qsos[0].myIota).toBe('AS-007');
    expect(qsos[0].notes).toBe('Manual note');
    expect(qsos[0].endTime).toBe(Date.parse('2026-01-02T00:00:10Z'));

    await provider.close();
  });

  it('keeps compatibility with legacy TX-5DR NOTE and my-location fields', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const adif = buildAdif([
      '<CALL:5>BG2AA<QSO_DATE:8>20260101<TIME_ON:6>120000<MODE:3>FT8<FREQ:9>14.074000<STATE:2>CA<CNTY:2>LA<IOTA:6>AS-007<NOTE:11>Manual note<APP_TX5DR_DXCC_STATUS:7>current<EOR>',
    ]);

    await provider.importADIF(adif);
    const qsos = await provider.queryQSOs();

    expect(qsos).toHaveLength(1);
    expect(qsos[0].myState).toBe('CA');
    expect(qsos[0].myCounty).toBe('LA');
    expect(qsos[0].myIota).toBe('AS-007');
    expect(qsos[0].notes).toBe('Manual note');

    await provider.close();
  });

  it('treats the same 4-char grid as worked on the same band', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'BG2AA_1770004800000_1_op1',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    const analysis = await provider.analyzeCallsign('BG9ZZ', 'PM01', { operatorId: 'op1', band: '20m' });

    expect(analysis.isNewGrid).toBe(false);

    await provider.close();
  });

  it('tracks worked grids independently per band', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'BG2AA_1770004800000_2_op1',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    const sameBand = await provider.analyzeCallsign('BG9ZZ', 'PM01BB', { operatorId: 'op1', band: '20m' });
    const otherBand = await provider.analyzeCallsign('BG9ZZ', 'PM01BB', { operatorId: 'op1', band: '40m' });

    expect(sameBand.isNewGrid).toBe(false);
    expect(otherBand.isNewGrid).toBe(true);

    await provider.close();
  });

  it('treats 6-char worked grids as the same 4-char grid during analysis', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'BG2AA_1770004800000_oi67',
      callsign: 'BG2AA',
      grid: 'OI67WS',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    const analysis = await provider.analyzeCallsign('BG9ZZ', 'OI67', { operatorId: 'op1', band: '20m' });

    expect(analysis.isNewGrid).toBe(false);

    await provider.close();
  });

  it('counts unique grids by normalized 4-char key in statistics', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'grid-stats-1',
      callsign: 'BG2AA',
      grid: 'OI67WS',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    await provider.addQSO({
      id: 'grid-stats-2',
      callsign: 'BG3BB',
      grid: 'OI67',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:15:00Z'),
      messageHistory: [],
    }, 'op1');

    const statistics = await provider.getStatistics();

    expect(statistics.uniqueGrids).toBe(1);

    await provider.close();
  });

  it('updates the banded grid cache immediately after addQSO', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    const before = await provider.analyzeCallsign('BG2AA', 'PM01AA', { operatorId: 'op1', band: '20m' });
    expect(before.isNewGrid).toBe(true);

    await provider.addQSO({
      id: 'grid-band-3',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    const after = await provider.analyzeCallsign('BG2AA', 'PM01AA', { operatorId: 'op1', band: '20m' });
    expect(after.isNewGrid).toBe(false);

    await provider.close();
  });

  it('matches grid queries by normalized prefix', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'grid-query-prefix-1',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    await provider.addQSO({
      id: 'grid-query-prefix-2',
      callsign: 'BG3BB',
      grid: 'PM02AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:15:00Z'),
      messageHistory: [],
    }, 'op1');

    await provider.addQSO({
      id: 'grid-query-prefix-3',
      callsign: 'BG4CC',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:30:00Z'),
      messageHistory: [],
    }, 'op1');

    const fourCharMatches = await provider.queryQSOs({ grid: 'PM01' });
    const shortPrefixMatches = await provider.queryQSOs({ grid: 'PM' });
    const sixCharMatches = await provider.queryQSOs({ grid: 'pm01aa' });

    expect(fourCharMatches.map((qso) => qso.callsign)).toEqual(['BG2AA']);
    expect(shortPrefixMatches.map((qso) => qso.callsign)).toEqual(['BG3BB', 'BG2AA']);
    expect(sixCharMatches.map((qso) => qso.callsign)).toEqual(['BG2AA']);

    await provider.close();
  });

  it('combines grid filtering with other query options', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'grid-query-combined-1',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
      qrzQslSent: 'Y',
    }, 'op1');

    await provider.addQSO({
      id: 'grid-query-combined-2',
      callsign: 'BG2BB',
      grid: 'PM01BB',
      frequency: 14074000,
      mode: 'FT4',
      startTime: Date.parse('2026-01-01T12:15:00Z'),
      messageHistory: [],
      qrzQslSent: 'Y',
    }, 'op1');

    await provider.addQSO({
      id: 'grid-query-combined-3',
      callsign: 'BG2CC',
      grid: 'PM01CC',
      frequency: 7074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:30:00Z'),
      messageHistory: [],
    }, 'op1');

    const matches = await provider.queryQSOs({
      grid: 'PM01',
      mode: 'FT8',
      qslStatus: 'uploaded',
      frequencyRange: {
        min: 14000000,
        max: 14350000,
      },
    });

    expect(matches.map((qso) => qso.callsign)).toEqual(['BG2AA']);

    await provider.close();
  });

  it('does not report new grid when band is unknown', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: 'grid-band-4',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    const analysis = await provider.analyzeCallsign('BG9ZZ', 'PM01AA', { operatorId: 'op1', band: 'Unknown' });
    expect(analysis.isNewGrid).toBe(false);

    await provider.close();
  });

  it('treats worked status as callsign-logbook scoped instead of operator UUID scoped', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: '1710000000000',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    const analysis = await provider.analyzeCallsign('BG2AA', 'PM01AA', { operatorId: 'op2', band: '20m' });

    expect(analysis.isNewCallsign).toBe(false);
    expect(analysis.isNewDxccEntity).toBe(false);
    expect(analysis.isNewBandDxccEntity).toBe(false);
    expect(analysis.isNewGrid).toBe(false);

    await provider.close();
  });

  it('keeps worked callsign and grid state after updateQSO rebuilds indexes', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: '1710000000001',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
    }, 'op1');

    await provider.updateQSO('1710000000001', { notes: 'rebuilt' });

    const analysis = await provider.analyzeCallsign('BG2AA', 'PM01AA', { operatorId: 'op2', band: '20m' });

    expect(analysis.isNewCallsign).toBe(false);
    expect(analysis.isNewGrid).toBe(false);
    expect(analysis.isNewDxccEntity).toBe(false);

    await provider.close();
  });

  it('keeps worked state after provider reloads from ADIF cache', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: '1710000000002',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: [],
      myCallsign: 'BG5DRB',
    }, 'op1');

    await provider.close();

    const reloaded = new ADIFLogProvider({
      logFilePath: join(tempDir, 'logbook.adi'),
      autoCreateFile: true,
      logFileName: 'logbook.adi',
    });
    await reloaded.initialize();

    const analysis = await reloaded.analyzeCallsign('BG2AA', 'PM01AA', { operatorId: 'op2', band: '20m' });

    expect(analysis.isNewCallsign).toBe(false);
    expect(analysis.isNewGrid).toBe(false);
    expect(analysis.isNewDxccEntity).toBe(false);

    await reloaded.close();
  });

  it('keeps band-scoped has-worked checks fast after loading a large logbook', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-large-logbook-'));
    tempDirs.push(tempDir);
    const logFilePath = join(tempDir, 'large.adi');
    const totalRecords = 30_000;
    const records: string[] = [];

    for (let index = 0; index < totalRecords; index += 1) {
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

    await writeFile(logFilePath, buildAdif(records), 'utf8');
    const provider = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: false,
      logFileName: 'large.adi',
    });
    await provider.initialize();

    expect(await provider.hasWorkedCallsign('BG7OO', { band: '6m' })).toBe(true);
    expect(await provider.hasWorkedCallsign('BG7OO', { band: '20m' })).toBe(false);

    const startedAt = performance.now();
    for (let index = 0; index < 5_000; index += 1) {
      await provider.hasWorkedCallsign(index % 2 === 0 ? 'BG7OO' : 'W1AW', { band: index % 2 === 0 ? '6m' : '20m' });
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);

    await provider.close();
  }, 30_000);

  it('does not mark a worked DXCC as new for 73-style analyses without grid', async () => {
    const { provider, tempDir } = await createProvider();
    tempDirs.push(tempDir);

    await provider.addQSO({
      id: '1710000000003',
      callsign: 'BG2AA',
      grid: 'PM01AA',
      frequency: 14074000,
      mode: 'FT8',
      startTime: Date.parse('2026-01-01T12:00:00Z'),
      messageHistory: ['BG5DRB BG2AA RR73'],
    }, 'op1');

    const analysis = await provider.analyzeCallsign('BG9ZZ', undefined, { operatorId: 'op2', band: '20m' });

    expect(analysis.isNewCallsign).toBe(true);
    expect(analysis.isNewDxccEntity).toBe(false);
    expect(analysis.isNewBandDxccEntity).toBe(false);
    expect(analysis.isNewGrid).toBe(false);

    await provider.close();
  });
});
