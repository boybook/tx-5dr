import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useConnection, useRadioState } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { VoiceCapture } from '../../audio/VoiceCapture';

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
  const radio = useRadioState();
  const isOperator = useHasMinRole(UserRole.OPERATOR);

  const [pttState, setPttState] = useState<PTTState>('idle');
  const voiceCaptureRef = useRef<VoiceCapture | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const isPttDownRef = useRef(false);

  const voicePttLock = radio.state.voicePttLock;
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
    if (!radioService || radio.state.engineMode !== 'voice') {
      return;
    }

    const wsUrl = radioService.getVoiceAudioWsUrl();
    const capture = new VoiceCapture({
      wsUrl,
      onStateChange: (state) => {
        logger.debug('Voice capture state changed:', state);
      },
      onError: (error) => {
        logger.error('Voice capture error:', error);
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
  }, [radioService, radio.state.engineMode]);

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
  const handlePTTDown = useCallback(() => {
    if (!isOperator || !radioService || isPttDownRef.current) return;
    if (pttState === 'locked-by-other') return;

    isPttDownRef.current = true;
    setPttState('requesting');

    radioService.requestVoicePTT();
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
      type="button"
      className={`
        w-full py-3 md:w-28 md:py-0 md:h-full rounded-lg flex flex-col items-center justify-center
        transition-all duration-150 select-none touch-none
        text-white font-bold whitespace-nowrap
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
