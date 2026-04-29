import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  UserRole,
  type VoiceTxBufferPreference,
  type RealtimeAudioCodecCapabilities,
  type RealtimeAudioCodecPreference,
  type RealtimeStatsRequest,
  RealtimeStatsRequestSchema,
  RealtimeStatsResponseSchema,
  RealtimeSessionRequestSchema,
  RealtimeVoiceTxStatsResponseSchema,
} from '@tx5dr/contracts';
import { AuthManager } from '../auth/AuthManager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { OpenWebRXStationManager } from '../openwebrx/OpenWebRXStationManager.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { RealtimeTransportManager } from '../realtime/RealtimeTransportManager.js';

type ParsedRealtimeSessionRequest = {
  scope: 'radio' | 'openwebrx-preview';
  direction: 'recv' | 'send';
  previewSessionId?: string;
  transportOverride?: 'rtc-data-audio' | 'ws-compat';
  voiceTxBufferPreference?: VoiceTxBufferPreference;
  audioCodecPreference?: RealtimeAudioCodecPreference;
  audioCodecCapabilities?: RealtimeAudioCodecCapabilities;
};

export async function realtimeRoutes(fastify: FastifyInstance): Promise<void> {
  const authManager = AuthManager.getInstance();
  const transportManager = RealtimeTransportManager.getInstance();
  const openWebRXStationManager = OpenWebRXStationManager.getInstance();
  const digitalRadioEngine = DigitalRadioEngine.getInstance();

  fastify.post('/session', async (request: FastifyRequest, reply) => {
    const body = RealtimeSessionRequestSchema.parse(request.body) as ParsedRealtimeSessionRequest;
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

    if (body.scope === 'openwebrx-preview') {
      const status = openWebRXStationManager.getListenStatus();
      if (!status?.isListening || status.previewSessionId !== body.previewSessionId) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_OPERATION,
          message: 'OpenWebRX preview session is not active',
          userMessage: 'OpenWebRX preview is no longer active',
        });
      }
    }

    const response = await transportManager.issueSession({
      scope: body.scope,
      direction: body.direction,
      transportOverride: body.transportOverride,
      role,
      tokenId,
      operatorIds,
      label,
      clientKind: request.headers['user-agent']?.includes('Electron') ? 'electron' : 'web',
      previewSessionId: body.previewSessionId,
      requestHeaders: request.headers,
      requestProtocol: request.protocol,
      voiceTxBufferPreference: body.voiceTxBufferPreference,
      audioCodecPreference: body.audioCodecPreference,
      audioCodecCapabilities: body.audioCodecCapabilities,
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

    if (query.scope === 'openwebrx-preview') {
      const status = openWebRXStationManager.getListenStatus();
      if (!status?.isListening || status.previewSessionId !== query.previewSessionId) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_OPERATION,
          message: 'OpenWebRX preview session is not active',
          userMessage: 'OpenWebRX preview is no longer active',
        });
      }
    }

    return reply.send(RealtimeStatsResponseSchema.parse({
      scope: query.scope,
      previewSessionId: query.previewSessionId ?? null,
      source: transportManager.getSourceStats(query.scope, query.previewSessionId),
      transport: transportManager.getPreferredTransport(query.scope, 'recv'),
    }));
  });

  fastify.get('/tx-stats', async (_request: FastifyRequest, reply) => {
    const voiceSessionManager = digitalRadioEngine.getVoiceSessionManager();
    const snapshot = voiceSessionManager?.getTxDiagnosticsSnapshot();

    return reply.send(RealtimeVoiceTxStatsResponseSchema.parse(
      snapshot ?? {
        scope: 'radio',
        summary: {
          active: false,
          transport: null,
          bottleneckStage: null,
          startedAt: null,
          updatedAt: null,
          clientId: null,
          label: null,
        },
        transport: {
          receivedFrames: 0,
          sequenceGaps: 0,
          lastSequence: null,
          clientToServerMs: {
            current: null,
            rolling: null,
            peak: null,
          },
        },
        serverIngress: {
          frameIntervalMs: {
            current: null,
            rolling: null,
            peak: null,
          },
          queueDepthFrames: 0,
          queuedAudioMs: 0,
          droppedFrames: 0,
          staleDroppedFrames: 0,
          underrunCount: 0,
          plcFrames: 0,
          jitterTargetMs: 0,
        },
        serverOutput: {
          resampleMs: {
            current: null,
            rolling: null,
            peak: null,
          },
          queueWaitMs: {
            current: null,
            rolling: null,
            peak: null,
          },
          writeMs: {
            current: null,
            rolling: null,
            peak: null,
          },
          serverPipelineMs: {
            current: null,
            rolling: null,
            peak: null,
          },
          endToEndMs: {
            current: null,
            rolling: null,
            peak: null,
          },
          outputBufferedMs: {
            current: null,
            rolling: null,
            peak: null,
          },
          outputWriteIntervalMs: {
            current: null,
            rolling: null,
            peak: null,
          },
          outputSampleRate: null,
          outputBufferSize: null,
          writeFailures: 0,
        },
      },
    ));
  });
}
