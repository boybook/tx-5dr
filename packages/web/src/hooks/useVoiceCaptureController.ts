import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  resolveVoiceTxBufferPolicy,
  VoiceTxBufferPreferenceSchema,
  type EngineMode,
  type RealtimeAudioCodecPreference,
  type RealtimeTransportKind,
  type ResolvedRealtimeAudioCodecPolicy,
  type ResolvedVoiceTxBufferPolicy,
  type VoiceTxBufferPreference,
} from '@tx5dr/contracts';
import type { RadioService } from '../services/radioService';
import { VoiceCapture, type VoiceCaptureState } from '../audio/VoiceCapture';
import { createLogger } from '../utils/logger';
import { presentRealtimeConnectivityFailure } from '../realtime/realtimeConnectivity';
import type { VoiceTxLocalDiagnostics } from '../audio/voiceTxDiagnostics';
import {
  loadRealtimeAudioCodecPreference,
  saveRealtimeAudioCodecPreference,
} from '../audio/realtimeAudioCodec';

const logger = createLogger('useVoiceCaptureController');
const VOICE_TX_BUFFER_PREFERENCE_STORAGE_KEY = 'tx5dr.voiceTx.bufferPreference';
const DEFAULT_VOICE_TX_BUFFER_PREFERENCE: VoiceTxBufferPreference = { profile: 'balanced' };

export interface VoiceCaptureController {
  captureState: VoiceCaptureState;
  preferredTransport: RealtimeTransportKind;
  activeTransport: RealtimeTransportKind | null;
  participantIdentity: string | null;
  isPTTActive: boolean;
  txBufferPreference: VoiceTxBufferPreference;
  resolvedTxBufferPolicy: ResolvedVoiceTxBufferPolicy;
  activeTxBufferPolicy: ResolvedVoiceTxBufferPolicy | null;
  audioCodecPreference: RealtimeAudioCodecPreference;
  activeAudioCodecPolicy: ResolvedRealtimeAudioCodecPolicy | null;
  getInputLevel: () => number;
  getDiagnostics: () => VoiceTxLocalDiagnostics | null;
  startFromGesture: () => Promise<string | null>;
  switchTransportFromGesture: (transport: RealtimeTransportKind) => Promise<void>;
  setPreferredTransport: (transport: RealtimeTransportKind) => void;
  setTxBufferPreference: (preference: VoiceTxBufferPreference) => void;
  setAudioCodecPreference: (preference: RealtimeAudioCodecPreference) => void;
  setPTTActive: (active: boolean) => void;
  stop: () => void;
}

function resolveTransportOverride(
  preferredTransport: RealtimeTransportKind,
): RealtimeTransportKind | undefined {
  return preferredTransport === 'ws-compat' ? preferredTransport : undefined;
}

function loadTxBufferPreference(): VoiceTxBufferPreference {
  if (typeof window === 'undefined') {
    return DEFAULT_VOICE_TX_BUFFER_PREFERENCE;
  }
  try {
    const raw = window.localStorage.getItem(VOICE_TX_BUFFER_PREFERENCE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_VOICE_TX_BUFFER_PREFERENCE;
    }
    const parsed = VoiceTxBufferPreferenceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_VOICE_TX_BUFFER_PREFERENCE;
  } catch {
    return DEFAULT_VOICE_TX_BUFFER_PREFERENCE;
  }
}

function saveTxBufferPreference(preference: VoiceTxBufferPreference): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(VOICE_TX_BUFFER_PREFERENCE_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // ignore storage failures
  }
}

