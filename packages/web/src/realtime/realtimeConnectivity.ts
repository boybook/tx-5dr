import { ApiError } from '@tx5dr/core';
import type {
  RealtimeConnectivityErrorCode,
  RealtimeConnectivityHints,
  RealtimeConnectivityIssue,
  RealtimeScope,
} from '@tx5dr/contracts';
import i18n from '../i18n';
import { showErrorToast } from '../utils/errorToast';

type RealtimeErrorStage = RealtimeConnectivityIssue['stage'];

export interface BuildRealtimeConnectivityIssueOptions {
  scope: RealtimeScope;
  stage: RealtimeErrorStage;
  hints?: RealtimeConnectivityHints;
}

export class RealtimeConnectivityError extends Error {
  readonly issue: RealtimeConnectivityIssue;

  constructor(issue: RealtimeConnectivityIssue) {
    super(issue.userMessage);
    this.name = 'RealtimeConnectivityError';
    this.issue = issue;
  }
}

function getScopeLabel(scope: RealtimeScope): string {
  return scope === 'radio'
    ? i18n.t('radio:realtime.scopeRadio')
    : i18n.t('radio:realtime.scopeOpenWebRX');
}

function openSystemSettings(): void {
  window.dispatchEvent(new CustomEvent('openSettingsModal', {
    detail: {
      tab: 'system',
    },
  }));
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'unknown error');
}

function toContextRecord(
  options: BuildRealtimeConnectivityIssueOptions,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const context: Record<string, string> = {
    scope: options.scope,
    stage: options.stage,
  };

  if (options.hints) {
    context.signalingUrl = options.hints.signalingUrl;
    context.signalingPort = String(options.hints.signalingPort);
    context.rtcTcpPort = String(options.hints.rtcTcpPort);
    context.udpPortRange = options.hints.udpPortRange;
    context.publicUrlOverrideActive = String(options.hints.publicUrlOverrideActive);
  }

  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string' && value.length > 0) {
      context[key] = value;
    }
  }

  return context;
}

function buildNetworkSuggestions(
  options: BuildRealtimeConnectivityIssueOptions,
  includeSettingsHint: boolean,
): string[] {
  const hints = options.hints;
  const suggestions: string[] = [];

  if (includeSettingsHint) {
    suggestions.push(i18n.t('radio:realtime.suggestionCheckPublicUrl'));
  }

  if (hints) {
    suggestions.push(i18n.t('radio:realtime.suggestionCheckSignalingPort', {
      port: hints.signalingPort,
    }));
    suggestions.push(i18n.t('radio:realtime.suggestionCheckRtcTcpPort', {
      port: hints.rtcTcpPort,
    }));
    suggestions.push(i18n.t('radio:realtime.suggestionCheckUdpRange', {
      range: hints.udpPortRange,
    }));
    suggestions.push(i18n.t('radio:realtime.suggestionCheckDirectUrl', {
      url: hints.signalingUrl,
    }));
  } else {
    suggestions.push(i18n.t('radio:realtime.suggestionCheckPublicUrl'));
    suggestions.push(i18n.t('radio:realtime.suggestionCheckGenericPorts'));
  }

  return suggestions;
}

function buildIssue(
  options: BuildRealtimeConnectivityIssueOptions,
  code: RealtimeConnectivityErrorCode,
  userMessage: string,
  suggestions: string[],
  technicalDetails: string,
  extraContext: Record<string, string | undefined> = {},
): RealtimeConnectivityIssue {
  return {
    code,
    scope: options.scope,
    stage: options.stage,
    userMessage,
    suggestions,
    technicalDetails,
    context: toContextRecord(options, extraContext),
  };
}

