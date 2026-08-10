import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { installApiErrorHandler } from '../server.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

describe('logbook HTTP error mapping', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  function createErrorApp(error: RadioError) {
    const app = Fastify({ logger: false });
    apps.push(app);
    installApiErrorHandler(app);
    app.post('/logbook-operation', async () => {
      throw error;
    });
    return app;
  }

  it.each([
    RadioErrorCode.LOGBOOK_LOADING,
    RadioErrorCode.LOGBOOK_READ_ONLY,
    RadioErrorCode.LOGBOOK_UNAVAILABLE,
    RadioErrorCode.LOGBOOK_WRITE_STATE_UNCERTAIN,
  ])('maps %s to HTTP 503 without disguising the operation as missing', async (code) => {
    const app = createErrorApp(new RadioError({ code, message: 'not writable' }));

    const response = await app.inject({ method: 'POST', url: '/logbook-operation' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code },
    });
  });

  it('maps an ENOSPC durability failure to HTTP 507', async () => {
    const app = createErrorApp(new RadioError({
      code: RadioErrorCode.LOGBOOK_WRITE_FAILED,
      message: 'disk full',
      context: { systemCode: 'ENOSPC' },
    }));

    const response = await app.inject({ method: 'POST', url: '/logbook-operation' });

    expect(response.statusCode).toBe(507);
    expect(response.json()).toMatchObject({
      success: false,
      error: {
        code: RadioErrorCode.LOGBOOK_WRITE_FAILED,
        context: { systemCode: 'ENOSPC' },
      },
    });
  });
});
