import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRelease, touchesPackaging, validateReleaseVersion } from '../resolve-release-identity.mjs';
import { resolveHostVersion } from '../host-version.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js';
import { inflateRawSync } from 'node:zlib';
import { extractAppImageBlockmap } from '../extract-appimage-blockmap.mjs';

test('AppImage sidecar preserves the embedded blockmap size and package bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-appimage-map-'));
  try {
    const file = path.join(directory, 'TX-5DR-linux-x64.AppImage');
    await fs.writeFile(file, Buffer.alloc(256 * 1024, 37));
    const built = await buildBlockMap(file, 'deflate');
    const original = await fs.readFile(file);
    assert.equal(await extractAppImageBlockmap(file), built.blockMapSize);
    assert.deepEqual(await fs.readFile(file), original);
    const sidecar = await fs.readFile(`${file}.blockmap`);
    assert.equal(sidecar.length, built.blockMapSize);
    assert.equal(JSON.parse(inflateRawSync(sidecar)).version, '2');
    const output = path.join(directory, 'manifest.json');
    execFileSync(process.execPath, ['scripts/generate-oss-manifest.mjs',
      '--product', 'app', '--channel', 'release', '--tag', 'v1.0.1',
      '--version', '1.0.1', '--commit', 'a'.repeat(40), '--assets-dir', directory,
      '--published-at', '2026-11-04T08:00:00Z',
      '--base-url', 'https://dl.tx5dr.com', '--object-prefix', 'tx-5dr/app/builds/1.0.1',
      '--output', output]);
    const manifest = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(manifest.assets[0].auto_update.blockMapSize, built.blockMapSize);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('AppImage blockmap extraction rejects missing or corrupt embedded metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-appimage-map-invalid-'));
  try {
    const file = path.join(directory, 'invalid.AppImage');
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(10), Buffer.from([0, 0, 0, 20]), Buffer.from([1, 2, 3, 0, 0, 0, 3])]) {
      await fs.writeFile(file, bytes);
      await assert.rejects(extractAppImageBlockmap(file));
      await assert.rejects(fs.stat(`${file}.blockmap`), { code: 'ENOENT' });
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('formal tag must match source version and cannot be a prerelease', () => {
  assert.equal(validateReleaseVersion('refs/tags/v1.0.0', '1.0.0'), 'v1.0.0');
  for (const tag of ['v1.0.1', 'v1.0.0-rc.1', '1.0.0', 'v01.0.0']) assert.throws(() => validateReleaseVersion(tag, '1.0.0'));
});
test('branch pushes and pull requests verify without building or publishing', () => {
  const idle = { verify: true, build: false, smoke: false, publish: false };
  for (const eventName of ['push', 'pull_request']) {
    assert.deepEqual(planRelease({ eventName, isTag: false, isCurrentMain: true, packagingChanged: false }), idle);
    assert.deepEqual(planRelease({ eventName, isTag: false, isCurrentMain: true, packagingChanged: true }), { ...idle, smoke: true });
  }
});
test('scheduled nightly publishes only an unpublished current main commit', () => {
  const all = { verify: true, build: true, smoke: false, publish: true };
  const none = { verify: false, build: false, smoke: false, publish: false };
  assert.deepEqual(planRelease({ eventName: 'schedule', isCurrentMain: true, nightlyPublished: false }), all);
  assert.deepEqual(planRelease({ eventName: 'schedule', isCurrentMain: true, nightlyPublished: true }), none);
  assert.deepEqual(planRelease({ eventName: 'schedule', isCurrentMain: false, nightlyPublished: false }), none);
});
test('formal tags publish and manual runs publish only on request for main or a tag', () => {
  const built = { verify: true, build: true, smoke: false };
  assert.deepEqual(planRelease({ eventName: 'push', isTag: true }), { ...built, publish: true });
  assert.deepEqual(planRelease({ eventName: 'workflow_dispatch', isCurrentMain: true, publishRequested: false }), { ...built, publish: false });
  assert.deepEqual(planRelease({ eventName: 'workflow_dispatch', isCurrentMain: true, publishRequested: true }), { ...built, publish: true });
  assert.deepEqual(planRelease({ eventName: 'workflow_dispatch', isTag: true, publishRequested: true }), { ...built, publish: true });
  assert.deepEqual(planRelease({ eventName: 'workflow_dispatch', isCurrentMain: false, publishRequested: true }), { ...built, publish: false });
});
test('packaging inputs are recognised and ordinary source changes are not', () => {
  for (const file of ['yarn.lock', 'package.json', 'packages/server/package.json', 'scripts/package-linux.sh', '.github/workflows/release.yml', 'Dockerfile', 'linux/install.sh', 'electron-builder.config.cjs']) {
    assert.equal(touchesPackaging([file]), true, file);
  }
  assert.equal(touchesPackaging(['packages/server/src/index.ts', 'docs/README.md', 'AGENTS.md', 'packages/web/src/i18n/locales/ja/radio.json']), false);
  assert.equal(touchesPackaging([]), false);
});
test('nightly derives its base from source and keeps commit identity', () => {
  assert.equal(resolveHostVersion({ sourceVersion: '1.0.1', channel: 'nightly', buildStamp: '202610241200', commit: 'abcdef123456' }), '1.0.1-nightly.202610241200+gabcdef1');
});

test('nightly manifest and installer URLs preserve SemVer build metadata', async () => {
  const version = '1.0.0-nightly.202610250440+gb45ca66';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-manifest-url-'));
  try {
    const assets = path.join(directory, 'assets');
    await fs.mkdir(assets);
    const name = 'TX-5DR-nightly-server-linux-arm64.deb';
    await fs.writeFile(path.join(assets, name), 'manifest URL regression fixture');
    await fs.writeFile(path.join(assets, 'install-online.sh'), '#!/bin/bash\n');
    const output = path.join(directory, 'manifest.json');
    execFileSync(process.execPath, ['scripts/generate-oss-manifest.mjs',
      '--product', 'server', '--channel', 'nightly', '--tag', `build-${version}`,
      '--version', version, '--commit', 'b45ca66'.padEnd(40, '0'),
      '--published-at', '2026-10-25T04:40:00Z', '--assets-dir', assets,
      '--base-url', 'https://dl.tx5dr.com', '--object-prefix', `tx-5dr/server/builds/${version}`,
      '--github-base-url', 'https://github.com', '--github-object-prefix', `boybook/tx-5dr/releases/download/build-${version}`,
      '--output', output]);
    const manifest = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(manifest.latest_url_install_online, `${manifest.base_url}/install-online.sh`);
    for (const url of [manifest.base_url, manifest.assets[0].url, manifest.assets[0].url_github]) {
      assert.ok(url.includes('%2B'), url);
      assert.ok(!url.includes('+'), url);
      assert.ok(decodeURIComponent(new URL(url).pathname).includes(version));
    }
    const urls = execFileSync('bash', ['-c',
      'source linux/lib/common.sh; get_server_manifest_url; echo; get_server_github_manifest_url'], {
      encoding: 'utf8', env: { ...process.env, TX5DR_DOWNLOAD_BASE_URL: 'https://dl.tx5dr.com', TX5DR_UPDATE_CHANNEL: 'nightly', TX5DR_UPDATE_VERSION: version },
    }).trim().split('\n');
    assert.equal(urls[0], `${manifest.base_url}/latest.json`);
    assert.equal(urls[1], `https://github.com/boybook/tx-5dr/releases/download/build-${encodeURIComponent(version)}/server-manifest.json`);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
