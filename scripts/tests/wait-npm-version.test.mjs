import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForNpmVersion } from '../wait-npm-version.mjs';

function fixture(responses) {
  let clock = 0;
  const requests = [];
  return { requests, options: {
    now: () => clock, pause: async ms => { clock += ms; }, timeoutMs: 20, intervalMs: 5,
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method ?? 'GET' });
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return new Response(next.body ? JSON.stringify(next.body) : null, { status: next.status });
    },
  } };
}
const metadata = { name: '@tx5dr/core', version: '2.6.0', dist: { tarball: 'https://registry.npmjs.org/core.tgz' } };

test('waits for version metadata and a downloadable archive', async () => {
  const f = fixture([{ status: 404 }, { status: 200, body: metadata }, { status: 404 }, { status: 200, body: metadata }, { status: 200 }]);
  assert.deepEqual(await waitForNpmVersion(metadata.name, metadata.version, f.options), metadata);
  assert.equal(f.requests.filter(r => r.method === 'HEAD').length, 2);
  assert.ok(f.requests[0].url.includes('%40tx5dr%2Fcore/2.6.0'));
});
test('fails within the bound when the exact version never appears', async () => {
  const f = fixture([{ status: 200, body: { ...metadata, version: '2.5.0' } }]);
  await assert.rejects(waitForNpmVersion(metadata.name, metadata.version, f.options), /Timed out.*identity mismatch/);
  assert.equal(f.requests.length, 4);
});
test('retries transient network failures without declaring a dependency ready', async () => {
  const f = fixture([new Error('connection reset'), { status: 200, body: metadata }, { status: 200 }]);
  await waitForNpmVersion(metadata.name, metadata.version, f.options);
  assert.equal(f.requests.length, 3);
});
test('reports registry authorization failure immediately', async () => {
  const f = fixture([{ status: 403 }]);
  await assert.rejects(waitForNpmVersion(metadata.name, metadata.version, f.options), /Registry access denied: 403/);
  assert.equal(f.requests.length, 1);
});
