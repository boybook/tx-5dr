import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useConnection, useRadioModeState, usePTTState } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { VoiceCapture } from '../../audio/VoiceCapture';
import {
  RealtimeConnectivityError,
  buildRealtimeConnectivityIssue,
  showRealtimeConnectivityIssueToast,
} from '../../realtime/realtimeConnectivity';

const logger = createLogger('VoicePTTButton');

type PTTState = 'idle' | 'requesting' | 'transmitting' | 'locked-by-other';

/**
 * Voice PTT Button Component
 *
 * Rectangular red card-style PTT button for voice mode.
 * Supports mouse, touch, and keyboard (Space) interactions.
 * Manages WakeLock and vibration feedback for mobile.
 */
export const VoicePTTButton: React.FC = () => {
  const { t } = useTranslation('voice');
  const connection = useConnection();
  const radioMode = useRadioModeState();
  const { voicePttLock } = usePTTState();
  const isOperator = useHasMinRole(UserRole.OPERATOR);

  const [pttState, setPttState] = useState<PTTState>('idle');
  const voiceCaptureRef = useRef<VoiceCapture | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const isPttDownRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const radioService = connection.state.radioService;

  // Derive PTT state from voice lock state
  useEffect(() => {
    if (!voicePttLock) {
      setPttState('idle');
      return;
    }

    if (voicePttLock.locked) {
      if (isPttDownRef.current) {
        setPttState('transmitting');
      } else {
        setPttState('locked-by-other');
      }
    } else {
      setPttState('idle');
    }
  }, [voicePttLock]);

  // Initialize voice capture when in voice mode
  useEffect(() => {
    if (!radioService || radioMode.engineMode !== 'voice') {
      return;
    }

    const capture = new VoiceCapture({
      onStateChange: (state) => {
        logger.debug('Voice capture state changed:', state);
      },
      onError: (error) => {
        logger.error('Voice capture error:', error);
        const issue = error instanceof RealtimeConnectivityError
          ? error.issue
          : buildRealtimeConnectivityIssue(error, {
            scope: 'radio',
            stage: 'publish',
          });
        showRealtimeConnectivityIssueToast(issue, {
          onRetry: () => {
            void capture.start().catch((retryError) => {
              logger.error('Failed to retry voice capture init', retryError);
            });
          },
        });
      },
    });

    // Set ref immediately so PTT can queue activation before start() completes
    voiceCaptureRef.current = capture;

    capture.start().then(() => {
      logger.info('Voice capture initialized');
    }).catch((error) => {
      logger.error('Failed to initialize voice capture:', error);
    });

    return () => {
      capture.stop();
      voiceCaptureRef.current = null;
    };
  }, [radioService, radioMode.engineMode]);

  // Request WakeLock during TX
  const acquireWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        logger.debug('WakeLock acquired');
      }
    } catch (error) {
      logger.warn('WakeLock request failed:', error);
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
      logger.debug('WakeLock released');
    }
  }, []);

  // PTT press handler
  const handlePTTDown = useCallback(async () => {
    if (!isOperator || !radioService || isPttDownRef.current) return;
    if (pttState === 'locked-by-other') return;

    if (voiceCaptureRef.current?.captureState !== 'capturing') {
      await voiceCaptureRef.current?.whenReady();
    }
    const participantIdentity = voiceCaptureRef.current?.participantIdentity;
    if (!participantIdentity) {
      logger.warn('PTT requested before voice participant identity became available');
      return;
    }

    isPttDownRef.current = true;
    setPttState('requesting');

    radioService.requestVoicePTT(participantIdentity);
    voiceCaptureRef.current?.setPTTActive(true);

    acquireWakeLock();
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }

    logger.debug('PTT pressed');
  }, [isOperator, radioService, pttState, acquireWakeLock]);

  // PTT release handler
  const handlePTTUp = useCallback(() => {
    if (!isPttDownRef.current) return;

    isPttDownRef.current = false;

    radioService?.releaseVoicePTT();
    voiceCaptureRef.current?.setPTTActive(false);

    releaseWakeLock();
    setPttState('idle');

    if (navigator.vibrate) {
      navigator.vibrate(30);
    }

    logger.debug('PTT released');
  }, [radioService, releaseWakeLock]);

  // Keyboard handler (Space key)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.repeat) return;

      e.preventDefault();
      handlePTTDown();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      e.preventDefault();
      handlePTTUp();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handlePTTDown, handlePTTUp]);

  // Suppress all long-press browser behaviors on the PTT button.
  // React synthetic events are insufficient on Android WebView/WebKit —
  // native listeners in the capture phase with { passive: false } are required.
  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;

    const prevent = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      return false;
    };

    // contextmenu: long-press menu on Android WebView/Chrome, right-click on desktop
    el.addEventListener('contextmenu', prevent, { capture: true, passive: false });
    // selectstart: text selection highlight triggered by long press
    el.addEventListener('selectstart', prevent, { capture: true, passive: false });
    // dragstart: some browsers start drag on long press
    el.addEventListener('dragstart', prevent, { capture: true, passive: false });

    return () => {
      el.removeEventListener('contextmenu', prevent, { capture: true });
      el.removeEventListener('selectstart', prevent, { capture: true });
      el.removeEventListener('dragstart', prevent, { capture: true });
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isPttDownRef.current) {
        radioService?.releaseVoicePTT();
        voiceCaptureRef.current?.setPTTActive(false);
      }
      releaseWakeLock();
    };
  }, [radioService, releaseWakeLock]);

  // Button appearance based on state
  const getButtonStyle = (): { bgClass: string; label: string; subLabel?: string } => {
    switch (pttState) {
      case 'requesting':
        return {
          bgClass: 'bg-warning-500 shadow-lg shadow-warning-500/50',
          label: t('ptt.requesting'),
        };
      case 'transmitting':
        return {
          bgClass: 'bg-danger-600 shadow-lg shadow-danger-600/50 animate-pulse',
          label: t('ptt.transmitting'),
          subLabel: t('ptt.releaseHint'),
        };
      case 'locked-by-other':
        return {
          bgClass: 'bg-default-300 dark:bg-default-500 cursor-not-allowed',
          label: t('ptt.lockedByOther', { user: voicePttLock?.lockedByLabel || '?' }),
        };
      case 'idle':
      default:
        return {
          bgClass: 'bg-danger-500 shadow-lg shadow-danger-500/40 hover:bg-danger-600 active:bg-danger-700',
          label: t('ptt.idle'),
          subLabel: t('ptt.spaceHint'),
        };
    }
  };

  const { bgClass, label, subLabel } = getButtonStyle();
  const isDisabled = !isOperator || pttState === 'locked-by-other';

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`
        w-full py-3 md:w-28 md:py-0 md:h-full rounded-lg flex flex-col items-center justify-center
        transition-all duration-150 select-none touch-none
        text-white font-bold whitespace-nowrap
        [-webkit-touch-callout:none] [-webkit-user-select:none]
        ${bgClass}
        ${isDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}
      `}
      onMouseDown={(e) => {
        e.preventDefault();
        handlePTTDown();
      }}
      onMouseUp={handlePTTUp}
      onMouseLeave={() => {
        if (isPttDownRef.current) handlePTTUp();
      }}
      onTouchStart={(e) => {
        e.preventDefault();
        handlePTTDown();
      }}
      onTouchEnd={(e) => {
        e.preventDefault();
        handlePTTUp();
      }}
      onTouchCancel={handlePTTUp}
      disabled={isDisabled}
      aria-label={t('ptt.title')}
    >
      <span className="text-xl leading-tight">{label}</span>
      {subLabel && (
        <span className="text-xs font-normal opacity-80 mt-1">{subLabel}</span>
      )}
    </button>
  );
};
