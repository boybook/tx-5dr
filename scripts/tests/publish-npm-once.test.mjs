import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideNpmPublication, fetchPublishedIntegrity } from '../publish-npm-once.mjs';

const base = { name: '@tx5dr/core', version: '2.7.0' };

test('publishes a version the registry does not have', () => {
  assert.equal(decideNpmPublication({ ...base }), 'publish');
});

test('skips a version already published with identical contents', () => {
  assert.equal(decideNpmPublication({ ...base, publishedIntegrity: 'sha512-a', localIntegrity: 'sha512-a' }), 'skip');
});

test('refuses a version already published with different contents', () => {
  assert.throws(
    () => decideNpmPublication({ ...base, publishedIntegrity: 'sha512-a', localIntegrity: 'sha512-b' }),
    /already published with different contents/,
  );
});

test('reads the published integrity and treats 404 as unpublished', async () => {
  const respond = (status, body) => async () => new Response(body ? JSON.stringify(body) : null, { status });
  assert.equal(await fetchPublishedIntegrity(base.name, base.version, respond(404)), undefined);
  assert.equal(
    await fetchPublishedIntegrity(base.name, base.version, respond(200, { version: '2.7.0', dist: { integrity: 'sha512-a' } })),
    'sha512-a',
  );
  await assert.rejects(fetchPublishedIntegrity(base.name, base.version, respond(500)), /HTTP 500/);
});
