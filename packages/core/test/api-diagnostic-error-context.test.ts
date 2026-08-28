import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { api, ApiError } from '../src/api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('diagnostic API errors include the safe client request URL and method', async () => {
  globalThis.fetch = async () => Response.json({
    success: false,
    error: {
      code: 'DIAGNOSTIC_SERVICE_UNAVAILABLE',
      message: 'gateway failed',
      userMessage: 'try again',
      severity: 'error',
      context: {
        errorId: 'error-1',
        downstreamRequestUrl: 'https://gateway.example.test/v1/diagnostics/authorize',
      },
    },
  }, { status: 503 });

  await assert.rejects(
    api.uploadDiagnosticLogs({ sourceId: 'server', fromMs: 1, toMs: 2 }, 'https://radio.example.test/api'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.context?.clientRequestUrl, 'https://radio.example.test/api/diagnostics/uploads');
      assert.equal(error.context?.requestMethod, 'POST');
      assert.equal(error.context?.errorId, 'error-1');
      assert.equal(error.context?.downstreamRequestUrl, 'https://gateway.example.test/v1/diagnostics/authorize');
      return true;
    },
  );
});
