import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useConnection, usePTTState } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import type { VoiceCaptureController } from '../../hooks/useVoiceCaptureController';

const logger = createLogger('VoicePTTButton');

type PTTState = 'idle' | 'requesting' | 'transmitting' | 'locked-by-other';

/**
 * Voice PTT Button Component
 *
 * Rectangular red card-style PTT button for voice mode.
 * Supports mouse, touch, and keyboard (Space) interactions.
 * Manages WakeLock and vibration feedback for mobile.
 */
interface VoicePTTButtonProps {
  voiceCaptureController: VoiceCaptureController;
}

export const VoicePTTButton: React.FC<VoicePTTButtonProps> = ({ voiceCaptureController }) => {
  const { t } = useTranslation('voice');
  const connection = useConnection();
  const { voicePttLock } = usePTTState();
  const isOperator = useHasMinRole(UserRole.OPERATOR);

  const [pttState, setPttState] = useState<PTTState>('idle');
  const [inputLevel, setInputLevel] = useState(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const isPttDownRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const voiceCaptureControllerRef = useRef(voiceCaptureController);

  const radioService = connection.state.radioService;

  useEffect(() => {
    voiceCaptureControllerRef.current = voiceCaptureController;
  }, [voiceCaptureController]);

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

  useEffect(() => {
    logger.debug('Voice capture state changed', {
      captureState: voiceCaptureController.captureState,
      activeTransport: voiceCaptureController.activeTransport,
      preferredTransport: voiceCaptureController.preferredTransport,
    });
  }, [
    voiceCaptureController.activeTransport,
    voiceCaptureController.captureState,
    voiceCaptureController.preferredTransport,
  ]);

  useEffect(() => {
    let animationFrame = 0;
    let lastSampleAt = 0;

    const updateLevel = (timestamp: number) => {
      if (timestamp - lastSampleAt >= 50) {
        lastSampleAt = timestamp;
        const nextLevel = voiceCaptureController.getInputLevel();
        setInputLevel((currentLevel) => (
          Math.abs(currentLevel - nextLevel) < 0.01 ? currentLevel : nextLevel
        ));
      }
      animationFrame = window.requestAnimationFrame(updateLevel);
    };

    animationFrame = window.requestAnimationFrame(updateLevel);

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [voiceCaptureController]);

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

    isPttDownRef.current = true;
    setPttState('requesting');

    try {
      const participantIdentity = await voiceCaptureController.startFromGesture();
      if (!participantIdentity) {
        logger.warn('PTT requested before voice participant identity became available');
        isPttDownRef.current = false;
        setPttState('idle');
        return;
      }

      radioService.requestVoicePTT(participantIdentity);
      voiceCaptureController.setPTTActive(true);
    } catch (error) {
      isPttDownRef.current = false;
      setPttState('idle');
      logger.error('PTT initialization failed', error);
      return;
    }

    acquireWakeLock();
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }

    logger.debug('PTT pressed');
  }, [acquireWakeLock, isOperator, pttState, radioService, voiceCaptureController]);

  // PTT release handler
  const handlePTTUp = useCallback(() => {
    if (!isPttDownRef.current) return;

    isPttDownRef.current = false;

    radioService?.releaseVoicePTT();
    voiceCaptureController.setPTTActive(false);

    releaseWakeLock();
    setPttState('idle');

    if (navigator.vibrate) {
      navigator.vibrate(30);
    }

    logger.debug('PTT released');
  }, [radioService, releaseWakeLock, voiceCaptureController]);

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
        voiceCaptureControllerRef.current.setPTTActive(false);
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
          label: t('ptt.idle'),
          subLabel: t('ptt.requesting'),
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
  const meterPercent = Math.round(Math.max(0, Math.min(1, inputLevel)) * 100);
  const meterIsArmed = voiceCaptureController.captureState !== 'idle';
  const meterFillPercent = meterIsArmed
    ? Math.max(0, Math.min(100, meterPercent))
    : 0;
  const peakMarkerPercent = meterIsArmed
    ? Math.max(0, Math.min(100, meterFillPercent))
    : 0;
  const meterContainerClass = voiceCaptureController.captureState === 'error'
    ? 'border-danger-400/70 bg-danger-50/40 dark:bg-danger-950/20'
    : meterIsArmed
      ? 'border-success-400/60 bg-content2/90'
      : 'border-default-300/80 bg-content2/70';
  const meterFillClass = pttState === 'transmitting'
    ? 'from-danger-500 via-warning-400 to-success-300'
    : 'from-primary-500 via-success-400 to-warning-300';

  return (
    <div className="flex h-20 w-full items-stretch gap-1.5 md:h-full md:w-[7.75rem] md:self-stretch">
      <button
        ref={buttonRef}
        type="button"
        className={`
          h-full flex-1 rounded-lg px-2 flex flex-col items-center justify-center
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

      <div
        className={`
          relative h-full w-3.5 shrink-0 rounded-lg border p-[2px] overflow-hidden md:w-4
          transition-colors duration-150
          ${meterContainerClass}
        `}
        title={t('ptt.inputLevelTitle', { percent: meterPercent })}
        aria-label={t('ptt.inputLevelAria', { percent: meterPercent })}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={meterPercent}
        aria-valuetext={t('ptt.inputLevelAria', { percent: meterPercent })}
      >
        <div className="relative h-full w-full rounded-md bg-default-200/70 dark:bg-default-100/10 overflow-hidden">
          <div
            className={`
              absolute inset-x-0 bottom-0 rounded-md bg-gradient-to-t transition-[height,opacity] duration-75 ease-out
              ${meterFillClass}
            `}
            style={{
              height: `${meterFillPercent}%`,
              opacity: meterIsArmed ? 1 : 0.35,
            }}
          />
          <div
            className="absolute inset-x-0 h-[2px] rounded-full bg-white/90 transition-[bottom,opacity] duration-100 ease-out"
            style={{
              bottom: `${Math.max(0, peakMarkerPercent - 2)}%`,
              opacity: meterIsArmed && meterFillPercent > 0 ? 1 : 0,
            }}
          />
          {!meterIsArmed && (
            <div className="absolute inset-x-0 bottom-0 h-1.5 rounded-full bg-default-400/35" />
          )}
        </div>
      </div>
    </div>
  );
};
