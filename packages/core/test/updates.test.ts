import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareUpdateVersions, updateOperation, releaseIdentity } from '../src/updates.js';
test('SemVer precedence includes prerelease numbers and ignores build metadata', () => {
  assert.equal(compareUpdateVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareUpdateVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareUpdateVersions('1.0.0-nightly.202610240000+gabc', '1.0.0-nightly.202610240000+gdef'), 0);
});
test('both channel directions are offered, but same-channel old versions are not', () => {
  assert.equal(updateOperation({ channel: 'release', version: '1.0.0' }, { channel: 'nightly', version: '1.0.0-nightly.1', commit: 'abcdef1' }), 'downgrade');
  assert.equal(updateOperation({ channel: 'nightly', version: '1.0.1-nightly.1' }, { channel: 'release', version: '1.0.0', commit: 'abcdef1' }), 'downgrade');
  assert.equal(updateOperation({ channel: 'nightly', version: '1.0.0-nightly.1' }, { channel: 'release', version: '1.0.0', commit: 'abcdef1' }), 'switch');
  assert.equal(updateOperation({ channel: 'release', version: '1.0.1' }, { channel: 'release', version: '1.0.0', commit: 'abcdef1' }), 'none');
});
test('notification identities cannot collide across channels or products', () => {
  const base = { product: 'app' as const, channel: 'release' as const, version: '1.0.0', commit: 'abcdef1' };
  assert.notEqual(releaseIdentity(base), releaseIdentity({ ...base, channel: 'nightly' }));
});

test('download source fallback stays in channel and rejects a mismatched product', async () => {
  const { fetchChannelManifest, EmptyReleaseChannelError } = await import('../src/updates.js');
  const previous = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (url: string) => { calls.push(url); return { ok: false, status: 404 }; }) as typeof fetch;
    await assert.rejects(fetchChannelManifest('app', 'release'), EmptyReleaseChannelError);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => !url.includes('nightly')));
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ product: 'server', channel: 'release', tag: 'v1.0.0', version: '1.0.0', commit: 'abcdef1', published_at: '2026-10-24', assets: [] }) })) as typeof fetch;
    await assert.rejects(fetchChannelManifest('app', 'release'), /target_mismatch/);
  } finally { globalThis.fetch = previous; }
});
