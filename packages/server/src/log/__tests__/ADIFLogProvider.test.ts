import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { ADIFLogProvider } from '../ADIFLogProvider.js';

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

describe('ADIFLogProvider import', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
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
    expect(exported).toContain('<COMMENT:7>CQ TEST');
    expect(exported).toContain('<NOTES:11>Manual note');
    expect(exported).toContain('<OPERATOR:6>BG2XYZ');
    expect(exported).not.toContain('<NOTE:11>Manual note');
    expect(exported).not.toContain('<STATE:2>CA');

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

    const qso = await provider.getQSO('voice-usb-export');
    const saved = await readFile(join(tempDir, 'logbook.adi'), 'utf-8');

    expect(qso?.mode).toBe('SSB');
    expect(qso?.submode).toBe('USB');
    expect(saved).toContain('<MODE:3>SSB');
    expect(saved).toContain('<SUBMODE:3>USB');

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
