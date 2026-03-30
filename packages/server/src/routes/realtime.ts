import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  UserRole,
  type RealtimeStatsRequest,
  type RealtimeSessionRequest,
  RealtimeStatsRequestSchema,
  RealtimeStatsResponseSchema,
  RealtimeSessionRequestSchema,
} from '@tx5dr/contracts';
import { AuthManager } from '../auth/AuthManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { OpenWebRXStationManager } from '../openwebrx/OpenWebRXStationManager.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { LiveKitConfig } from '../realtime/LiveKitConfig.js';
import { RealtimeTransportManager } from '../realtime/RealtimeTransportManager.js';
import { buildOpenWebRXPreviewRoomName, buildRadioRoomName } from '../realtime/room-names.js';

export async function realtimeRoutes(fastify: FastifyInstance): Promise<void> {
  const authManager = AuthManager.getInstance();
  const transportManager = RealtimeTransportManager.getInstance();
  const openWebRXStationManager = OpenWebRXStationManager.getInstance();
  const digitalRadioEngine = DigitalRadioEngine.getInstance();

  fastify.post('/session', async (request: FastifyRequest, reply) => {
    const body = RealtimeSessionRequestSchema.parse(request.body) as RealtimeSessionRequest;
    const authUser = request.authUser;

    if (body.scope === 'openwebrx-preview' && !body.previewSessionId) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'previewSessionId is required for OpenWebRX preview',
        userMessage: 'Preview session is missing',
      });
    }

    let role: UserRole;
    let tokenId: string | null = null;
    let operatorIds: string[] = [];
    let label: string | null = null;

    if (authUser) {
      role = authUser.role;
      tokenId = authUser.tokenId;
      operatorIds = authUser.operatorIds;
      label = authManager.getTokenById(authUser.tokenId)?.label || null;
    } else if (authManager.isAuthEnabled()) {
      if (!authManager.isPublicViewingAllowed() || body.direction === 'send' || body.scope !== 'radio') {
        return reply.code(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication is required',
          },
        });
      }
      role = UserRole.VIEWER;
    } else {
      role = UserRole.ADMIN;
      label = 'local admin';
    }

    let roomName: string;
    if (body.scope === 'radio') {
      roomName = buildRadioRoomName(ConfigManager.getInstance().getActiveProfileId());
    } else {
      const status = openWebRXStationManager.getListenStatus();
      if (!status?.isListening || status.previewSessionId !== body.previewSessionId) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_OPERATION,
          message: 'OpenWebRX preview session is not active',
          userMessage: 'OpenWebRX preview is no longer active',
        });
      }
      roomName = buildOpenWebRXPreviewRoomName(body.previewSessionId!);
    }

    const response = await transportManager.issueSession({
      roomName,
      scope: body.scope,
      direction: body.direction,
      publicLiveKitUrl: LiveKitConfig.resolvePublicWsUrl(request),
      role,
      tokenId,
      operatorIds,
      label,
      clientKind: request.headers['user-agent']?.includes('Electron') ? 'electron' : 'web',
      previewSessionId: body.previewSessionId,
      requestHeaders: request.headers,
      requestProtocol: request.protocol,
    });

    return reply.send(response);
  });

  fastify.get('/stats', async (request: FastifyRequest, reply) => {
    const query = RealtimeStatsRequestSchema.parse(request.query) as RealtimeStatsRequest;
    const authUser = request.authUser;

    if (query.scope === 'openwebrx-preview' && !query.previewSessionId) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'previewSessionId is required for OpenWebRX preview stats',
        userMessage: 'Preview session is missing',
      });
    }

    if (!authUser && authManager.isAuthEnabled()) {
      if (!authManager.isPublicViewingAllowed() || query.scope !== 'radio') {
        return reply.code(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication is required',
          },
        });
      }
    }

    let source = null;
    if (query.scope === 'radio') {
      source = digitalRadioEngine.getAudioMonitorService()?.getLatestStats() ?? null;
    } else {
      const status = openWebRXStationManager.getListenStatus();
      if (!status?.isListening || status.previewSessionId !== query.previewSessionId) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_OPERATION,
          message: 'OpenWebRX preview session is not active',
          userMessage: 'OpenWebRX preview is no longer active',
        });
      }
      source = openWebRXStationManager.getAudioMonitorService()?.getLatestStats() ?? null;
    }

    return reply.send(RealtimeStatsResponseSchema.parse({
      scope: query.scope,
      previewSessionId: query.previewSessionId ?? null,
      source,
      transport: transportManager.getPreferredTransport(query.scope, 'recv'),
    }));
  });
}
