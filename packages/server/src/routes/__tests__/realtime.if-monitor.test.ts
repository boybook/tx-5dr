import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadioError } from '../../utils/errors/RadioError.js';

const {
  state,
  mockIssueSession,
  mockIsSourceAvailable,
} = vi.hoisted(() => ({
  state: {
    previewSessionId: 'preview-1',
  },
  mockIssueSession: vi.fn(async (params: { scope: string; direction: string }) => ({
    scope: params.scope,
    direction: params.direction,
    offers: [],
  })),
  mockIsSourceAvailable: vi.fn(() => true),
}));

vi.mock('../../auth/AuthManager.js', () => ({
  AuthManager: {
    getInstance: () => ({
      isAuthEnabled: () => false,
      isPublicViewingAllowed: () => true,
      getTokenById: () => null,
    }),
  },
}));

vi.mock('../../realtime/RealtimeTransportManager.js', () => ({
  RealtimeTransportManager: {
    getInstance: () => ({
      issueSession: mockIssueSession,
      isSourceAvailable: mockIsSourceAvailable,
      getSourceStats: () => null,
      getPreferredTransport: () => 'ws-compat',
    }),
  },
}));

vi.mock('../../openwebrx/OpenWebRXStationManager.js', () => ({
  OpenWebRXStationManager: {
    getInstance: () => ({
      getListenStatus: () => ({
        isListening: true,
        previewSessionId: state.previewSessionId,
      }),
    }),
  },
}));

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({ getVoiceSessionManager: () => null }),
  },
}));

describe('realtime IF monitor availability', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsSourceAvailable.mockReturnValue(true);

    const { realtimeRoutes } = await import('../realtime.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof RadioError) {
        return reply.code(400).send({ code: error.code, message: error.userMessage });
      }
      return reply.send(error);
    });
    await fastify.register(realtimeRoutes, { prefix: '/api/realtime' });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('rejects a radio receive session before issuing transport offers when IF monitoring is unavailable', async () => {
    mockIsSourceAvailable.mockReturnValue(false);

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/realtime/session',
      payload: { scope: 'radio', direction: 'recv' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(mockIssueSession).not.toHaveBeenCalled();
  });

  it('does not block radio send or OpenWebRX preview receive sessions', async () => {
    mockIsSourceAvailable.mockReturnValue(false);

    const radioSend = await fastify.inject({
      method: 'POST',
      url: '/api/realtime/session',
      payload: { scope: 'radio', direction: 'send' },
    });
    const previewReceive = await fastify.inject({
      method: 'POST',
      url: '/api/realtime/session',
      payload: {
        scope: 'openwebrx-preview',
        direction: 'recv',
        previewSessionId: state.previewSessionId,
      },
    });

    expect(radioSend.statusCode).toBe(200);
    expect(previewReceive.statusCode).toBe(200);
    expect(mockIssueSession).toHaveBeenCalledTimes(2);
  });
});
