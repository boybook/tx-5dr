import { ApiError } from '@tx5dr/core';
import { addToast } from '@heroui/toast';
import type {
  RealtimeConnectivityErrorCode,
  RealtimeConnectivityHints,
  RealtimeConnectivityIssue,
  RealtimeScope,
} from '@tx5dr/contracts';
import i18n from '../i18n';

type RealtimeErrorStage = RealtimeConnectivityIssue['stage'];
const REALTIME_TOAST_DEDUPE_WINDOW_MS = 4000;
const realtimeToastHistory = new Map<string, number>();
export const OPEN_REALTIME_COMPAT_FALLBACK_MODAL_EVENT = 'openRealtimeCompatFallbackModal';

export interface RealtimeCompatFallbackModalDetail {
  issue: RealtimeConnectivityIssue;
  onConfirm?: () => Promise<void>;
}

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

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'unknown error');
}

function shouldShowRealtimeToast(key: string): boolean {
  const now = Date.now();
  const previous = realtimeToastHistory.get(key);
  if (previous && (now - previous) < REALTIME_TOAST_DEDUPE_WINDOW_MS) {
    return false;
  }
  realtimeToastHistory.set(key, now);
  return true;
}

function showCompactRealtimeToast(options: {
  dedupeKey: string;
  title: string;
  description: string;
  color: 'warning' | 'danger';
  timeout: number;
}): void {
  if (!shouldShowRealtimeToast(options.dedupeKey)) {
    return;
  }

  addToast({
    title: options.title,
    description: options.description,
    color: options.color,
    timeout: options.timeout,
    hideCloseButton: false,
  });
}

function isNetworkStyleRealtimeIssue(code: RealtimeConnectivityErrorCode): boolean {
  return code === 'SIGNALING_UNREACHABLE'
    || code === 'PUBLIC_URL_MISCONFIGURED'
    || code === 'ICE_CONNECTION_FAILED'
    || code === 'NO_AUDIO_TRACK'
    || code === 'UNKNOWN_REALTIME_ERROR';
}

function getFallbackClue(issue: RealtimeConnectivityIssue): string {
  switch (issue.code) {
    case 'PUBLIC_URL_MISCONFIGURED':
      return i18n.t('radio:realtime.compatFallbackCluePublicUrl');
    case 'SIGNALING_UNREACHABLE':
      return i18n.t('radio:realtime.compatFallbackClueSignaling', {
        port: issue.context?.signalingPort || 'unknown',
      });
    case 'ICE_CONNECTION_FAILED':
      return i18n.t('radio:realtime.compatFallbackClueIce', {
        port: issue.context?.rtcTcpPort || 'unknown',
      });
    case 'NO_AUDIO_TRACK':
      return i18n.t('radio:realtime.compatFallbackClueNoTrack');
    case 'MEDIA_DEVICE_PERMISSION_DENIED':
      return i18n.t('radio:realtime.compatFallbackCluePermission');
    default:
      return i18n.t('radio:realtime.compatFallbackClueGeneric');
  }
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

export function showRealtimeFallbackActivatedToast(issue: RealtimeConnectivityIssue): void {
  const scopeLabel = getScopeLabel(issue.scope);
  showCompactRealtimeToast({
    dedupeKey: `realtime-fallback:${issue.scope}:${issue.code}`,
    title: i18n.t('radio:realtime.compatFallbackActivatedTitle', { scope: scopeLabel }),
    description: [
      i18n.t('radio:realtime.compatFallbackActivatedDescription', { scope: scopeLabel }),
      i18n.t('radio:realtime.compatFallbackClueLabel', { clue: getFallbackClue(issue) }),
    ].join('\n'),
    color: 'warning',
    timeout: 5000,
  });
}

export function showRealtimeConnectivityIssueToast(issue: RealtimeConnectivityIssue): void {
  const scopeLabel = getScopeLabel(issue.scope);
  const compatFallbackAttempted = issue.context?.compatFallbackAttempted === 'true';
  const descriptionLines = [issue.userMessage];

  if (compatFallbackAttempted) {
    descriptionLines.push(i18n.t('radio:realtime.compatFallbackFailed'));
  } else if (isNetworkStyleRealtimeIssue(issue.code)) {
    descriptionLines.push(i18n.t('radio:realtime.compactNetworkHint'));
  }

  showCompactRealtimeToast({
    dedupeKey: `realtime-issue:${issue.scope}:${issue.stage}:${issue.code}:${compatFallbackAttempted ? 'compat' : 'plain'}`,
    title: i18n.t('radio:realtime.connectionFailedTitle', { scope: scopeLabel }),
    description: descriptionLines.join('\n'),
    color: 'danger',
    timeout: 8000,
  });
}

export function openRealtimeCompatFallbackModal(detail: RealtimeCompatFallbackModalDetail): void {
  window.dispatchEvent(new CustomEvent<RealtimeCompatFallbackModalDetail>(
    OPEN_REALTIME_COMPAT_FALLBACK_MODAL_EVENT,
    { detail },
  ));
}
