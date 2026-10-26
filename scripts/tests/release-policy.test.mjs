import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseVersion } from '../resolve-release-identity.mjs';
import { resolveHostVersion } from '../host-version.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('formal tag must match source version and cannot be a prerelease', () => {
  assert.equal(validateReleaseVersion('refs/tags/v1.0.0', '1.0.0'), 'v1.0.0');
  for (const tag of ['v1.0.1', 'v1.0.0-rc.1', '1.0.0', 'v01.0.0']) assert.throws(() => validateReleaseVersion(tag, '1.0.0'));
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