export function buildRealtimeConnectivityIssue(
  error: unknown,
  options: BuildRealtimeConnectivityIssueOptions,
): RealtimeConnectivityIssue {
  const message = normalizeErrorMessage(error);
  const lowerMessage = message.toLowerCase();
  const scopeLabel = getScopeLabel(options.scope);
  const hints = options.hints;
  const overrideActive = hints?.publicUrlOverrideActive ?? false;

  if (error instanceof RealtimeConnectivityError) {
    return error.issue;
  }

  if (error instanceof ApiError) {
    const apiSuggestions = error.suggestions?.length
      ? error.suggestions
      : [i18n.t('radio:realtime.suggestionRetryLater')];
    const apiCode = error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN'
      ? 'SESSION_EXPIRED_OR_INVALID'
      : 'TOKEN_REQUEST_FAILED';
    const userMessage = apiCode === 'SESSION_EXPIRED_OR_INVALID'
      ? i18n.t('radio:realtime.sessionExpired', { scope: scopeLabel })
      : i18n.t('radio:realtime.tokenRequestFailed', { scope: scopeLabel });
    return buildIssue(options, apiCode, userMessage, apiSuggestions, message, {
      apiCode: error.code,
    });
  }

  if (
    lowerMessage.includes('previewsessionid') ||
    lowerMessage.includes('openwebrx preview is no longer active') ||
    lowerMessage.includes('token has expired')
  ) {
    return buildIssue(
      options,
      'SESSION_EXPIRED_OR_INVALID',
      i18n.t('radio:realtime.sessionExpired', { scope: scopeLabel }),
      [i18n.t('radio:realtime.suggestionRetryLater')],
      message,
    );
  }

  if (
    lowerMessage.includes('notallowederror') ||
    lowerMessage.includes('permission denied') ||
    lowerMessage.includes('permission dismissed') ||
    lowerMessage.includes('microphone permission')
  ) {
    return buildIssue(
      options,
      'MEDIA_DEVICE_PERMISSION_DENIED',
      i18n.t('radio:realtime.mediaPermissionDenied'),
      [
        i18n.t('radio:realtime.suggestionAllowMicrophone'),
        i18n.t('radio:realtime.suggestionRetryLater'),
      ],
      message,
    );
  }

  if (
    lowerMessage.includes('autoplay') ||
    lowerMessage.includes('audio playback') ||
    lowerMessage.includes('play() failed')
  ) {
    return buildIssue(
      options,
      'AUDIO_PLAYBACK_BLOCKED',
      i18n.t('radio:realtime.audioPlaybackBlocked', { scope: scopeLabel }),
      [
        i18n.t('radio:realtime.suggestionInteractPage'),
        i18n.t('radio:realtime.suggestionRetryLater'),
      ],
      message,
    );
  }

  if (lowerMessage.includes('no bridge audio track')) {
    return buildIssue(
      options,
      'NO_AUDIO_TRACK',
      i18n.t('radio:realtime.noAudioTrack', { scope: scopeLabel }),
      buildNetworkSuggestions(options, overrideActive),
      message,
    );
  }

  if (
    lowerMessage.includes('websocket') ||
    lowerMessage.includes('signal') ||
    lowerMessage.includes('connection refused') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('dns') ||
    lowerMessage.includes('failed to fetch') ||
    lowerMessage.includes('networkerror')
  ) {
    const code = overrideActive ? 'PUBLIC_URL_MISCONFIGURED' : 'SIGNALING_UNREACHABLE';
    const userMessage = code === 'PUBLIC_URL_MISCONFIGURED'
      ? i18n.t('radio:realtime.publicUrlMisconfigured', { scope: scopeLabel })
      : i18n.t('radio:realtime.signalingUnreachable', { scope: scopeLabel });
    return buildIssue(
      options,
      code,
      userMessage,
      buildNetworkSuggestions(options, true),
      message,
    );
  }

  if (
    lowerMessage.includes('ice') ||
    lowerMessage.includes('candidate') ||
    lowerMessage.includes('transport') ||
    lowerMessage.includes('pc connection') ||
    lowerMessage.includes('could not establish') ||
    lowerMessage.includes('dtls')
  ) {
    return buildIssue(
      options,
      'ICE_CONNECTION_FAILED',
      i18n.t('radio:realtime.iceFailed', { scope: scopeLabel }),
      buildNetworkSuggestions(options, overrideActive),
      message,
    );
  }

  return buildIssue(
    options,
    'UNKNOWN_REALTIME_ERROR',
    i18n.t('radio:realtime.unknownFailure', { scope: scopeLabel }),
    buildNetworkSuggestions(options, overrideActive),
    message,
  );
}

export function toRealtimeConnectivityError(
  error: unknown,
  options: BuildRealtimeConnectivityIssueOptions,
): RealtimeConnectivityError {
  return new RealtimeConnectivityError(buildRealtimeConnectivityIssue(error, options));
}

export function showRealtimeConnectivityIssueToast(
  issue: RealtimeConnectivityIssue,
  options?: {
    onRetry?: () => void;
    includeSettingsAction?: boolean;
  },
): void {
  const actions: Array<{ label: string; handler: () => void }> = [];

  if (options?.onRetry) {
    actions.push({
      label: i18n.t('common:action.retry'),
      handler: options.onRetry,
    });
  }

  if (options?.includeSettingsAction !== false) {
    actions.push({
      label: i18n.t('common:action.goToSettings'),
      handler: openSystemSettings,
    });
  }

  showErrorToast({
    userMessage: issue.userMessage,
    suggestions: issue.suggestions,
    severity: 'critical',
    code: issue.code,
    technicalDetails: issue.technicalDetails,
    context: issue.context,
    actions,
  });
}
