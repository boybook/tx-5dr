import test from 'node:test';
import assert from 'node:assert/strict';

import { api, configureApi, configureAuthToken } from '../src/api.js';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function installFetchMock(): { calls: FetchCall[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      configureApi('/api');
      configureAuthToken(null);
    },
  };
}

test('encodes slash-containing logbook and QSO IDs when updating a QSO', async () => {
  const { calls, restore } = installFetchMock();
  try {
    await api.updateQSO(
      'BG5/ABC',
      'A/B_20260101_120000',
      { callsign: 'A/B' },
      '/api',
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/logbooks/BG5%2FABC/qsos/A%2FB_20260101_120000');
    assert.equal(calls[0].init?.method, 'PUT');
  } finally {
    restore();
  }
});

test('encodes slash-containing logbook and QSO IDs when deleting a QSO', async () => {
  const { calls, restore } = installFetchMock();
  try {
    await api.deleteQSO('BG5/ABC', 'A/B_20260101_120000', '/api');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/logbooks/BG5%2FABC/qsos/A%2FB_20260101_120000');
    assert.equal(calls[0].init?.method, 'DELETE');
  } finally {
    restore();
  }
});

test('encodes slash-containing logbook IDs when querying QSOs', async () => {
  const { calls, restore } = installFetchMock();
  try {
    await api.getLogBookQSOs('BG5/ABC', { limit: 25, offset: 0 }, '/api');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/logbooks/BG5%2FABC/qsos?limit=25&offset=0');
  } finally {
    restore();
  }
});
