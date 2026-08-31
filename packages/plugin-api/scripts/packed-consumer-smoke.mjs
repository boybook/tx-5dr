import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'tx5dr-plugin-api-pack-'));
const stagingRoot = join(temporaryRoot, 'staging');
const tarballRoot = join(temporaryRoot, 'tarballs');
const consumerRoot = join(temporaryRoot, 'consumer');

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function localVersion(packageDirectory) {
  return JSON.parse(readFileSync(join(repoRoot, packageDirectory, 'package.json'), 'utf8')).version;
}

function stageAndPack(packageDirectory) {
  const source = join(repoRoot, packageDirectory);
  const destination = join(stagingRoot, packageDirectory);
  cpSync(source, destination, {
    recursive: true,
    filter(path) {
      return !path.includes(`${join('', 'node_modules')}`) && !path.endsWith('.tgz');
    },
  });
  const manifestPath = join(destination, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const localPackages = new Map([
    ['@tx5dr/contracts', localVersion('packages/contracts')],
    ['@tx5dr/core', localVersion('packages/core')],
    ['@tx5dr/plugin-api', localVersion('packages/plugin-api')],
  ]);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!manifest[field]) continue;
    for (const [name, version] of localPackages) {
      if (String(manifest[field][name] ?? '').startsWith('workspace:')) manifest[field][name] = version;
    }
  }
  delete manifest.devDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const output = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', tarballRoot],
    { cwd: destination, encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(output);
  return join(tarballRoot, filename);
}

try {
  mkdirSync(stagingRoot, { recursive: true });
  mkdirSync(tarballRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });
  const contracts = stageAndPack('packages/contracts');
  const core = stageAndPack('packages/core');
  const pluginApi = stageAndPack('packages/plugin-api');

  writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2));
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    contracts,
    core,
    pluginApi,
  ], consumerRoot);
  writeFileSync(join(consumerRoot, 'smoke.mjs'), `
import * as root from '@tx5dr/plugin-api';
import * as toolkit from '@tx5dr/plugin-api/toolkit';
import * as contest from '@tx5dr/plugin-api/contest';
import * as testing from '@tx5dr/plugin-api/testing';

const required = [
  [root.defineFT8Contest, 'root.defineFT8Contest'],
  [root.createContestQsoEnvelopeAdapter, 'root.createContestQsoEnvelopeAdapter'],
  [toolkit.buildCabrilloDocument, 'toolkit.buildCabrilloDocument'],
  [contest.composeFT8ContestPlugin, 'contest.composeFT8ContestPlugin'],
  [contest.createFT8ContestTestKit, 'contest.createFT8ContestTestKit'],
  [contest.createContestQsoEnvelopeAdapter, 'contest.createContestQsoEnvelopeAdapter'],
  [testing.createMockContext, 'testing.createMockContext'],
];
for (const [value, name] of required) {
  if (typeof value !== 'function') throw new Error('missing packed export: ' + name);
}
`);
  run(process.execPath, ['smoke.mjs'], consumerRoot);
  writeFileSync(join(consumerRoot, 'smoke.ts'), `
import type { StrategyRuntime } from '@tx5dr/plugin-api';
import {
  cabrilloSubmission,
  CONTEST_SESSION_PERMISSIONS,
  composeFT8ContestPlugin,
  createContestQsoEnvelopeAdapter,
  createFT8ContestTestKit,
  defaultContestSession,
  defineFT8Contest,
  distancePoints,
  fixedWeekendEdition,
  gridExchange,
  requireExchangeAndFinalAck,
  type ContestWorkbenchViewModel,
} from '@tx5dr/plugin-api/contest';
import { buildCabrilloDocument } from '@tx5dr/plugin-api/toolkit';
import { createMockContext } from '@tx5dr/plugin-api/testing';

const contest = defineFT8Contest({
  id: 'packed-consumer',
  rulesetVersion: '2026.1',
  edition: fixedWeekendEdition({
    id: '2026',
    startAt: '2026-01-03T00:00:00Z',
    endAt: '2026-01-04T00:00:00Z',
  }),
  bands: ['20M'],
  exchange: gridExchange(),
  completion: requireExchangeAndFinalAck(),
  scoring: distancePoints({ stepKm: 3000 }),
  submission: cabrilloSubmission({
    headers: () => [['CONTEST', 'PACKED-CONSUMER']],
    qsoLine: (qso) => 'QSO: ' + qso.callsign,
  }),
});
const plugin = composeFT8ContestPlugin({
  name: 'packed-consumer',
  version: '1.0.0',
  permissions: CONTEST_SESSION_PERMISSIONS,
  contest,
  session: defaultContestSession({
    create: () => ({ schemaVersion: 1, revision: 0 }),
  }),
  runtime: () => ({}) as StrategyRuntime,
});
const envelopeAdapter = createContestQsoEnvelopeAdapter(contest);
const envelope = envelopeAdapter.create({
  sent: { grid: 'PL04' },
  received: { grid: 'FN31' },
});
const viewModel: ContestWorkbenchViewModel = {
  schemaVersion: 1,
  contest: { id: contest.id, editionId: contest.edition.id, rulesetVersion: contest.rulesetVersion },
  health: { state: 'healthy', readable: true, writable: true, updatedAt: 1 },
  settings: { value: {}, valid: true, issues: [] },
  score: { claimedScore: 0, qsoPoints: 0, multiplierCount: 0 },
  qsos: [],
  review: { pendingCount: 0, issues: [] },
  import: { state: 'idle' },
  export: { formats: [] },
};
createFT8ContestTestKit(contest);
createMockContext();
buildCabrilloDocument({ headers: [], qsoLines: [] });
void plugin;
void viewModel;
void envelope;
`);
  writeFileSync(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['smoke.ts'],
  }, null, 2));
  run(process.execPath, [
    join(repoRoot, 'node_modules/typescript/bin/tsc'),
    '--project',
    join(consumerRoot, 'tsconfig.json'),
  ], consumerRoot);
  console.log('Packed @tx5dr/plugin-api consumer smoke passed.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
