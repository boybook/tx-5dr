import { randomUUID } from 'crypto';
import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk';
import type {
  RealtimeParticipantKind,
  RealtimeParticipantMetadata,
  RealtimeScope,
  RealtimeTokenResponse,
} from '@tx5dr/contracts';
import { UserRole, USER_ROLE_LEVEL } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { LiveKitConfig } from './LiveKitConfig.js';

const logger = createLogger('LiveKitAuth');

export interface IssueClientTokenParams {
  roomName: string;
  scope: RealtimeScope;
  publish: boolean;
  publicWsUrl?: string;
  role: UserRole;
  tokenId?: string | null;
  operatorIds?: string[];
  label?: string | null;
  clientKind: string;
  previewSessionId?: string;
}

export interface IssueBridgeTokenParams {
  roomName: string;
  scope: RealtimeScope;
  participantName: string;
  previewSessionId?: string;
}

function toParticipantName(label: string | null | undefined, role: UserRole): string {
  if (label && label.trim()) {
    return label.trim();
  }
  return role === UserRole.ADMIN ? 'Admin' : role;
}

function buildIdentity(prefix: string, stablePart: string): string {
  const safeStablePart = stablePart.replace(/[^a-zA-Z0-9:_-]/g, '-');
  return `${prefix}:${safeStablePart}:${randomUUID()}`;
}

export class LiveKitAuthService {
  private getConfig() {
    return LiveKitConfig.getConnectionConfig();
  }

  issueClientToken(params: IssueClientTokenParams): RealtimeTokenResponse {
    const config = this.getConfig();
    const participantKind: RealtimeParticipantKind = params.publish ? 'publisher' : 'listener';
    const participantName = toParticipantName(params.label, params.role);
    const participantIdentity = buildIdentity(
      params.clientKind,
      params.tokenId || params.role.toLowerCase(),
    );

    if (params.publish && USER_ROLE_LEVEL[params.role] < USER_ROLE_LEVEL[UserRole.OPERATOR]) {
      throw new Error('Operator role or above is required to publish audio');
    }

    const metadata: RealtimeParticipantMetadata = {
      role: params.role,
      tokenId: params.tokenId ?? null,
      operatorIds: params.operatorIds ?? [],
      clientKind: params.clientKind,
      participantKind,
      scope: params.scope,
      ...(params.previewSessionId ? { previewSessionId: params.previewSessionId } : {}),
    };

    const videoGrant: VideoGrant = {
      roomJoin: true,
      room: params.roomName,
      canSubscribe: true,
      canPublishData: false,
      ...(params.publish
        ? { canPublishSources: [TrackSource.MICROPHONE] }
        : { canPublish: false }),
    };

    const token = new AccessToken(config.apiKey, config.apiSecret, {
      identity: participantIdentity,
      name: participantName,
      metadata: JSON.stringify(metadata),
      ttl: '10m',
    });
    token.addGrant(videoGrant);

    logger.debug('Issuing LiveKit client token', {
      roomName: params.roomName,
      participantIdentity,
      participantKind,
      scope: params.scope,
      clientKind: params.clientKind,
    });

    return {
      url: params.publicWsUrl || config.publicWsUrl || config.wsUrl,
      roomName: params.roomName,
      token: '',
      participantIdentity,
      participantName,
      participantMetadata: metadata,
      connectivityHints: LiveKitConfig.getConnectivityHints(),
    };
  }

  async finalizeToken(response: RealtimeTokenResponse): Promise<RealtimeTokenResponse> {
    const config = this.getConfig();
    const token = new AccessToken(config.apiKey, config.apiSecret, {
      identity: response.participantIdentity,
      name: response.participantName,
      metadata: JSON.stringify(response.participantMetadata),
      ttl: '10m',
    });

    token.addGrant({
      roomJoin: true,
      room: response.roomName,
      canSubscribe: true,
      canPublishData: false,
      ...(response.participantMetadata.participantKind === 'publisher'
        ? { canPublishSources: [TrackSource.MICROPHONE] }
        : { canPublish: false }),
    });

    return {
      ...response,
      token: await token.toJwt(),
    };
  }

  async issueBridgeToken(params: IssueBridgeTokenParams): Promise<{ url: string; token: string; identity: string }> {
    const config = this.getConfig();
    const identity = buildIdentity('bridge', params.roomName);
    const metadata: RealtimeParticipantMetadata = {
      role: UserRole.ADMIN,
      tokenId: null,
      operatorIds: [],
      clientKind: 'server',
      participantKind: 'bridge',
      scope: params.scope,
      ...(params.previewSessionId ? { previewSessionId: params.previewSessionId } : {}),
    };

    const token = new AccessToken(config.apiKey, config.apiSecret, {
      identity,
      name: params.participantName,
      metadata: JSON.stringify(metadata),
      ttl: '10m',
    });
    token.addGrant({
      roomJoin: true,
      room: params.roomName,
      roomAdmin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });

    return {
      url: config.wsUrl,
      token: await token.toJwt(),
      identity,
    };
  }
}
