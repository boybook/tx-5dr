import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@tx5dr/core';
import { useConnection } from '../store/radioStore';

type CWDecoderRunState = 'idle' | 'starting' | 'running' | 'stopping' | 'error' | 'unavailable';

export interface CWDecoderConfig {
  enabled?: boolean;
  backend?: string;
  model?: string;
  runtime?: string;
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

export interface CWDecoderSegment {
  id: string;
  text: string;
  confidence?: number;
  timestamp: number;
  raw?: unknown;
}

type CWDecoderApi = {
  getCWDecoderConfig?: () => Promise<{ config?: CWDecoderConfig } | CWDecoderConfig>;
  getCWDecoderBackends?: () => Promise<{ backends?: CWDecoderBackendInfo[] } | CWDecoderBackendInfo[]>;
  startCWDecoder?: () => Promise<{ status?: Partial<CWDecoderStatus> } | Partial<CWDecoderStatus> | void>;
  stopCWDecoder?: () => Promise<{ status?: Partial<CWDecoderStatus> } | Partial<CWDecoderStatus> | void>;
  clearCWDecoderTranscript?: () => Promise<{ status?: Partial<CWDecoderStatus> } | Partial<CWDecoderStatus> | void>;
  updateCWDecoderConfig?: (config: Partial<CWDecoderConfig>) => Promise<{ config?: CWDecoderConfig; status?: Partial<CWDecoderStatus> } | CWDecoderConfig>;
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
  segment?: { id?: string; text?: string; confidence?: number; timestamp?: number; startedAt?: number; updatedAt?: number; finalized?: boolean };
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

const MAX_CONFIRMED_SEGMENTS = 1000;

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

function normalizeSegment(payload: CWDecoderEventPayload, text: string): CWDecoderSegment {
  const segment = payload.segment;
  return {
    id: segment?.id ?? payload.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    text,
    confidence: segment?.confidence ?? payload.confidence,
    timestamp: segment?.timestamp ?? segment?.startedAt ?? segment?.updatedAt ?? payload.timestamp ?? Date.now(),
    raw: payload,
  };
}

export function useCWDecoder() {
  const connection = useConnection();
  const radioService = connection.state.radioService;
  const decoderApi = api as unknown as CWDecoderApi;
  const [config, setConfig] = useState<CWDecoderConfig | null>(null);
  const [backends, setBackends] = useState<CWDecoderBackendInfo[]>([]);
  const [status, setStatus] = useState<CWDecoderStatus>(DEFAULT_STATUS);
  const [pendingText, setPendingText] = useState('');
  const [confirmedSegments, setConfirmedSegments] = useState<CWDecoderSegment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suppressCommittedStatusRef = useRef(false);

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
      if (typeof payload.pendingText === 'string') {
        setPendingText(payload.pendingText);
      }
      if (typeof payload.committedText === 'string') {
        const committedText = payload.committedText.trim();
        if (!committedText) {
          setConfirmedSegments([]);
        } else if (!suppressCommittedStatusRef.current) {
          setConfirmedSegments(prev => (
            prev.length > 0 ? prev : [normalizeSegment({ kind: 'status', text: committedText }, committedText)]
          ));
        }
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
      const text = payload.segment?.text ?? payload.text ?? payload.pendingText ?? payload.partial ?? '';
      if (kind === 'partial' || kind === 'pending') {
        setPendingText(text);
        return;
      }
      if (kind === 'segment' || kind === 'confirmed' || kind === 'final' || kind === 'commit' || (kind === 'transcript' && payload.segment?.finalized)) {
        const trimmed = text.trim();
        if (trimmed) {
          suppressCommittedStatusRef.current = false;
          setConfirmedSegments(prev => [...prev, normalizeSegment(payload, trimmed)].slice(-MAX_CONFIRMED_SEGMENTS));
        }
        setPendingText('');
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

  const clearTranscript = useCallback(async () => {
    suppressCommittedStatusRef.current = true;
    setPendingText('');
    setConfirmedSegments([]);
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
    confirmedSegments
      .map(segment => segment.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  ), [confirmedSegments]);

  return {
    config,
    backends,
    effectiveBackend,
    status,
    pendingText,
    confirmedText,
    confirmedSegments,
    loading,
    error,
    reload: load,
    start,
    stop,
    updateConfig,
    clearTranscript,
  };
}
