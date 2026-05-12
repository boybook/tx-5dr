import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { api } from '@tx5dr/core';
import { useConnection } from '../store/radioStore';
import {
  EMPTY_CW_DECODER_TRANSCRIPT,
  cwDecoderTranscriptReducer,
  deriveCWDecoderConfirmedText,
  type CWDecoderPendingSegment,
  type CWDecoderTranscriptSegment,
} from './cwDecoderTranscript';

type CWDecoderRunState = 'idle' | 'starting' | 'running' | 'stopping' | 'error' | 'unavailable';

export interface CWDecoderConfig {
  enabled?: boolean;
  backend?: string;
  model?: string;
  runtime?: string;
  targetFreqHz?: number;
  filterWidthHz?: number;
  [key: string]: unknown;
}

export interface CWDecoderBackendInfo {
  id: string;
  label?: string;
  model?: string;
  runtime?: string;
  available?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface CWDecoderStatus {
  enabled: boolean;
  running: boolean;
  state: CWDecoderRunState;
  backend?: string;
  model?: string;
  runtime?: string;
  lastError?: string | null;
  updatedAt?: number;
  [key: string]: unknown;
}

type CWDecoderApi = {
  getCWDecoderConfig?: () => Promise<{ config?: CWDecoderConfig } | CWDecoderConfig>;
  getCWDecoderBackends?: () => Promise<{ backends?: CWDecoderBackendInfo[] } | CWDecoderBackendInfo[]>;
  startCWDecoder?: () => Promise<{ status?: Partial<CWDecoderStatus> } | Partial<CWDecoderStatus> | void>;
  stopCWDecoder?: () => Promise<{ status?: Partial<CWDecoderStatus> } | Partial<CWDecoderStatus> | void>;
  clearCWDecoderTranscript?: () => Promise<{ status?: Partial<CWDecoderStatus> } | Partial<CWDecoderStatus> | void>;
  updateCWDecoderConfig?: (config: Partial<CWDecoderConfig>) => Promise<{ config?: CWDecoderConfig; status?: Partial<CWDecoderStatus> } | CWDecoderConfig>;
  updateCWDecoderTuning?: (config: Pick<Partial<CWDecoderConfig>, 'targetFreqHz' | 'filterWidthHz'>) => Promise<{ status?: Partial<CWDecoderStatus> } | Partial<CWDecoderStatus> | void>;
};

type CWDecoderStatusPayload = Omit<Partial<CWDecoderStatus>, 'backend'> & {
  active?: boolean;
  isRunning?: boolean;
  error?: string | null;
  backend?: string | { id?: string; name?: string };
  config?: CWDecoderConfig;
  pendingText?: string;
  committedText?: string;
};

type CWDecoderEventPayload = {
  kind?: string;
  type?: string;
  text?: string;
  pendingText?: string;
  partial?: string;
  pending?: Record<string, unknown> | null;
  segment?: Record<string, unknown>;
  confidence?: number;
  timestamp?: number;
  id?: string;
  [key: string]: unknown;
};

const DEFAULT_STATUS: CWDecoderStatus = {
  enabled: false,
  running: false,
  state: 'idle',
  lastError: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function unwrapConfig(response: { config?: CWDecoderConfig } | CWDecoderConfig): CWDecoderConfig {
  return isRecord(response) && isRecord(response.config) ? response.config : response;
}

function unwrapBackends(response: { backends?: CWDecoderBackendInfo[] } | CWDecoderBackendInfo[]): CWDecoderBackendInfo[] {
  if (Array.isArray(response)) return response;
  return Array.isArray(response.backends) ? response.backends : [];
}

function unwrapStatus(response: { status?: Partial<CWDecoderStatus> } | Partial<CWDecoderStatus> | void): Partial<CWDecoderStatus> | null {
  if (!response) return null;
  return isRecord(response) && isRecord(response.status) ? response.status : response;
}

function readBackendId(backend: CWDecoderStatusPayload['backend']): string | undefined {
  if (typeof backend === 'string') return backend;
  if (!isRecord(backend)) return undefined;
  return typeof backend.id === 'string' ? backend.id : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeStatus(payload: CWDecoderStatusPayload, previous: CWDecoderStatus): CWDecoderStatus {
  const rawState = String(payload.state ?? previous.state ?? 'idle');
  const explicitRunning = payload.running ?? payload.active ?? payload.isRunning;
  const derivedRunning = rawState === 'listening' || rawState === 'decoding' || rawState === 'muted';
  const running = Boolean(explicitRunning ?? derivedRunning);
  const state = (rawState === 'disabled'
    ? 'idle'
    : rawState === 'listening' || rawState === 'decoding'
      ? 'running'
      : rawState) as CWDecoderRunState;
  const backend = readBackendId(payload.backend) ?? previous.backend;
  const statusConfig = isRecord(payload.config) ? payload.config : undefined;
  const hasLastError = Object.prototype.hasOwnProperty.call(payload, 'lastError');
  const hasError = Object.prototype.hasOwnProperty.call(payload, 'error');
  const lastError = state === 'idle'
    ? null
    : hasLastError
      ? stringValue(payload.lastError) ?? null
      : hasError
        ? stringValue(payload.error) ?? null
        : previous.lastError ?? null;
  return {
    ...previous,
    backend,
    model: stringValue(payload.model) ?? String(statusConfig?.modelSize ?? previous.model ?? ''),
    runtime: stringValue(payload.runtime) ?? String(statusConfig?.runtimeBackend ?? previous.runtime ?? ''),
    enabled: Boolean(payload.enabled ?? running ?? previous.enabled),
    running,
    state,
    lastError,
    updatedAt: typeof payload.updatedAt === 'number' ? payload.updatedAt : Date.now(),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeStructuredPending(value: unknown): CWDecoderPendingSegment | null {
  if (!isRecord(value)) return null;
  const sessionId = stringValue(value.sessionId);
  const version = numberValue(value.version);
  const text = stringValue(value.text);
  if (!sessionId || version == null || text == null) return null;
  return {
    sessionId,
    version,
    text,
    plainText: stringValue(value.plainText),
    finalized: false,
    confidence: numberValue(value.confidence),
    targetFreqHz: numberValue(value.targetFreqHz),
    filterWidthHz: numberValue(value.filterWidthHz),
    characterSpans: Array.isArray(value.characterSpans) ? value.characterSpans : undefined,
    wordSpaceSpans: Array.isArray(value.wordSpaceSpans) ? value.wordSpaceSpans : undefined,
    updatedAt: numberValue(value.updatedAt) ?? Date.now(),
    raw: value,
  };
}

function normalizeStructuredSegment(value: unknown, fallback: CWDecoderEventPayload): CWDecoderTranscriptSegment | null {
  if (!isRecord(value)) return null;
  const sessionId = stringValue(value.sessionId);
  const text = stringValue(value.text);
  if (!sessionId || text == null) return null;
  const timestamp = numberValue(value.updatedAt) ?? numberValue(fallback.timestamp) ?? Date.now();
  return {
    id: stringValue(value.id) ?? `${sessionId}-${timestamp}`,
    sessionId,
    sequence: numberValue(value.sequence) ?? 0,
    text,
    plainText: stringValue(value.plainText),
    finalized: true,
    prependSpace: typeof value.prependSpace === 'boolean' ? value.prependSpace : true,
    confidence: numberValue(value.confidence) ?? numberValue(fallback.confidence),
    targetFreqHz: numberValue(value.targetFreqHz),
    filterWidthHz: numberValue(value.filterWidthHz),
    characterSpans: Array.isArray(value.characterSpans) ? value.characterSpans : undefined,
    wordSpaceSpans: Array.isArray(value.wordSpaceSpans) ? value.wordSpaceSpans : undefined,
    startedAt: numberValue(value.startedAt),
    endedAt: numberValue(value.endedAt),
    updatedAt: timestamp,
    raw: fallback,
  };
}

function useCWDecoderController() {
  const connection = useConnection();
  const radioService = connection.state.radioService;
  const decoderApi = api as unknown as CWDecoderApi;
  const [config, setConfig] = useState<CWDecoderConfig | null>(null);
  const [backends, setBackends] = useState<CWDecoderBackendInfo[]>([]);
  const [status, setStatus] = useState<CWDecoderStatus>(DEFAULT_STATUS);
  const [transcript, dispatchTranscript] = useReducer(cwDecoderTranscriptReducer, EMPTY_CW_DECODER_TRANSCRIPT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configResponse, backendsResponse] = await Promise.all([
        decoderApi.getCWDecoderConfig?.(),
        decoderApi.getCWDecoderBackends?.(),
      ]);
      if (configResponse) {
        const nextConfig = unwrapConfig(configResponse);
        setConfig(nextConfig);
        setStatus(prev => normalizeStatus({
          enabled: nextConfig.enabled,
          backend: nextConfig.backend,
          model: nextConfig.model,
          runtime: nextConfig.runtime,
        }, prev));
      }
      if (backendsResponse) {
        setBackends(unwrapBackends(backendsResponse));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [decoderApi]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!radioService) return;
    const wsClient = radioService.wsClientInstance;
    const handleStatus = (payload: CWDecoderStatusPayload) => {
      setStatus(prev => normalizeStatus(payload, prev));
      if (typeof payload.pendingText === 'string' || typeof payload.committedText === 'string') {
        dispatchTranscript({
          type: 'status_text',
          pendingText: payload.pendingText,
          committedText: payload.committedText,
          timestamp: typeof payload.updatedAt === 'number' ? payload.updatedAt : Date.now(),
        });
      }
      const backendId = readBackendId(payload.backend);
      const payloadConfig = isRecord(payload.config) ? payload.config as CWDecoderConfig : {};
      setConfig(prev => ({
        ...(prev ?? {}),
        ...payloadConfig,
        backend: backendId ?? payloadConfig.backend ?? prev?.backend,
        model: stringValue(payload.model) ?? prev?.model,
        runtime: stringValue(payload.runtime) ?? prev?.runtime,
        enabled: typeof payload.enabled === 'boolean' ? payload.enabled : prev?.enabled,
      }));
    };
    const handleEvent = (payload: CWDecoderEventPayload) => {
      const kind = payload.type ?? String(payload.kind ?? 'partial');
      if (kind === 'transcript_reset') {
        const sessionId = stringValue(payload.sessionId);
        if (sessionId) {
          dispatchTranscript({ type: 'reset', sessionId, timestamp: payload.timestamp });
        }
        return;
      }
      if (kind === 'transcript_pending') {
        dispatchTranscript({
          type: 'pending',
          pending: payload.pending == null ? null : normalizeStructuredPending(payload.pending),
          timestamp: payload.timestamp,
        });
        return;
      }
      if (kind === 'transcript_commit' || kind === 'transcript') {
        const segment = normalizeStructuredSegment(payload.segment, payload);
        if (segment) {
          dispatchTranscript({ type: 'commit', segment, timestamp: payload.timestamp });
        }
        return;
      }

      const text = stringValue(payload.text)
        ?? stringValue(payload.pendingText)
        ?? stringValue(payload.partial)
        ?? (isRecord(payload.segment) ? stringValue(payload.segment.text) : undefined)
        ?? '';
      if (kind === 'partial' || kind === 'pending') {
        dispatchTranscript({
          type: 'legacy_pending',
          text,
          confidence: payload.confidence,
          timestamp: payload.timestamp,
          raw: payload,
        });
        return;
      }
      if (kind === 'segment' || kind === 'confirmed' || kind === 'final' || kind === 'commit') {
        const trimmed = text.trim();
        if (trimmed) {
          dispatchTranscript({
            type: 'legacy_commit',
            segment: normalizeStructuredSegment(payload.segment, payload) ?? undefined,
            text: trimmed,
            confidence: payload.confidence,
            timestamp: payload.timestamp,
            raw: payload,
          });
        }
      }
    };

    wsClient.onWSEvent('cwDecoderStatusChanged' as never, handleStatus as never);
    wsClient.onWSEvent('cwDecoderEvent' as never, handleEvent as never);
    return () => {
      wsClient.offWSEvent('cwDecoderStatusChanged' as never, handleStatus as never);
      wsClient.offWSEvent('cwDecoderEvent' as never, handleEvent as never);
    };
  }, [radioService]);

  const start = useCallback(async () => {
    setError(null);
    setStatus(prev => ({ ...prev, enabled: true, state: 'starting' }));
    try {
      const response = await decoderApi.startCWDecoder?.();
      const nextStatus = unwrapStatus(response);
      if (nextStatus) setStatus(prev => normalizeStatus(nextStatus, prev));
      if (!decoderApi.startCWDecoder && radioService?.isConnected) {
        radioService.wsClientInstance.send('cwDecoderStart' as never);
      }
    } catch (err) {
      setError(String(err));
      setStatus(prev => ({ ...prev, state: 'error', lastError: String(err) }));
    }
  }, [decoderApi, radioService]);

  const stop = useCallback(async () => {
    setError(null);
    setStatus(prev => ({ ...prev, state: 'stopping' }));
    try {
      const response = await decoderApi.stopCWDecoder?.();
      const nextStatus = unwrapStatus(response);
      if (nextStatus) setStatus(prev => normalizeStatus(nextStatus, prev));
      if (!decoderApi.stopCWDecoder && radioService?.isConnected) {
        radioService.wsClientInstance.send('cwDecoderStop' as never);
      }
      setStatus(prev => ({ ...prev, enabled: false, running: false, state: 'idle' }));
    } catch (err) {
      setError(String(err));
      setStatus(prev => ({ ...prev, state: 'error', lastError: String(err) }));
    }
  }, [decoderApi, radioService]);

  const updateConfig = useCallback(async (patch: Partial<CWDecoderConfig>) => {
    setError(null);
    setConfig(prev => ({ ...(prev ?? {}), ...patch }));
    try {
      const response = await decoderApi.updateCWDecoderConfig?.(patch);
      if (response) {
        const responseRecord = response as { config?: CWDecoderConfig; status?: Partial<CWDecoderStatus> };
        if (responseRecord.config) {
          setConfig(responseRecord.config);
        } else if (!responseRecord.status) {
          setConfig(unwrapConfig(response as CWDecoderConfig));
        }
        const responseStatus = responseRecord.status;
        if (responseStatus) setStatus(prev => normalizeStatus(responseStatus, prev));
      } else if (radioService?.isConnected) {
        radioService.wsClientInstance.send('cwDecoderUpdateConfig' as never, patch as never);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [decoderApi, radioService]);

  const tuneRuntime = useCallback(async (patch: Pick<Partial<CWDecoderConfig>, 'targetFreqHz' | 'filterWidthHz'>) => {
    setError(null);
    setConfig(prev => ({ ...(prev ?? {}), ...patch }));
    try {
      const response = await decoderApi.updateCWDecoderTuning?.(patch);
      const nextStatus = unwrapStatus(response);
      if (nextStatus) {
        setStatus(prev => normalizeStatus(nextStatus, prev));
        const statusConfig = isRecord((nextStatus as CWDecoderStatusPayload).config)
          ? (nextStatus as CWDecoderStatusPayload).config as CWDecoderConfig
          : null;
        if (statusConfig) {
          setConfig(prev => ({ ...(prev ?? {}), ...statusConfig }));
        }
      }
    } catch (err) {
      setError(String(err));
    }
  }, [decoderApi]);

  const clearTranscript = useCallback(async () => {
    dispatchTranscript({ type: 'clear', timestamp: Date.now() });
    setError(null);
    try {
      const response = await decoderApi.clearCWDecoderTranscript?.();
      const nextStatus = unwrapStatus(response);
      if (nextStatus) setStatus(prev => normalizeStatus(nextStatus, prev));
      if (!decoderApi.clearCWDecoderTranscript && radioService?.isConnected) {
        radioService.wsClientInstance.send('cwDecoderClear' as never);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [decoderApi, radioService]);

  const effectiveBackend = useMemo(() => {
    const backendId = status.backend ?? config?.backend;
    return backends.find(item => item.id === backendId) ?? null;
  }, [backends, config?.backend, status.backend]);

  const confirmedText = useMemo(() => (
    deriveCWDecoderConfirmedText(transcript.segments)
  ), [transcript.segments]);
  const pendingText = transcript.pending?.text ?? '';

  return {
    config,
    backends,
    effectiveBackend,
    status,
    pendingText,
    confirmedText,
    confirmedSegments: transcript.segments,
    loading,
    error,
    reload: load,
    start,
    stop,
    updateConfig,
    tuneRuntime,
    clearTranscript,
  };
}

export type CWDecoderContextValue = ReturnType<typeof useCWDecoderController>;

const CWDecoderContext = createContext<CWDecoderContextValue | null>(null);

export function CWDecoderProvider({ children }: { children: ReactNode }) {
  const value = useCWDecoderController();
  return createElement(CWDecoderContext.Provider, { value }, children);
}

export function useCWDecoder(): CWDecoderContextValue {
  const context = useContext(CWDecoderContext);
  if (!context) {
    throw new Error('useCWDecoder must be used within CWDecoderProvider');
  }
  return context;
}