export function useVoiceCaptureController(
  radioService: RadioService | null,
  engineMode: EngineMode,
): VoiceCaptureController {
  const captureRef = useRef<VoiceCapture | null>(null);
  const preferredTransportRef = useRef<RealtimeTransportKind>('rtc-data-audio');
  const txBufferPreferenceRef = useRef<VoiceTxBufferPreference>(loadTxBufferPreference());
  const audioCodecPreferenceRef = useRef<RealtimeAudioCodecPreference>(loadRealtimeAudioCodecPreference());

  const [captureState, setCaptureState] = useState<VoiceCaptureState>('idle');
  const [preferredTransport, setPreferredTransportState] = useState<RealtimeTransportKind>('rtc-data-audio');
  const [activeTransport, setActiveTransport] = useState<RealtimeTransportKind | null>(null);
  const [participantIdentity, setParticipantIdentity] = useState<string | null>(null);
  const [isPTTActive, setIsPTTActiveState] = useState(false);
  const [txBufferPreference, setTxBufferPreferenceState] = useState<VoiceTxBufferPreference>(() => txBufferPreferenceRef.current);
  const [activeTxBufferPolicy, setActiveTxBufferPolicy] = useState<ResolvedVoiceTxBufferPolicy | null>(null);
  const [audioCodecPreference, setAudioCodecPreferenceState] = useState<RealtimeAudioCodecPreference>(() => audioCodecPreferenceRef.current);
  const [activeAudioCodecPolicy, setActiveAudioCodecPolicy] = useState<ResolvedRealtimeAudioCodecPolicy | null>(null);

  const syncFromCapture = useCallback(() => {
    const capture = captureRef.current;
    setCaptureState(capture?.captureState ?? 'idle');
    setActiveTransport(capture?.currentTransportKind ?? null);
    setParticipantIdentity(capture?.participantIdentity ?? null);
    setIsPTTActiveState(capture?.isPTTActive ?? false);
    setActiveTxBufferPolicy(capture?.currentTxBufferPolicy ?? null);
    setActiveAudioCodecPolicy(capture?.currentAudioCodecPolicy ?? null);
  }, []);

  const setPreferredTransport = useCallback((transport: RealtimeTransportKind) => {
    preferredTransportRef.current = transport;
    setPreferredTransportState(transport);
  }, []);

  const setTxBufferPreference = useCallback((preference: VoiceTxBufferPreference) => {
    const parsed = VoiceTxBufferPreferenceSchema.safeParse(preference);
    if (!parsed.success) {
      return;
    }
    txBufferPreferenceRef.current = parsed.data;
    setTxBufferPreferenceState(parsed.data);
    saveTxBufferPreference(parsed.data);

    const capture = captureRef.current;
    if (capture?.captureState === 'capturing' && !capture.isPTTActive) {
      capture.stop();
      syncFromCapture();
    }
  }, [syncFromCapture]);

  const setAudioCodecPreference = useCallback((preference: RealtimeAudioCodecPreference) => {
    if (preference !== 'auto' && preference !== 'opus' && preference !== 'pcm') {
      return;
    }
    audioCodecPreferenceRef.current = preference;
    setAudioCodecPreferenceState(preference);
    saveRealtimeAudioCodecPreference(preference);

    const capture = captureRef.current;
    if (capture?.captureState === 'capturing' && !capture.isPTTActive) {
      capture.stop();
      syncFromCapture();
    }
  }, [syncFromCapture]);

  const switchTransportFromGesture = useCallback(async (transport: RealtimeTransportKind) => {
    setPreferredTransport(transport);

    const capture = captureRef.current;
    if (!capture || capture.captureState !== 'capturing') {
      syncFromCapture();
      return;
    }

    await capture.switchTransportFromGesture(transport);
    syncFromCapture();
  }, [setPreferredTransport, syncFromCapture]);

  const startFromGesture = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) {
      throw new Error('Voice capture is unavailable');
    }

    await capture.startFromGesture({
      transportOverride: resolveTransportOverride(preferredTransportRef.current),
      voiceTxBufferPreference: txBufferPreferenceRef.current,
      audioCodecPreference: audioCodecPreferenceRef.current,
    });
    syncFromCapture();
    return capture.participantIdentity;
  }, [syncFromCapture]);

  const setPTTActive = useCallback((active: boolean) => {
    const capture = captureRef.current;
    capture?.setPTTActive(active);
    setIsPTTActiveState(active);
    syncFromCapture();
  }, [syncFromCapture]);

  const stop = useCallback(() => {
    captureRef.current?.stop();
    syncFromCapture();
  }, [syncFromCapture]);

  const getInputLevel = useCallback(() => {
    return captureRef.current?.inputLevel ?? 0;
  }, []);

  const getDiagnostics = useCallback(() => {
    return captureRef.current?.diagnostics ?? null;
  }, []);

  useEffect(() => {
    if (!radioService || engineMode !== 'voice') {
      captureRef.current?.stop();
      captureRef.current = null;
      setCaptureState('idle');
      setActiveTransport(null);
      setParticipantIdentity(null);
      setIsPTTActiveState(false);
      setActiveTxBufferPolicy(null);
      setActiveAudioCodecPolicy(null);
      return;
    }

    const capture = new VoiceCapture({
      onStateChange: () => {
        syncFromCapture();
      },
      onError: (error) => {
        logger.error('Voice capture controller observed an error', error);
        presentRealtimeConnectivityFailure(error, {
          scope: 'radio',
          stage: 'publish',
        });
      },
    });

    captureRef.current = capture;
    syncFromCapture();

    return () => {
      capture.stop();
      if (captureRef.current === capture) {
        captureRef.current = null;
      }
      setCaptureState('idle');
      setActiveTransport(null);
      setParticipantIdentity(null);
      setIsPTTActiveState(false);
      setActiveTxBufferPolicy(null);
      setActiveAudioCodecPolicy(null);
    };
  }, [engineMode, radioService, switchTransportFromGesture, syncFromCapture]);

  const resolvedTxBufferPolicy = useMemo(
    () => resolveVoiceTxBufferPolicy(txBufferPreference),
    [txBufferPreference],
  );

  return useMemo(() => ({
    captureState,
    preferredTransport,
    activeTransport,
    participantIdentity,
    isPTTActive,
    txBufferPreference,
    resolvedTxBufferPolicy,
    activeTxBufferPolicy,
    audioCodecPreference,
    activeAudioCodecPolicy,
    getInputLevel,
    getDiagnostics,
    startFromGesture,
    switchTransportFromGesture,
    setPreferredTransport,
    setTxBufferPreference,
    setAudioCodecPreference,
    setPTTActive,
    stop,
  }), [
    activeTransport,
    activeTxBufferPolicy,
    activeAudioCodecPolicy,
    captureState,
    getInputLevel,
    getDiagnostics,
    isPTTActive,
    participantIdentity,
    preferredTransport,
    audioCodecPreference,
    resolvedTxBufferPolicy,
    setPTTActive,
    setPreferredTransport,
    setTxBufferPreference,
    setAudioCodecPreference,
    startFromGesture,
    stop,
    switchTransportFromGesture,
    txBufferPreference,
  ]);
}
