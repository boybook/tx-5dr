import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseVersion } from '../resolve-release-identity.mjs';
import { resolveHostVersion } from '../host-version.mjs';
test('formal tag must match source version and cannot be a prerelease', () => {
  assert.equal(validateReleaseVersion('refs/tags/v1.0.0', '1.0.0'), 'v1.0.0');
  for (const tag of ['v1.0.1', 'v1.0.0-rc.1', '1.0.0', 'v01.0.0']) assert.throws(() => validateReleaseVersion(tag, '1.0.0'));
});
test('nightly derives its base from source and keeps commit identity', () => {
  assert.equal(resolveHostVersion({ sourceVersion: '1.0.1', channel: 'nightly', buildStamp: '202610241200', commit: 'abcdef123456' }), '1.0.1-nightly.202610241200+gabcdef1');
});
