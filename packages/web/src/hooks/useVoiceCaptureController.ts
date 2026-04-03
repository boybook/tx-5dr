import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineMode, RealtimeTransportKind } from '@tx5dr/contracts';
import type { RadioService } from '../services/radioService';
import { VoiceCapture, type VoiceCaptureState } from '../audio/VoiceCapture';
import { createLogger } from '../utils/logger';
import { presentRealtimeConnectivityFailure } from '../realtime/realtimeConnectivity';

const logger = createLogger('useVoiceCaptureController');

export interface VoiceCaptureController {
  captureState: VoiceCaptureState;
  preferredTransport: RealtimeTransportKind;
  activeTransport: RealtimeTransportKind | null;
  participantIdentity: string | null;
  isPTTActive: boolean;
  getInputLevel: () => number;
  startFromGesture: () => Promise<string | null>;
  switchTransportFromGesture: (transport: RealtimeTransportKind) => Promise<void>;
  setPreferredTransport: (transport: RealtimeTransportKind) => void;
  setPTTActive: (active: boolean) => void;
  stop: () => void;
}

function resolveTransportOverride(
  preferredTransport: RealtimeTransportKind,
): RealtimeTransportKind | undefined {
  return preferredTransport === 'ws-compat' ? preferredTransport : undefined;
}

export function useVoiceCaptureController(
  radioService: RadioService | null,
  engineMode: EngineMode,
): VoiceCaptureController {
  const captureRef = useRef<VoiceCapture | null>(null);
  const preferredTransportRef = useRef<RealtimeTransportKind>('livekit');

  const [captureState, setCaptureState] = useState<VoiceCaptureState>('idle');
  const [preferredTransport, setPreferredTransportState] = useState<RealtimeTransportKind>('livekit');
  const [activeTransport, setActiveTransport] = useState<RealtimeTransportKind | null>(null);
  const [participantIdentity, setParticipantIdentity] = useState<string | null>(null);
  const [isPTTActive, setIsPTTActiveState] = useState(false);

  const syncFromCapture = useCallback(() => {
    const capture = captureRef.current;
    setCaptureState(capture?.captureState ?? 'idle');
    setActiveTransport(capture?.currentTransportKind ?? null);
    setParticipantIdentity(capture?.participantIdentity ?? null);
    setIsPTTActiveState(capture?.isPTTActive ?? false);
  }, []);

  const setPreferredTransport = useCallback((transport: RealtimeTransportKind) => {
    preferredTransportRef.current = transport;
    setPreferredTransportState(transport);
  }, []);

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

  useEffect(() => {
    if (!radioService || engineMode !== 'voice') {
      captureRef.current?.stop();
      captureRef.current = null;
      setCaptureState('idle');
      setActiveTransport(null);
      setParticipantIdentity(null);
      setIsPTTActiveState(false);
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
          ...(preferredTransportRef.current !== 'ws-compat'
            ? {
                onCompatFallbackConfirm: async () => {
                  await switchTransportFromGesture('ws-compat');
                },
              }
            : {}),
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
    };
  }, [engineMode, radioService, switchTransportFromGesture, syncFromCapture]);

  return useMemo(() => ({
    captureState,
    preferredTransport,
    activeTransport,
    participantIdentity,
    isPTTActive,
    getInputLevel,
    startFromGesture,
    switchTransportFromGesture,
    setPreferredTransport,
    setPTTActive,
    stop,
  }), [
    activeTransport,
    captureState,
    getInputLevel,
    isPTTActive,
    participantIdentity,
    preferredTransport,
    setPTTActive,
    setPreferredTransport,
    startFromGesture,
    stop,
    switchTransportFromGesture,
  ]);
}
