import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const cli = join(packageRoot, 'dist/index.js');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'tx5dr-ft8-contest-template-'));

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

try {
  run(process.execPath, [cli, 'smoke-contest', '--template', 'ft8-contest'], temporaryRoot);
  const projectRoot = join(temporaryRoot, 'smoke-contest');
  const generatedPackage = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  if (generatedPackage.tx5drPlugin?.entry !== 'dist/index.mjs'
      || generatedPackage.tx5drPlugin?.minPluginApiVersion !== '2.4.0'
      || !generatedPackage.tx5drPlugin?.include?.some((item) => item.from === 'ui')) {
    throw new Error('ft8-contest scaffold did not emit Marketplace packaging metadata');
  }
  if (!existsSync(join(projectRoot, 'README.md')) || !existsSync(join(projectRoot, 'ui/contest-log.html'))) {
    throw new Error('ft8-contest scaffold did not emit Marketplace documentation and UI assets');
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
  run('npm', ['run', 'build'], projectRoot);
  run('npm', ['test'], projectRoot);

  const bundle = join(projectRoot, 'dist/index.mjs');
  const declarations = join(projectRoot, 'dist/index.d.ts');
  if (!existsSync(bundle) || !existsSync(declarations)) {
    throw new Error('ft8-contest build did not emit its bundle and declarations');
  }

  const isolatedRoot = join(temporaryRoot, 'isolated-no-node-modules');
  mkdirSync(isolatedRoot);
  const isolatedBundle = join(isolatedRoot, 'index.mjs');
  cpSync(bundle, isolatedBundle);
  const loaded = await import(pathToFileURL(isolatedBundle).href);
  if (loaded.default?.name !== 'smoke-contest') {
    throw new Error('isolated FT8 contest bundle did not export the generated plugin');
  }
  if (loaded.default?.minPluginApiVersion !== '2.4.0') {
    throw new Error('isolated FT8 contest bundle did not preserve the Plugin API version floor');
  }
  try {
    loaded.default.createStrategyRuntime({});
    throw new Error('isolated FT8 contest bundle accepted an old Host context');
  } catch (error) {
    if (!String(error).includes('PLUGIN_API_VERSION_UNSUPPORTED')) throw error;
  }

  for (const flags of [['--type', 'utility'], ['--lang', 'js']]) {
    const result = spawnSync(
      process.execPath,
      [cli, 'invalid-contest', '--template', 'ft8-contest', ...flags],
      { cwd: temporaryRoot, encoding: 'utf8' },
    );
    if (result.status === 0 || !result.stderr.includes('ft8-contest template requires')) {
      throw new Error(`ft8-contest accepted conflicting flags: ${flags.join(' ')}`);
    }
  }
  console.log('FT8 contest scaffold smoke passed.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
