import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertStationPlugins, assertRestoredQsos, createWorkbenchQsoReader, readCallsignQsos } from '../lib/station-test-support.mjs';

const strategy = { name: 'selected', version: '1.0.0', type: 'strategy', loaded: true, enabled: true, assignedOperatorIds: ['op'] };
const provider = { name: 'peer', version: '1.0.0', type: 'strategy', loaded: true, enabled: true };
const request = { strategy: strategy.name, provider: provider.name, operatorId: 'op' };

test('missing requested strategy fails even if the Host has a working fallback', () => {
  assert.throws(() => assertStationPlugins({ plugins: [provider] }, { currentStrategy: 'standard-qso' }, request), /not loaded and enabled: selected/);
});
test('checks actual strategy type and assignment, not just presence in config', () => {
  for (const invalid of [{ ...strategy, type: 'utility' }, { ...strategy, assignedOperatorIds: [] }]) {
    assert.throws(() => assertStationPlugins({ plugins: [invalid, provider] }, { currentStrategy: 'selected' }, request), /not assigned/);
  }
  assert.throws(() => assertStationPlugins({ plugins: [strategy, provider] }, { currentStrategy: 'standard-qso' }, request), /actual strategy: standard-qso/);
});
test('disabled, unloaded and auto-disabled selected strategies cannot pass', () => {
  for (const patch of [{ enabled: false }, { loaded: false }, { autoDisabled: true }]) {
    assert.throws(() => assertStationPlugins({ plugins: [{ ...strategy, ...patch }, provider] }, { currentStrategy: 'selected' }, request), /not loaded and enabled: selected/);
  }
});
test('a loaded scenario provider need not replace or activate the station strategy', () => {
  assert.equal(assertStationPlugins({ plugins: [strategy, { ...provider, enabled: false }] }, { currentStrategy: 'selected' }, request).length, 2);
  assert.throws(() => assertStationPlugins({ plugins: [strategy, { ...provider, loaded: false }] }, { currentStrategy: 'selected' }, request), /not loaded and enabled: peer/);
});
test('requires additional utility plugins to be active and records exact versions', () => {
  const ui = { name: 'monitor', type: 'utility', version: '2.0.0', loaded: true, enabled: true };
  const options = { ...request, plugins: ['monitor'] };
  assert.deepEqual(assertStationPlugins({ plugins: [strategy, provider, ui] }, { currentStrategy: 'selected' }, options), [strategy, provider, ui]);
  assert.throws(() => assertStationPlugins({ plugins: [strategy, provider] }, { currentStrategy: 'selected' }, options), /monitor/);
});
test('ordinary QSO assertions continue using the normal logbook API', async () => {
  const paths = [];
  const qsos = await readCallsignQsos(async route => {
    paths.push(route);
    return route === '/api/logbooks' ? { data: [{ id: 'logbook-CALL' }] } : { data: [{ id: 'q1', callsign: 'JA1AAA', mode: 'FT8' }] };
  });
  assert.deepEqual(paths, ['/api/logbooks', '/api/logbooks/logbook-CALL/qsos']);
  assert.deepEqual(qsos, [{ id: 'q1', callsign: 'JA1AAA' }]);
});

function workbench(options = {}) {
  let opens = 0;
  const requests = [];
  const plugin = { name: 'contest', instanceScope: 'operator', ui: { pages: [{ id: 'log', entry: 'contest-log.html', resourceBinding: 'operator' }] } };
  const context = { plugin, pageId: 'log', operatorId: 'op', callsign: 'BG5DRB',
    readPage: async route => {
      requests.push(route);
      return `<script>window.__TX5DR_PAGE_SESSION_ID__=${JSON.stringify(`session-${++opens}`)};</script>`;
    },
    api: async (route, body) => {
      requests.push({ route, body });
      return { result: { schemaVersion: 1, health: { readable: true }, qsos: [{ id: 'q1', callsign: 'JA1AAA' }] } };
    }, ...options,
  };
  return { context, requests, read: createWorkbenchQsoReader(context) };
}

test('plugin QSO assertions read the public view through a normally bound page session', async () => {
  const { read, requests } = workbench();
  assert.deepEqual(await read(), [{ id: 'q1', callsign: 'JA1AAA' }]);
  await read();
  assert.equal(requests[0], '/api/plugins/contest/ui/contest-log.html?operatorId=op');
  assert.deepEqual(requests[1], { route: '/api/plugins/contest/ui-invoke', body: {
    pageId: 'log', pageSessionId: 'session-1', action: 'get-state', data: { operatorId: 'op' },
  } });
  assert.equal(requests.filter(item => typeof item === 'string').length, 1);
});
test('restart establishes a fresh page session and reads recovered plugin rows', async () => {
  const { context, read, requests } = workbench();
  const before = await read();
  const after = await createWorkbenchQsoReader(context)();
  assertRestoredQsos(before, after);
  assert.equal(requests[3].body.pageSessionId, 'session-2');
});
test('global callsign-bound pages retain their scope', async () => {
  const { read, requests } = workbench({ plugin: { name: 'contest', instanceScope: 'global', ui: { pages: [{ id: 'log', entry: 'log.html', resourceBinding: 'callsign' }] } } });
  await read();
  assert.equal(requests[0], '/api/plugins/contest/ui/log.html?callsign=BG5DRB');
  assert.deepEqual(requests[1].body.data, { callsign: 'BG5DRB' });
});
test('missing page or invalid workbench data fails explicitly', async () => {
  assert.throws(() => workbench({ pageId: 'missing' }), /no declared page/);
  for (const result of [{}, { schemaVersion: 1, health: { readable: true }, qsos: [{ callsign: 'JA1AAA' }] }]) {
    const { read } = workbench({ api: async () => ({ result }) });
    await assert.rejects(read, /contract|id and callsign/);
  }
});
test('page revocation and unreadable logbooks fail instead of falling back to a different source', async () => {
  const { read } = workbench({ api: async () => { throw new Error('401 Page session is invalid or expired'); } });
  await assert.rejects(read, /401/);
  const unreadable = workbench({ api: async () => ({ result: { schemaVersion: 1, health: { readable: false, state: 'degraded' }, qsos: [] } }) });
  await assert.rejects(unreadable.read, /not readable: degraded/);
});
test('opening plugin logbooks do not supply premature persistence evidence', async () => {
  const opening = workbench({ api: async () => ({ result: { schemaVersion: 1, health: { readable: false, state: 'opening' }, qsos: [] } }) });
  assert.deepEqual(await opening.read(), []);
});
test('restart comparison rejects lost or changed records', () => {
  const before = [{ id: 'q1', callsign: 'JA1AAA' }];
  assert.throws(() => assertRestoredQsos(before, []), /did not survive/);
  assert.throws(() => assertRestoredQsos(before, [{ id: 'q1', callsign: 'JA2BBB' }]), /did not survive/);
});
