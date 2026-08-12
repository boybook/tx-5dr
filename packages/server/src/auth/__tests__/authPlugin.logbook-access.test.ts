import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { UserRole } from '@tx5dr/contracts';

import { requireExistingLogbookAccess } from '../authPlugin.js';

function createManager() {
  const book = { id: 'logbook-N0CALL' };
  return {
    book,
    manager: {
      resolveLogBookId: (id: string) => id === book.id || id === 'N0CALL' ? book.id : null,
      getLogBook: (id: string) => id === book.id ? book : null,
      getOperatorIdsForLogBook: () => ['operator-owner'],
    },
  };
}

async function createApp(role: UserRole, operatorIds: string[]) {
  const { book, manager } = createManager();
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.decorateRequest('logBookInstance', undefined);
  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.authUser = { tokenId: 'test', role, operatorIds, iat: 0, exp: Number.MAX_SAFE_INTEGER };
  });
  app.get<{ Params: { id: string } }>('/logbooks/:id', {
    preHandler: [requireExistingLogbookAccess(manager as never)],
  }, async request => ({ id: request.logBookInstance?.id }));
  await app.ready();
  return { app, book };
}

describe('requireExistingLogbookAccess', () => {
  it('binds an existing logbook for its owner without creating one', async () => {
    const { app, book } = await createApp(UserRole.OPERATOR, ['operator-owner']);
    const response = await app.inject({ method: 'GET', url: '/logbooks/N0CALL' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: book.id });
    await app.close();
  });

  it('makes unknown and non-owned logbooks indistinguishable to operators', async () => {
    const { app } = await createApp(UserRole.OPERATOR, ['operator-other']);
    const forbidden = await app.inject({ method: 'GET', url: '/logbooks/logbook-N0CALL' });
    const unknown = await app.inject({ method: 'GET', url: '/logbooks/logbook-UNKNOWN' });
    expect(forbidden.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(forbidden.json()).toEqual(unknown.json());
    await app.close();
  });

  it('rejects encoded separators and traversal-shaped ids before resolution', async () => {
    const { app } = await createApp(UserRole.ADMIN, []);
    for (const id of ['..', 'logbook%2FN0CALL', 'logbook%5CN0CALL']) {
      const response = await app.inject({ method: 'GET', url: `/logbooks/${id}` });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });
});
