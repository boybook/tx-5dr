import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
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
    expect(qsos[0].messages).toEqual(['CQ TEST', 'RR73']);
    expect(qsos[0].myCallsign).toBe('BG2XYZ');

    await provider.close();
  });

  it('exports standard ADIF fields for my location, notes, operator, and FT4 submode', async () => {
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
      messages: ['CQ TEST'],
      myCallsign: 'BG2XYZ',
      myGrid: 'PM00AA',
      myState: 'CA',
      myCounty: 'LA',
      myIota: 'AS-007',
      remarks: 'Manual note',
    }, 'op1');

    const exported = await provider.exportADIF();

    expect(exported).toContain('<MODE:4>MFSK');
    expect(exported).toContain('<SUBMODE:3>FT4');
    expect(exported).toContain('<QSO_DATE_OFF:8>20260102');
    expect(exported).toContain('<MY_STATE:2>CA');
    expect(exported).toContain('<MY_CNTY:2>LA');
    expect(exported).toContain('<MY_IOTA:6>AS-007');
    expect(exported).toContain('<NOTES:11>Manual note');
    expect(exported).toContain('<OPERATOR:6>BG2XYZ');
    expect(exported).not.toContain('<NOTE:11>Manual note');
    expect(exported).not.toContain('<STATE:2>CA');

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
    expect(qsos[0].remarks).toBe('Manual note');
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
    expect(qsos[0].remarks).toBe('Manual note');

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
      messages: [],
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
      messages: [],
    }, 'op1');

    const sameBand = await provider.analyzeCallsign('BG9ZZ', 'PM01BB', { operatorId: 'op1', band: '20m' });
    const otherBand = await provider.analyzeCallsign('BG9ZZ', 'PM01BB', { operatorId: 'op1', band: '40m' });

    expect(sameBand.isNewGrid).toBe(false);
    expect(otherBand.isNewGrid).toBe(true);

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
      messages: [],
    }, 'op1');

    const after = await provider.analyzeCallsign('BG2AA', 'PM01AA', { operatorId: 'op1', band: '20m' });
    expect(after.isNewGrid).toBe(false);

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
      messages: [],
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
      messages: [],
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
      messages: [],
    }, 'op1');

    await provider.updateQSO('1710000000001', { remarks: 'rebuilt' });

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
      messages: [],
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
      messages: ['BG5DRB BG2AA RR73'],
    }, 'op1');

    const analysis = await provider.analyzeCallsign('BG9ZZ', undefined, { operatorId: 'op2', band: '20m' });

    expect(analysis.isNewCallsign).toBe(true);
    expect(analysis.isNewDxccEntity).toBe(false);
    expect(analysis.isNewBandDxccEntity).toBe(false);
    expect(analysis.isNewGrid).toBe(false);

    await provider.close();
  });
});
