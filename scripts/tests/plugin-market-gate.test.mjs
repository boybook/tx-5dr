import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPluginMarketIndexAvailable } from '../plugin-market-gate.mjs';

const reader = (response) => async () => response;

test('accepts a populated schema v3 marketplace index', async () => {
  assert.equal(await assertPluginMarketIndexAvailable('https://x/index.json', reader({
    status: 200, value: { schemaVersion: 3, plugins: [{ name: 'a' }] },
  })), 1);
});

test('rejects a missing, legacy or empty marketplace index', async () => {
  await assert.rejects(assertPluginMarketIndexAvailable('u', reader({ status: 404 })), /HTTP 404/);
  await assert.rejects(assertPluginMarketIndexAvailable('u', reader({
    status: 200, value: { schemaVersion: 2, channel: 'nightly', plugins: [{}] },
  })), /schema v3/);
  await assert.rejects(assertPluginMarketIndexAvailable('u', reader({
    status: 200, value: { schemaVersion: 3, plugins: [] },
  })), /schema v3/);
});
