#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = resolve(repoRoot, 'packages/core');

const DEFAULT_CSV_URL = 'https://www.country-files.com/bigcty/cty.csv';
const DEFAULT_DAT_URL = 'https://www.country-files.com/bigcty/download/cty.dat';
const DEFAULT_CSV_OUT = resolve(coreRoot, 'src/callsign/cty.csv');
const DEFAULT_DAT_OUT = resolve(coreRoot, 'src/callsign/cty.dat');
const DEFAULT_DATA_TS_OUT = resolve(coreRoot, 'src/callsign/cty-data.ts');

function getArg(name, fallback) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'tx-5dr-cty-sync/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function renderDataModule(csvText) {
  return `/* eslint-disable */\n// Generated from BigCTY cty.csv by scripts/sync-cty-data.mjs.\n// Keep this module as a raw-data bridge for browser bundles and tests.\n\nconst ctyCsvText = ${JSON.stringify(csvText)};\n\nexport default ctyCsvText;\n`;
}

async function writeTextFile(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function runSmoke({ includeDat }) {
  const smokeSource = `
    import ctyCsvText from './src/callsign/cty-data.ts';
    import { CtyIndex, parseCTYDat, parseCTYCsv } from './src/callsign/cty.ts';
    import { readFileSync } from 'node:fs';

    const parsed = parseCTYCsv(ctyCsvText);
    const index = new CtyIndex(parsed);
    const cases = [
      ['TA6B', 'Asiatic Turkey', 390],
      ['TA1ABC', 'European Turkey', 390],
      ['JW5E', 'Svalbard', 259],
      ['GM0ABC', 'Scotland', 279],
      ['IK5ABC', 'Italy', 248],
      ['IS0ABC', 'Sardinia', 225],
      ['4U1ITU', 'ITU HQ', 117],
      ['W1AW/MM', null, null],
      ['KG4ABC', 'United States', 291],
      ['KG4AA', 'Guantanamo Bay', 105],
    ];
    for (const [call, expectedName, expectedCode] of cases) {
      const record = index.lookup(call);
      if (expectedName === null) {
        if (record !== null) throw new Error(call + ' should resolve to null');
        continue;
      }
      if (!record) throw new Error(call + ' did not resolve');
      if (record.entityName !== expectedName || record.entityCode !== expectedCode) {
        throw new Error(call + ' resolved to ' + record.entityName + '/' + record.entityCode + ', expected ' + expectedName + '/' + expectedCode);
      }
    }
    if (${includeDat ? 'true' : 'false'}) {
      const datText = readFileSync('./src/callsign/cty.dat', 'utf8');
      const datParsed = parseCTYDat(datText);
      if (!datParsed.rows.length) throw new Error('cty.dat parsed zero rows');
    }
    if (parsed.duplicateKeys.length) {
      console.warn('[sync-cty] duplicate token keys (first wins): ' + parsed.duplicateKeys.slice(0, 20).join(', ') + (parsed.duplicateKeys.length > 20 ? ' ...' : ''));
    }
    console.log('[sync-cty] smoke ok: version=' + (parsed.version ?? 'unknown') + ', rows=' + parsed.rows.length + ', duplicateKeys=' + parsed.duplicateKeys.length);
  `;

  const result = spawnSync('yarn', ['exec', 'tsx', '-e', smokeSource], {
    cwd: coreRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`CTY smoke failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function main() {
  const csvUrl = getArg('--csv-url', DEFAULT_CSV_URL);
  const datUrl = getArg('--dat-url', DEFAULT_DAT_URL);
  const csvOut = resolve(repoRoot, getArg('--csv-out', DEFAULT_CSV_OUT));
  const datOut = resolve(repoRoot, getArg('--dat-out', DEFAULT_DAT_OUT));
  const dataTsOut = resolve(repoRoot, getArg('--data-ts-out', DEFAULT_DATA_TS_OUT));
  const includeDat = hasFlag('--with-dat');
  const skipSmoke = hasFlag('--skip-smoke');

  console.log(`[sync-cty] downloading ${csvUrl}`);
  const csvText = await fetchText(csvUrl);
  await writeTextFile(csvOut, csvText);
  await writeTextFile(dataTsOut, renderDataModule(csvText));
  console.log(`[sync-cty] wrote ${csvOut}`);
  console.log(`[sync-cty] wrote ${dataTsOut}`);

  if (includeDat) {
    console.log(`[sync-cty] downloading ${datUrl}`);
    const datText = await fetchText(datUrl);
    await writeTextFile(datOut, datText);
    console.log(`[sync-cty] wrote ${datOut}`);
  }

  if (!skipSmoke) {
    runSmoke({ includeDat });
  }
}

main().catch((error) => {
  console.error(`[sync-cty] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
