import * as React from 'react';
import {Select, SelectItem, Switch, Button, Slider, Popover, PopoverTrigger, PopoverContent, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Input, Spinner, Alert, Tabs, Tab, Tooltip} from "@heroui/react";
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog, faChevronDown, faVolumeUp, faHeadphones, faMicrophone, faRadio, faSlidersH, faTowerBroadcast, faPowerOff, faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { useConnection, useProfiles, useRadioErrors, useCapabilityState, useRadioConnectionState, useRadioModeState, usePTTState, useAudioSidecarState, useRadioState, useOperators } from '../../../store/radioStore';
import type { AudioSidecarStatusPayload } from '@tx5dr/contracts';
import { AudioSidecarStatus } from '@tx5dr/contracts';
import { RadioErrorHistoryModal } from './RadioErrorHistoryModal';
import { RadioControlPanel } from './RadioControlPanel';
import { TunerCapabilitySurface } from '../../../radio-capability/components/TunerCapability';
import { api, ApiError } from '@tx5dr/core';
import type { ModeDescriptor, RealtimeAudioCodecPreference, RealtimeTransportKind, VoiceTxBufferProfile } from '@tx5dr/contracts';
import type { ConnectionState } from '../../../store/radioStore';
import { RadioConnectionStatus, UserRole } from '@tx5dr/contracts';
import { subject as caslSubject } from '@casl/ability';
import { showErrorToast, localizeError } from '../../../utils/errorToast';
import { useHasMinRole, useCan, useAbility } from '../../../store/authStore';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioMonitorPlayback } from '../../../hooks/useAudioMonitorPlayback';
import { useVoiceTxDiagnostics } from '../../../hooks/useVoiceTxDiagnostics';
import { useWSEvent } from '../../../hooks/useWSEvent';
import { createLogger } from '../../../utils/logger';
import { TxVolumeGainControl } from './TxVolumeGainControl';
import {
  deriveMonitorActivationCtaState,
  filterDigitalFrequencyOptions,
  isCoreCapabilityAvailable,
  shouldShowAntennaTuneEntry,
  shouldShowRadioControlEntry,
} from '../../../utils/radioControl';
import { computeSliderWheelUpdate } from '../../../utils/sliderWheel';
import type { VoiceCaptureController } from '../../../hooks/useVoiceCaptureController';
import {
  presentRealtimeConnectivityFailure,
} from '../../../realtime/realtimeConnectivity';
import { resetOperatorsForOperatingStateChange } from '../../../utils/operatorReset';
import {
  loadRealtimeAudioCodecPreference,
  saveRealtimeAudioCodecPreference,
} from '../../../audio/realtimeAudioCodec';
import {
  MONITOR_PLAYBACK_BUFFER_CUSTOM_MAX_MS,
  MONITOR_PLAYBACK_BUFFER_CUSTOM_MIN_MS,
  MONITOR_PLAYBACK_BUFFER_CUSTOM_STEP_MS,
  clampMonitorPlaybackBufferTarget,
  type MonitorPlaybackBufferProfile,
} from '../../../audio/monitorPlaybackBufferPreference';

const logger = createLogger('RadioControl');

const SELECT_TEXT_MEASURE_CLASS = 'fixed left-0 top-0 invisible pointer-events-none whitespace-nowrap font-bold text-lg';
const SELECT_CHROME_WIDTH_PX = 52;
const FREQUENCY_SELECT_MIN_WIDTH_PX = 132;
const FREQUENCY_SELECT_MAX_WIDTH_PX = 280;
const MODE_SELECT_MIN_WIDTH_PX = 92;
const MODE_SELECT_MAX_WIDTH_PX = 160;
const CUSTOM_FREQUENCY_ACTION_KEY = '__custom__';
const CURRENT_CUSTOM_FREQUENCY_KEY = '__custom_frequency__';
const CUSTOM_BAND = 'custom';
const VOICE_TX_BUFFER_PROFILES: VoiceTxBufferProfile[] = [
  'auto',
  'custom',
];
const REALTIME_AUDIO_CODEC_PREFERENCES: RealtimeAudioCodecPreference[] = ['auto', 'opus', 'pcm'];
const MONITOR_PLAYBACK_BUFFER_PROFILES: MonitorPlaybackBufferProfile[] = ['auto', 'custom'];

const clampWidth = (value: number, minWidth: number, maxWidth: number): number => (
  Math.min(maxWidth, Math.max(minWidth, value))
);

const isVoiceKeyerLockHolder = (lockHolder: string | null | undefined): boolean => (
  typeof lockHolder === 'string' && lockHolder.startsWith('voice-keyer:')
);

const ToolbarIconTooltip: React.FC<{
  label: string;
  children: React.ReactNode;
}> = ({ label, children }) => (
  <div className="relative flex items-center group/toolbar-tooltip">
    {children}
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-content1 px-2 py-1 text-[11px] text-foreground shadow-medium opacity-0 transition-opacity duration-150 group-hover/toolbar-tooltip:opacity-100"
    >
      {label}
    </div>
  </div>
);

const useMeasuredSelectWidth = (
  text: string,
  minWidth: number,
  maxWidth: number,
) => {
  const measureRef = React.useRef<HTMLSpanElement>(null);
  const [width, setWidth] = React.useState(minWidth);

  React.useLayoutEffect(() => {
    const measure = () => {
      if (!measureRef.current) {
        return;
      }

      const textWidth = Math.ceil(measureRef.current.getBoundingClientRect().width);
      setWidth(clampWidth(textWidth + SELECT_CHROME_WIDTH_PX, minWidth, maxWidth));
    };

    measure();

    if (typeof window === 'undefined') {
      return undefined;
    }

    const rafId = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(rafId);
  }, [text, minWidth, maxWidth]);

  return { measureRef, width };
};

interface FrequencyOption {
  key: string;
  label: string;
  frequency: number;
  band: string;
  mode: string;
  radioMode?: string; // 电台调制模式，如 USB, LSB
}

export const SelectorIcon = (_props: React.SVGProps<SVGSVGElement>) => {
  return (
    <FontAwesomeIcon icon={faChevronDown} className="text-default-400" />
  );
};

/**
 * 连接入口：默认只有"连接"主按钮；若当前 Profile 支持唤醒，
 * 右侧附加一个橙色的电源图标按钮（icon-only），hover 时展示功能文案。
 * 视觉主次分明，不让用户在两个文字按钮间纠结。
 */
const ConnectWithWakeButton: React.FC<{ onConnect: () => void }> = ({ onConnect }) => {
  const { t } = useTranslation('radio');
  const { activeProfileId } = useProfiles();
  const canPower = useCan('execute', 'RadioPower');
  const [support, setSupport] = React.useState<import('@tx5dr/contracts').RadioPowerSupportInfo | null>(null);
  const [waking, setWaking] = React.useState(false);

  React.useEffect(() => {
    if (!activeProfileId || !canPower) {
      setSupport(null);
      return;
    }
    let cancelled = false;
    api.getRadioPowerSupport(activeProfileId)
      .then((info) => { if (!cancelled) setSupport(info); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeProfileId, canPower]);

  const canWake = !!support?.canPowerOn && !!activeProfileId;

  const handleWake = async () => {
    if (!activeProfileId || waking) return;
    setWaking(true);
    try {
      await api.setRadioPower({ profileId: activeProfileId, state: 'on', autoEngine: true });
    } catch (error) {
      addToast({
        title: t('power.error.failed'),
        description: localizeError(error),
        color: 'danger',
        timeout: 5000,
      });
    } finally {
      setWaking(false);
    }
  };

  return (
    <span
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {canWake && (
        <ToolbarIconTooltip label={t('status.wakeAndConnect')}>
          <Button
            size="sm"
            isIconOnly
            color="warning"
            variant="flat"
            onPress={handleWake}
            isLoading={waking}
            isDisabled={waking}
            className="h-6 min-w-6 w-6 px-0 text-xs"
            aria-label={t('status.wakeAndConnect')}
          >
            <FontAwesomeIcon icon={faPowerOff} className="text-xs" />
          </Button>
        </ToolbarIconTooltip>
      )}
      <Button
        size="sm"
        color="primary"
        variant="flat"
        onPress={onConnect}
        isDisabled={waking}
        className="h-6 px-2 text-xs"
      >
        {t('status.connect')}
      </Button>
    </span>
  );
};

// 电台连接状态指示器组件
interface RadioConnectionSnapshot {
  radioConnected: boolean;
  radioConnectionStatus: RadioConnectionStatus;
  radioInfo: { manufacturer: string; model: string } | null;
  radioConfig: RadioConnectionState['radioConfig'];
  reconnectProgress: RadioConnectionState['reconnectProgress'];
  isDecoding: boolean;
}

type RadioConnectionState = ReturnType<typeof useRadioConnectionState>;

const AudioSidecarIndicator: React.FC<{
  sidecar: AudioSidecarStatusPayload;
  radioService: ConnectionState['radioService'];
  canOperate: boolean;
}> = ({ sidecar, radioService, canOperate }) => {
  const { t, i18n } = useTranslation('radio');
  const isRetrying = sidecar.status === AudioSidecarStatus.RETRYING;
  const isDisabled = sidecar.status === AudioSidecarStatus.DISABLED;
  const color: 'warning' | 'danger' = isDisabled ? 'danger' : 'warning';
  const deviceLabel = sidecar.deviceName || t('audioSidecar.deviceUnknown');

  const statusLabel = React.useMemo(() => {
    if (isDisabled) return t('audioSidecar.statusDisabled');
    if (sidecar.longRunning) return t('audioSidecar.statusRetryingLong');
    if (isRetrying) return t('audioSidecar.statusRetrying');
    return t('audioSidecar.statusConnecting');
  }, [isDisabled, isRetrying, sidecar.longRunning, t]);

  const retryLine = React.useMemo(() => {
    if (!isRetrying) return null;
    if (sidecar.nextRetryMs && sidecar.nextRetryMs > 0) {
      return t('audioSidecar.retryingDetail', {
        attempt: sidecar.retryAttempt,
        seconds: Math.max(1, Math.round(sidecar.nextRetryMs / 1000)),
      });
    }
    return t('audioSidecar.retryingNoDelay', { attempt: sidecar.retryAttempt });
  }, [isRetrying, sidecar.nextRetryMs, sidecar.retryAttempt, t]);

  const errorText = React.useMemo(() => {
    const error = sidecar.lastError;
    if (!error) return null;
    if (error.userMessageKey && i18n.exists(error.userMessageKey)) {
      return t(error.userMessageKey, error.userMessageParams ?? {});
    }
    return error.userMessage || error.message || null;
  }, [i18n, sidecar.lastError, t]);
  const stopPopoverPropagation = React.useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  return (
    <Popover placement="bottom">
      <PopoverTrigger>
        <button
          type="button"
          aria-label={statusLabel}
          onClick={(e) => {
            e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex items-center justify-center -ml-1 h-5 w-5 rounded-full hover:bg-default-200"
        >
          <Spinner size="sm" color={color} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="px-3 py-2 max-w-xs space-y-1"
        onClick={stopPopoverPropagation}
        onMouseDown={stopPopoverPropagation}
        onPointerDown={stopPopoverPropagation}
        onPointerUp={stopPopoverPropagation}
        onKeyDown={stopPopoverPropagation}
      >
        <div className="text-xs font-medium text-foreground">{t('audioSidecar.popoverTitle')}</div>
        <div className="text-xs text-default-600">
          {statusLabel} · {deviceLabel}
        </div>
        {retryLine && (
          <div className="text-xs text-default-500">{retryLine}</div>
        )}
        {errorText && (
          <div className="text-xs text-danger break-words">{errorText}</div>
        )}
        {isDisabled && (
          <div className="text-xs text-default-500">{t('audioSidecar.disabledHint')}</div>
        )}
        {canOperate && (isRetrying || isDisabled) && radioService && (
          <div className="pt-1">
            <Button
              size="sm"
              variant="flat"
              color={color}
              className="h-6 px-2 text-xs"
              onPress={() => radioService.retryAudioNow()}
            >
              {t('audioSidecar.retryNow')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

const RadioStatus: React.FC<{ connection: ConnectionState; radioConnection: RadioConnectionSnapshot; profileName?: string | null; onPress?: () => void; canConfigure?: boolean; canOperate?: boolean }> = ({ connection, radioConnection, profileName, onPress, canConfigure = true, canOperate = true }) => {
  const { t } = useTranslation('radio');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [supportedRigs, setSupportedRigs] = useState<any[]>([]);

  // 加载支持的电台列表
  useEffect(() => {
    const loadSupportedRigs = async () => {
      if (connection.isConnected) {
        try {
          const rigsResponse = await api.getSupportedRigs();
          if (rigsResponse.rigs && Array.isArray(rigsResponse.rigs)) {
            setSupportedRigs(rigsResponse.rigs);
          }
        } catch (error) {
          logger.error('Failed to fetch supported rigs list:', error);
        }
      }
    };

    loadSupportedRigs();
  }, [connection.isConnected]);

  // 监听电台状态变化事件
  useEffect(() => {
    if (!connection.radioService) return;

    const wsClient = connection.radioService.wsClientInstance;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleRadioDisconnectedDuringTransmission = (data: any) => {
      addToast({
        title: t('status.txDisconnected'),
        description: data.message,
        timeout: 10000
      });
      setTimeout(() => {
        addToast({
          title: t('status.suggestion'),
          description: data.recommendation,
          timeout: 15000
        });
      }, 1000);
    };

    wsClient.onWSEvent('radioDisconnectedDuringTransmission', handleRadioDisconnectedDuringTransmission);

    return () => {
      wsClient.offWSEvent('radioDisconnectedDuringTransmission', handleRadioDisconnectedDuringTransmission);
    };
  }, [connection.radioService]);

  // 获取电台型号文本
  const getRadioModelText = () => {
    const config = radioConnection.radioConfig;
    if (radioConnection.radioInfo) {
      return `${radioConnection.radioInfo.manufacturer} ${radioConnection.radioInfo.model}`;
    }
    if (config.type === 'serial' && config.serial?.rigModel) {
      const rigInfo = supportedRigs.find((r: { rigModel: number }) => r.rigModel === config.serial!.rigModel);
      if (rigInfo) return `${rigInfo.mfgName} ${rigInfo.modelName}`;
      return t('status.rigModel', { model: config.serial.rigModel });
    }
    if (config.type === 'network') return 'Network RigCtrl';
    if (config.type === 'icom-wlan') return 'ICOM WLAN';
    return t('status.radio');
  };

  if (!connection.isConnected) {
    return null;
  }

  const status = radioConnection.radioConnectionStatus;
  const label = profileName || getRadioModelText();
  const audioSidecar = useAudioSidecarState();
  const showAudioIndicator = Boolean(
    audioSidecar &&
      !audioSidecar.isConnected &&
      audioSidecar.status !== AudioSidecarStatus.IDLE,
  );

  const renderStatus = () => {
    switch (status) {
      case RadioConnectionStatus.NOT_CONFIGURED:
        return <span className="text-sm text-default-500">{label} | {t('connection.none')}</span>;

      case RadioConnectionStatus.CONNECTING:
        return (
          <div className="flex items-center gap-2">
            <Spinner size="sm" color="primary" />
            <span className="text-sm text-primary">{label} {t('connection.connecting')}</span>
          </div>
        );

      case RadioConnectionStatus.CONNECTED:
        return (
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faRadio} className="text-success text-ms -mt-0.5" />
            <span className="text-sm text-default-500">
              {label} {t('connection.connected')}
            </span>
            {showAudioIndicator && audioSidecar && (
              <AudioSidecarIndicator
                sidecar={audioSidecar}
                radioService={connection.radioService}
                canOperate={canOperate}
              />
            )}
          </div>
        );

      case RadioConnectionStatus.RECONNECTING: {
        const progress = radioConnection.reconnectProgress;
        return (
          <div className="flex items-center gap-2">
            <Spinner size="sm" color="warning" />
            <span className="text-sm text-warning">
              {label} {t('connection.reconnecting')}{progress ? ` (${progress.attempt}/${progress.maxAttempts})` : ''}
            </span>
            {canOperate && (
              <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                <Button
                  size="sm"
                  color="warning"
                  variant="flat"
                  onPress={() => connection.radioService?.stopReconnect()}
                  className="h-6 px-2 text-xs"
                >
                  {t('status.stop')}
                </Button>
              </span>
            )}
          </div>
        );
      }

      case RadioConnectionStatus.CONNECTION_LOST:
        return (
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faRadio} className="text-danger text-xs" />
            <span className="text-sm text-danger">{label} {t('connection.disconnected')}</span>
            {canOperate && (
              <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                <Button
                  size="sm"
                  color="danger"
                  variant="flat"
                  onPress={() => connection.radioService?.startDecoding()}
                  className="h-6 px-2 text-xs"
                >
                  {t('status.reconnect')}
                </Button>
              </span>
            )}
          </div>
        );

      case RadioConnectionStatus.DISCONNECTED:
      default:
        return (
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faRadio} className="text-default-400 text-xs" />
            <span className="text-sm text-default-500">{label} {t('status.notConnected')}</span>
            {canOperate && radioConnection.radioConfig?.type && radioConnection.radioConfig.type !== 'none' && !radioConnection.isDecoding && (
              <ConnectWithWakeButton
                onConnect={() => connection.radioService?.startDecoding()}
              />
            )}
          </div>
        );
    }
  };

  if (canConfigure) {
    return (
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-2 rounded-md px-2 -mx-2 py-1 -my-1 transition-colors hover:bg-default-200 active:bg-default-300 cursor-pointer"
        onClick={onPress}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress?.(); } }}
      >
        {renderStatus()}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 -mx-2 py-1 -my-1">
      {renderStatus()}
    </div>
  );
};

interface RadioControlProps {
  onOpenRadioSettings?: () => void;
  voiceCaptureController?: VoiceCaptureController;
}

export const RadioControl: React.FC<RadioControlProps> = ({ onOpenRadioSettings, voiceCaptureController }) => {
  const { t, i18n } = useTranslation('radio');
  const connection = useConnection();
  const { operators } = useOperators();
  const radioConnection = useRadioConnectionState();
  const radioMode = useRadioModeState();
  const { pttStatus, tuneToneStatus, voicePttLock } = usePTTState();
  const { state: radioState } = useRadioState();
  const { activeProfile } = useProfiles();
  const { latestError } = useRadioErrors();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const isOperator = useHasMinRole(UserRole.OPERATOR);
  const canSetFrequency = useCan('execute', 'RadioFrequency');
  const canSwitchMode = useCan('execute', 'ModeSwitch');
  const canStartStopEngine = useCan('execute', 'Engine');
  const canControlRadio = useCan('execute', 'RadioControl');
  const canWriteFrequency = isCoreCapabilityAvailable(radioConnection.coreCapabilities, 'writeFrequency');
  const canOpenRadioControl = shouldShowRadioControlEntry(
    radioConnection.radioConnected,
    canControlRadio,
  );
  // RadioControlPanel 弹窗状态
  const [isControlPanelOpen, setIsControlPanelOpen] = useState(false);

  // 天调按钮状态（从能力系统读取，需在顶层调用 Hook）
  const tunerSwitchCapState = useCapabilityState('tuner_switch');
  const showAntennaTuneEntry = shouldShowAntennaTuneEntry(
    radioConnection.radioConnected,
    canControlRadio,
  );
  const tunerEnabled = typeof tunerSwitchCapState?.value === 'boolean' ? tunerSwitchCapState.value : false;
  const tunerIsTuning = (tunerSwitchCapState?.meta as { status?: string } | undefined)?.status === 'tuning';
  const tuneToneActive = tuneToneStatus.active;
  const ability = useAbility();
  const formatBandLabel = React.useCallback((band?: string | null) => (
    !band || band.toLowerCase() === CUSTOM_BAND ? t('frequency.custom') : band
  ), [t]);
  const [isErrorHistoryOpen, setIsErrorHistoryOpen] = useState(false);
  const [availableModes, setAvailableModes] = useState<ModeDescriptor[]>([]);
  const [isLoadingModes, setIsLoadingModes] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [availableFrequencies, setAvailableFrequencies] = useState<FrequencyOption[]>([]);
  const [isLoadingFrequencies, setIsLoadingFrequencies] = useState(false);
  const isRadioConnectedRef = React.useRef(connection.state.isConnected);

  React.useEffect(() => {
    isRadioConnectedRef.current = connection.state.isConnected;
  }, [connection.state.isConnected]);
  const [currentFrequency, setCurrentFrequency] = useState<string>('14074000');

  // 简化的UI状态管理
  const [isTogglingListen, setIsTogglingListen] = useState(false);
  const [isSwitchingMonitorTransport, setIsSwitchingMonitorTransport] = useState(false);
  const [isSwitchingVoiceTransport, setIsSwitchingVoiceTransport] = useState(false);
  const [isVoiceTxPopoverOpen, setIsVoiceTxPopoverOpen] = useState(false);
  const hasAutoOpenedVoiceTxUnderrunPopoverRef = React.useRef(false);

  // 音频监听 (reusable hook)
  const audioMonitor = useAudioMonitorPlayback({ scope: 'radio' });
  const [monitorVolume, setMonitorVolume] = useState(1.0); // 监听音量（线性增益）
  const [hasActivatedMonitorPlayback, setHasActivatedMonitorPlayback] = useState(false);
  const [monitorAudioCodecPreference, setMonitorAudioCodecPreference] = useState<RealtimeAudioCodecPreference>(() => loadRealtimeAudioCodecPreference());
  const monitorWheelPixelRemainderRef = React.useRef(0);

  // OpenWebRX client count (for multi-user confirmation)
  const openwebrxClientCountRef = React.useRef(0);
  const [sdrConfirmPending, setSdrConfirmPending] = React.useState<{
    frequency: string; // selectedFrequencyKey
    count: number;
  } | null>(null);

  useWSEvent(connection.state.radioService, 'openwebrxClientCount', (data: { count: number }) => {
    openwebrxClientCountRef.current = data.count;
  });

  // 自定义频率相关状态
  const [isCustomFrequencyModalOpen, setIsCustomFrequencyModalOpen] = useState(false);
  const [customFrequencyInput, setCustomFrequencyInput] = useState('');
  const [customFrequencyError, setCustomFrequencyError] = useState('');
  const [isSettingCustomFrequency, setIsSettingCustomFrequency] = useState(false);
  const [customFrequencyOption, setCustomFrequencyOption] = useState<FrequencyOption | null>(null); // 保存自定义频率选项

  const resetOperatorsAfterOperatingStateChange = React.useCallback(() => {
    resetOperatorsForOperatingStateChange({
      operators,
      radioService: connection.state.radioService,
    });
  }, [connection.state.radioService, operators]);

  useEffect(() => {
    if (!canOpenRadioControl && isControlPanelOpen) {
      setIsControlPanelOpen(false);
    }
  }, [canOpenRadioControl, isControlPanelOpen]);

  const getMonitorTransportLabel = React.useCallback((transport: RealtimeTransportKind | null | undefined): string => {
    if (transport === 'ws-compat') {
      return t('monitor.transportWsPcm');
    }
    return t('monitor.transportWebrtc');
  }, [t]);

  const getNextMonitorTransport = React.useCallback((): RealtimeTransportKind => (
    audioMonitor.transportKind === 'ws-compat' ? 'rtc-data-audio' : 'ws-compat'
  ), [audioMonitor.transportKind]);

  const getVoiceTransportLabel = React.useCallback((transport: RealtimeTransportKind | null | undefined): string => {
    if (transport === 'ws-compat') {
      return t('monitor.transportWsPcm');
    }
    return t('monitor.transportWebrtc');
  }, [t]);

  const getModeDisplayLabel = React.useCallback((modeName: string): string => {
    if (modeName === 'VOICE') {
      return t('mode.voice');
    }
    return modeName;
  }, [t]);

  const currentVoiceTransport = voiceCaptureController?.activeTransport ?? null;
  const effectiveVoiceTransport = currentVoiceTransport ?? voiceCaptureController?.preferredTransport ?? null;
  const nextVoiceTransport = effectiveVoiceTransport === 'ws-compat' ? 'rtc-data-audio' : 'ws-compat';
  const monitorActivationCta = React.useMemo(() => deriveMonitorActivationCtaState(
    radioMode.engineMode === 'voice',
    connection.state.isConnected,
    audioMonitor.isPlaying,
    hasActivatedMonitorPlayback,
  ), [audioMonitor.isPlaying, connection.state.isConnected, hasActivatedMonitorPlayback, radioMode.engineMode]);
  const voiceTxDiagnostics = useVoiceTxDiagnostics(
    voiceCaptureController,
    radioMode.engineMode === 'voice' && Boolean(voiceCaptureController),
  );
  const selectedVoiceTxBufferProfile = voiceCaptureController?.txBufferPreference.profile ?? 'auto';
  const isVoiceTxCustomBufferMode = selectedVoiceTxBufferProfile === 'custom';

  React.useEffect(() => {
    const hasRisingUnderruns = Boolean(voiceTxDiagnostics?.display.underrunIncreasingTrend);
    const isTransmitting = Boolean(voiceCaptureController?.isPTTActive);

    if (!isTransmitting || !hasRisingUnderruns || !isVoiceTxCustomBufferMode) {
      hasAutoOpenedVoiceTxUnderrunPopoverRef.current = false;
      return;
    }

    if (hasAutoOpenedVoiceTxUnderrunPopoverRef.current) {
      return;
    }

    hasAutoOpenedVoiceTxUnderrunPopoverRef.current = true;
    setIsVoiceTxPopoverOpen(true);
  }, [
    isVoiceTxCustomBufferMode,
    voiceCaptureController?.isPTTActive,
    voiceTxDiagnostics?.display.underrunIncreasingTrend,
  ]);
  const voiceTxStatusLabel = React.useMemo(() => {
    if (voiceCaptureController?.isPTTActive) {
      return t('voiceTx.statusTransmitting');
    }
    if (voicePttLock?.locked && !voiceCaptureController?.isPTTActive) {
      return t('voiceTx.statusLockedByOther', { user: voicePttLock.lockedByLabel || '?' });
    }
    switch (voiceCaptureController?.captureState) {
      case 'starting':
        return t('voiceTx.statusStarting');
      case 'capturing':
        return t('voiceTx.statusReady');
      case 'error':
        return t('voiceTx.statusError');
      case 'idle':
      default:
        return t('voiceTx.statusIdle');
    }
  }, [
    t,
    voiceCaptureController?.captureState,
    voiceCaptureController?.isPTTActive,
    voicePttLock?.locked,
    voicePttLock?.lockedByLabel,
  ]);

  const formatLatencyMetric = React.useCallback((value: number | null | undefined): string => {
    if (value == null || Number.isNaN(value)) {
      return '--';
    }
    return `${value.toFixed(0)}ms`;
  }, []);

  const formatIntegerMetric = React.useCallback((value: number | null | undefined): string => {
    if (value == null || Number.isNaN(value)) {
      return '--';
    }
    return `${Math.round(value)}`;
  }, []);

  const formatBitrateMetric = React.useCallback((value: number | null | undefined): string => {
    if (value == null || Number.isNaN(value) || value <= 0) {
      return '--';
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} Mbps`;
    }
    return `${Math.round(value)} kbps`;
  }, []);

  const getVoiceTxBufferProfileLabel = React.useCallback((profile: VoiceTxBufferProfile): string => {
    switch (profile) {
      case 'auto':
        return t('voiceTx.bufferProfileAuto');
      case 'custom':
        return t('voiceTx.bufferProfileCustom');
      default:
        return t('voiceTx.bufferProfileAuto');
    }
  }, [t]);

  const activeVoiceTxBufferPolicy = voiceCaptureController?.activeTxBufferPolicy
    ?? voiceCaptureController?.resolvedTxBufferPolicy
    ?? null;
  const voiceTxBufferPolicySummary = React.useMemo(() => {
    if (!activeVoiceTxBufferPolicy) {
      return '--';
    }
    const profileLabel = getVoiceTxBufferProfileLabel(selectedVoiceTxBufferProfile);
    if (selectedVoiceTxBufferProfile === 'auto') {
      const liveTargetMs = voiceCaptureController?.isPTTActive
        ? voiceTxDiagnostics?.serverIngress.jitterTargetMs
        : null;
      return typeof liveTargetMs === 'number' && liveTargetMs > 0
        ? `${profileLabel} · ${t('voiceTx.bufferAutoLive', { value: formatLatencyMetric(liveTargetMs) })}`
        : profileLabel;
    }
    return `${profileLabel} · ${formatLatencyMetric(activeVoiceTxBufferPolicy.targetMs)}`;
  }, [
    activeVoiceTxBufferPolicy,
    formatLatencyMetric,
    getVoiceTxBufferProfileLabel,
    selectedVoiceTxBufferProfile,
    t,
    voiceCaptureController?.isPTTActive,
    voiceTxDiagnostics?.serverIngress.jitterTargetMs,
  ]);

  const voiceTxAudioPathSummary = React.useMemo(() => {
    if (!voiceCaptureController) {
      return '--';
    }
    const codec = voiceCaptureController.activeAudioCodecPolicy?.resolvedCodec === 'opus' ? 'Opus' : 'PCM';
    const transport = currentVoiceTransport
      ? getVoiceTransportLabel(currentVoiceTransport)
      : t('voiceTx.notEstablished');
    return `${codec} · ${transport}`;
  }, [
    currentVoiceTransport,
    getVoiceTransportLabel,
    t,
    voiceCaptureController,
  ]);

  const voiceTxBitrateKbps = voiceTxDiagnostics?.client?.bitrateKbps.rolling
    ?? voiceTxDiagnostics?.client?.bitrateKbps.current
    ?? (
      voiceCaptureController?.activeAudioCodecPolicy?.resolvedCodec === 'opus'
        && voiceCaptureController.activeAudioCodecPolicy.bitrateBps
        ? voiceCaptureController.activeAudioCodecPolicy.bitrateBps / 1000
        : null
    );

  const voiceTxStabilityLabel = React.useMemo(() => {
    if (!voiceTxDiagnostics) {
      return t('voiceTx.stabilityIdle');
    }
    if (voiceTxDiagnostics.serverOutput.writeFailures > 0) {
      return t('voiceTx.stabilityOutputProblem');
    }
    if (isVoiceTxCustomBufferMode && voiceTxDiagnostics.display.underrunIncreasingTrend) {
      return t('voiceTx.stabilityNeedMoreDelay');
    }
    return t('voiceTx.stabilityGood');
  }, [
    isVoiceTxCustomBufferMode,
    t,
    voiceTxDiagnostics,
  ]);

  const voiceTxLatencyClassName = React.useMemo(() => {
    const latencyMs = voiceTxDiagnostics?.display.endToEndLatencyMs;
    if (latencyMs == null) {
      return 'text-default-400';
    }
    if (latencyMs < 150) {
      return 'text-success';
    }
    if (latencyMs <= 300) {
      return 'text-warning';
    }
    return 'text-danger';
  }, [voiceTxDiagnostics?.display.endToEndLatencyMs]);
  const voiceTxCustomBufferMs = voiceCaptureController?.txBufferPreference.customTargetBufferMs
    ?? voiceCaptureController?.resolvedTxBufferPolicy.targetMs
    ?? 90;
  const isVoiceTxBufferControlDisabled = Boolean(
    voiceCaptureController?.isPTTActive || voiceCaptureController?.captureState === 'starting',
  );

  const handleVoiceTxBufferProfileChange = React.useCallback((profile: VoiceTxBufferProfile) => {
    if (!voiceCaptureController || isVoiceTxBufferControlDisabled) {
      return;
    }
    if (profile === 'custom') {
      const target = voiceCaptureController.txBufferPreference.customTargetBufferMs
        ?? voiceCaptureController.resolvedTxBufferPolicy.targetMs;
      voiceCaptureController.setTxBufferPreference({
        profile: 'custom',
        customTargetBufferMs: Math.max(40, Math.min(500, Math.round(target))),
      });
      return;
    }
    voiceCaptureController.setTxBufferPreference({ profile });
  }, [isVoiceTxBufferControlDisabled, voiceCaptureController]);

  const handleVoiceTxCustomBufferChange = React.useCallback((value: string) => {
    if (!voiceCaptureController || isVoiceTxBufferControlDisabled) {
      return;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }
    voiceCaptureController.setTxBufferPreference({
      profile: 'custom',
      customTargetBufferMs: Math.max(40, Math.min(500, parsed)),
    });
  }, [isVoiceTxBufferControlDisabled, voiceCaptureController]);

  const handleSwitchVoiceTransport = React.useCallback(async () => {
    if (!voiceCaptureController || isSwitchingVoiceTransport) {
      return;
    }

    setIsSwitchingVoiceTransport(true);
    try {
      if (voiceCaptureController.activeTransport) {
        await voiceCaptureController.switchTransportFromGesture(nextVoiceTransport);
      } else {
        voiceCaptureController.setPreferredTransport(nextVoiceTransport);
      }
    } catch (error) {
      logger.error('Failed to switch voice transport', error);
    } finally {
      setIsSwitchingVoiceTransport(false);
    }
  }, [isSwitchingVoiceTransport, nextVoiceTransport, voiceCaptureController]);


  // 加载可用模式列表
  React.useEffect(() => {
    const loadModes = async () => {
      if (!connection.state.isConnected) {
        setAvailableModes([]);
        return;
      }

      setIsLoadingModes(true);
      setModeError(null);

      try {
        const response = await api.getAvailableModes();

        if (response.success && Array.isArray(response.data)) {
          if (response.data.length === 0) {
            setModeError(t('mode.noModes'));
          } else {
            setAvailableModes(response.data);
          }
        } else {
          logger.error('Failed to load modes: invalid response format', response);
          setModeError(t('mode.loadFailed'));
        }
      } catch (error) {
        logger.error('Failed to load modes:', error);
        setModeError(t('mode.loadFailedDetail', { detail: error instanceof Error ? error.message : t('error.unknown') }));
      } finally {
        setIsLoadingModes(false);
      }
    };

    loadModes();
  }, [connection.state.isConnected, formatBandLabel]);

  // 加载预设频率列表
  React.useEffect(() => {
    const loadFrequencies = async () => {
      if (!connection.state.isConnected) {
        setAvailableFrequencies([]);
        return;
      }

      setIsLoadingFrequencies(true);

      try {
        const response = await api.getPresetFrequencies();

        if (response.success && Array.isArray(response.presets)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const frequencyOptions: FrequencyOption[] = response.presets.map((preset: any) => ({
            key: String(preset.frequency),
            label: preset.description || `${formatBandLabel(preset.band)} ${(preset.frequency / 1000000).toFixed(3)} MHz`,
            frequency: preset.frequency,
            band: preset.band,
            mode: preset.mode,
            radioMode: preset.radioMode
          }));

          setAvailableFrequencies(frequencyOptions);
        } else {
          logger.error('Failed to load frequencies: invalid response format', response);
        }
      } catch (error) {
        logger.error('Failed to load preset frequencies:', error);
      } finally {
        setIsLoadingFrequencies(false);
      }
    };

    loadFrequencies();
  }, [connection.state.isConnected]);

  // 加载并恢复上次选择的频率
  React.useEffect(() => {
    const loadLastFrequency = async () => {
      if (!isRadioConnectedRef.current || availableFrequencies.length === 0) {
        return;
      }

      try {
        const response = await api.getLastFrequency();

        if (response.success && response.lastFrequency) {
          const lastFreq = response.lastFrequency;

          // 查找匹配的频率选项
          const matchingFreq = availableFrequencies.find(freq =>
            freq.frequency === lastFreq.frequency && freq.mode === lastFreq.mode
          );

          if (matchingFreq && (!radioMode.currentMode || radioMode.currentMode.name === lastFreq.mode)) {
            logger.debug(`Restoring last frequency: ${matchingFreq.label}`);
            setCurrentFrequency(matchingFreq.key);
            // 自动设置频率到电台
            await autoSetFrequency(matchingFreq);
          }
        }
      } catch (error) {
        logger.error('Failed to load last frequency:', error);
        // 静默失败，不影响用户体验
      }
    };

    // 延迟执行，等待频率列表和模式都加载完成
    if (availableFrequencies.length > 0) {
      const timeoutId = window.setTimeout(() => {
        void loadLastFrequency();
      }, 500);
      return () => window.clearTimeout(timeoutId);
    }
  }, [availableFrequencies, radioMode.currentMode, connection.state.isConnected]);



  // 简化的监听开关控制
  const handleListenToggle = async (isSelected: boolean) => {
    if (!connection.state.radioService) {
      return;
    }

    if (!connection.state.isConnected) {
      return;
    }

    if (isTogglingListen) {
      return;
    }
    
    // 进入loading状态
    setIsTogglingListen(true);
    
    try {
      // 发送命令（RadioService内部已包含状态确认机制）
      if (isSelected) {
        connection.state.radioService.startDecoding();
      } else {
        connection.state.radioService.stopDecoding();
      }
      
    } catch (error) {
      logger.error('Failed to toggle listen state:', error);
    } finally {
      // 2秒后自动清除loading状态
      setTimeout(() => {
        setIsTogglingListen(false);
      }, 2000);
    }
  };

  // 处理模式切换
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleModeChange = async (keys: any) => {
    if (!connection.state.isConnected) {
      return;
    }

    const selectedModeName = Array.from(keys)[0] as string;

    // Handle VOICE mode switch via WSClient (not REST API, since VOICE is not a ModeDescriptor)
    if (selectedModeName === 'VOICE') {
      try {
        // Use WSClient to send mode switch command
        connection.state.radioService?.wsClientInstance.setMode({ name: 'VOICE' } as ModeDescriptor);
        resetOperatorsAfterOperatingStateChange();
        logger.info('Mode switch requested: VOICE');
      } catch (error) {
        logger.error('Failed to switch to VOICE mode:', error);
      }
      return;
    }

    const selectedMode = availableModes.find(mode => mode.name === selectedModeName);

    if (!selectedMode) {
      return;
    }

    try {
      const response = await api.switchMode(selectedMode);
      if (response.success) {
        resetOperatorsAfterOperatingStateChange();
        logger.info(`Mode switched to: ${selectedMode.name}`);
      }
    } catch (error) {
      logger.error('Failed to switch mode:', error);
    }
  };

  // dB到线性增益的转换
  const dbToGain = (db: number): number => {
    return Math.pow(10, db / 20);
  };

  // 线性增益到dB的转换
  const gainToDb = (gain: number): number => {
    return 20 * Math.log10(Math.max(0.001, gain));
  };

  // 格式化dB显示
  const formatDbDisplay = (db: number): string => {
    // 防止无效值
    if (db === null || db === undefined || isNaN(db)) {
      return '0.0dB';
    }
    
    // 格式化显示：正值显示+，负值显示-，保留1位小数
    if (db >= 0) {
      return `+${db.toFixed(1)}dB`;
    } else {
      return `${db.toFixed(1)}dB`;
    }
  };

  // 监听音量变化
  const handleMonitorVolumeChange = React.useCallback((value: number | number[]) => {
    const dbValue = Array.isArray(value) ? value[0] : value;
    if (!isNaN(dbValue) && dbValue >= -60 && dbValue <= 20) {
      const gainValue = dbToGain(dbValue);
      setMonitorVolume(gainValue);
      audioMonitor.setVolume(dbValue);
    }
  }, [audioMonitor]);

  const handleMonitorVolumeWheel = React.useCallback((event: React.WheelEvent<HTMLElement>) => {
    const result = computeSliderWheelUpdate({
      currentValue: gainToDb(monitorVolume),
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      disabled: false,
      orientation: 'vertical',
      enableWheel: true,
      pixelRemainder: monitorWheelPixelRemainderRef.current,
    });

    monitorWheelPixelRemainderRef.current = result.pixelRemainder;

    if (!result.consumed) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleMonitorVolumeChange(result.nextValue);
  }, [handleMonitorVolumeChange, monitorVolume]);

  // 切换监听状态
  const toggleMonitoring = async () => {
    if (audioMonitor.isPlaying) {
      audioMonitor.stop();
    } else {
      try {
        await audioMonitor.startFromGesture({ audioCodecPreference: monitorAudioCodecPreference });
        setHasActivatedMonitorPlayback(true);
      } catch (error) {
        logger.error('Failed to start audio monitor', error);
        presentRealtimeConnectivityFailure(error, {
          scope: 'radio',
          stage: 'connect',
        });
      }
    }
  };

  const handleSwitchMonitorTransport = async () => {
    if (!audioMonitor.isPlaying || !audioMonitor.transportKind || isSwitchingMonitorTransport) {
      return;
    }

    const nextTransport = getNextMonitorTransport();
    setIsSwitchingMonitorTransport(true);
    try {
      await audioMonitor.switchTransportFromGesture(nextTransport, { audioCodecPreference: monitorAudioCodecPreference });
    } catch (error) {
      logger.error('Failed to switch monitor transport', error);
      presentRealtimeConnectivityFailure(error, {
        scope: 'radio',
        stage: 'connect',
      });
    } finally {
      setIsSwitchingMonitorTransport(false);
    }
  };

  const getAudioCodecPreferenceLabel = React.useCallback((preference: RealtimeAudioCodecPreference): string => {
    switch (preference) {
      case 'opus':
        return 'Opus';
      case 'pcm':
        return 'PCM';
      case 'auto':
      default:
        return t('monitor.codecAuto');
    }
  }, [t]);

  const getMonitorPlaybackBufferProfileLabel = React.useCallback((profile: MonitorPlaybackBufferProfile): string => {
    switch (profile) {
      case 'custom':
        return t('monitor.bufferCustom');
      case 'auto':
      default:
        return t('monitor.bufferAuto');
    }
  }, [t]);

  const selectedMonitorBufferProfile = audioMonitor.playbackBufferPreference.profile;
  const monitorCustomBufferMs = audioMonitor.playbackBufferPreference.profile === 'custom'
    ? audioMonitor.playbackBufferPreference.customTargetBufferMs
    : audioMonitor.resolvedPlaybackBufferPolicy.targetBufferMs;
  const isMonitorBufferControlDisabled = isSwitchingMonitorTransport;

  const handleMonitorBufferProfileChange = React.useCallback((profile: MonitorPlaybackBufferProfile) => {
    if (isMonitorBufferControlDisabled) {
      return;
    }
    if (profile === 'custom') {
      audioMonitor.setPlaybackBufferPreference({
        profile: 'custom',
        customTargetBufferMs: clampMonitorPlaybackBufferTarget(monitorCustomBufferMs),
      });
      return;
    }
    audioMonitor.setPlaybackBufferPreference({ profile: 'auto' });
  }, [audioMonitor, isMonitorBufferControlDisabled, monitorCustomBufferMs]);

  const handleMonitorCustomBufferChange = React.useCallback((value: string) => {
    if (isMonitorBufferControlDisabled) {
      return;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }
    audioMonitor.setPlaybackBufferPreference({
      profile: 'custom',
      customTargetBufferMs: clampMonitorPlaybackBufferTarget(parsed),
    });
  }, [audioMonitor, isMonitorBufferControlDisabled]);

  const handleMonitorCodecPreferenceChange = React.useCallback(async (preference: RealtimeAudioCodecPreference) => {
    setMonitorAudioCodecPreference(preference);
    saveRealtimeAudioCodecPreference(preference);
    voiceCaptureController?.setAudioCodecPreference(preference);
    if (!audioMonitor.isPlaying || isSwitchingMonitorTransport) {
      return;
    }
    setIsSwitchingMonitorTransport(true);
    try {
      audioMonitor.stop();
      await audioMonitor.startFromGesture({ audioCodecPreference: preference });
    } catch (error) {
      logger.error('Failed to switch monitor codec', error);
      presentRealtimeConnectivityFailure(error, {
        scope: 'radio',
        stage: 'connect',
      });
    } finally {
      setIsSwitchingMonitorTransport(false);
    }
  }, [audioMonitor, isSwitchingMonitorTransport, t, voiceCaptureController]);

  const handleVoiceCodecPreferenceChange = React.useCallback((preference: RealtimeAudioCodecPreference) => {
    voiceCaptureController?.setAudioCodecPreference(preference);
    setMonitorAudioCodecPreference(preference);
    saveRealtimeAudioCodecPreference(preference);
  }, [voiceCaptureController]);

  // 频率格式验证和转换
  const parseFrequencyInput = (input: string): { frequency: number; error: string } | null => {
    const trimmed = input.trim();
    if (!trimmed) {
      return { frequency: 0, error: t('frequency.inputRequired') };
    }

    // 尝试解析为数字
    const value = parseFloat(trimmed);
    if (isNaN(value) || value <= 0) {
      return { frequency: 0, error: t('frequency.invalidNumber') };
    }

    let frequencyHz: number;

    // 判断输入格式:包含小数点视为MHz,否则视为Hz
    if (trimmed.includes('.')) {
      // MHz 格式
      if (value < 1 || value > 1000) {
        return { frequency: 0, error: t('frequency.outOfRange') };
      }
      frequencyHz = Math.round(value * 1000000);
    } else {
      // Hz 格式
      if (value < 1000000 || value > 1000000000) {
        return { frequency: 0, error: t('frequency.outOfRange') };
      }
      frequencyHz = Math.round(value);
    }

    return { frequency: frequencyHz, error: '' };
  };

  // 格式化频率显示 (Hz -> MHz)
  const formatFrequencyDisplay = (frequencyHz: number): string => {
    return (frequencyHz / 1000000).toFixed(3);
  };

  const buildCurrentCustomFrequencyOption = React.useCallback((
    frequency: number,
    mode: string,
    band = '',
    radioMode?: string,
  ): FrequencyOption => ({
    key: CURRENT_CUSTOM_FREQUENCY_KEY,
    label: `${formatFrequencyDisplay(frequency)} MHz`,
    frequency,
    band,
    mode,
    radioMode,
  }), []);

  // 处理自定义频率确认
  const handleCustomFrequencyConfirm = async () => {
    const result = parseFrequencyInput(customFrequencyInput);
    if (!result || result.error) {
      setCustomFrequencyError(result?.error || t('frequency.invalidInput'));
      return;
    }

    const { frequency } = result;
    setIsSettingCustomFrequency(true);

    try {
      const response = await api.setRadioFrequency({
        frequency: frequency,
        mode: radioMode.currentMode?.name || 'FT8',
        band: t('frequency.custom'),
        description: `${formatFrequencyDisplay(frequency)} MHz (${t('frequency.custom')})`
      });

      if (response.success) {
        // 关闭模态框
        setIsCustomFrequencyModalOpen(false);
        setCustomFrequencyInput('');
        setCustomFrequencyError('');
        resetOperatorsAfterOperatingStateChange();

        // 更新当前频率显示
        setCurrentFrequency(String(frequency));
        setCustomFrequencyOption(buildCurrentCustomFrequencyOption(
          frequency,
          radioMode.currentMode?.name || 'FT8',
          t('frequency.custom'),
        ));

        const successMessage = t('frequency.switched', { freq: formatFrequencyDisplay(frequency) });

        if (response.radioConnected) {
          logger.info(`Custom frequency set: ${formatFrequencyDisplay(frequency)} MHz`);
          addToast({
            title: t('frequency.switchSuccess'),
            description: successMessage,
            color: 'success',
            timeout: 3000
          });
        } else {
          addToast({
            title: t('frequency.recorded'),
            description: t('frequency.recordedDetail', { message: successMessage }),
            timeout: 4000
          });
        }
      } else {
        logger.error('Custom frequency set failed:', response.message);
        setCustomFrequencyError(response.message || t('frequency.setFailed'));
      }
    } catch (error) {
      logger.error('Failed to set custom frequency:', error);
      if (error instanceof ApiError) {
        setCustomFrequencyError(error.userMessage);
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        setCustomFrequencyError(t('error.networkError'));
      }
    } finally {
      setIsSettingCustomFrequency(false);
    }
  };

  // 处理自定义频率输入变化
  const handleCustomFrequencyInputChange = (value: string) => {
    setCustomFrequencyInput(value);
    // 清除之前的错误
    if (customFrequencyError) {
      setCustomFrequencyError('');
    }
  };

  // 根据当前模式筛选频率
  const filteredFrequencies = React.useMemo(() => {
    let filtered = filterDigitalFrequencyOptions(
      availableFrequencies,
      radioMode.currentMode?.name,
      customFrequencyOption,
    );

    // CASL 条件过滤：如果有频率限制条件，只显示允许的预设
    if (!isAdmin && canSetFrequency) {
      filtered = filtered.filter(freq => {
        // 自定义频率选项始终保留（后端会做最终校验）
        if (freq.key === customFrequencyOption?.key) return true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ability.can('execute', caslSubject('RadioFrequency', { frequency: freq.frequency }) as any);
      });
    }

    return filtered;
  }, [availableFrequencies, radioMode.currentMode, customFrequencyOption, isAdmin, canSetFrequency, ability]);

  const selectedFrequencyOption = React.useMemo(() => {
    const presetOption = filteredFrequencies.find(freq => freq.key === currentFrequency);
    if (presetOption) {
      return presetOption;
    }

    if (customFrequencyOption && String(customFrequencyOption.frequency) === currentFrequency) {
      return customFrequencyOption;
    }

    return null;
  }, [filteredFrequencies, currentFrequency, customFrequencyOption]);

  const selectedFrequencyKey = selectedFrequencyOption?.key ?? null;

  const frequencySelectLabel = selectedFrequencyOption?.label
    || (radioMode.currentMode ? `${radioMode.currentMode.name} ${t('control.frequency')}` : t('control.frequency'));

  const modeOptions = React.useMemo(() => {
    const modes = (availableModes || []).filter(mode => mode && mode.name);

    if (radioMode.engineMode !== 'voice' || modes.some(mode => mode.name === 'VOICE')) {
      return modes;
    }

    return [{ name: 'VOICE' } as ModeDescriptor, ...modes];
  }, [availableModes, radioMode.engineMode]);

  const modeSelectLabel = radioMode.engineMode === 'voice'
    ? getModeDisplayLabel('VOICE')
    : (radioMode.currentMode?.name ? getModeDisplayLabel(radioMode.currentMode.name) : (modeError || t('mode.placeholder')));

  const { measureRef: frequencyMeasureRef, width: frequencySelectWidth } = useMeasuredSelectWidth(
    frequencySelectLabel,
    FREQUENCY_SELECT_MIN_WIDTH_PX,
    FREQUENCY_SELECT_MAX_WIDTH_PX,
  );

  const { measureRef: modeMeasureRef, width: modeSelectWidth } = useMeasuredSelectWidth(
    modeSelectLabel,
    MODE_SELECT_MIN_WIDTH_PX,
    MODE_SELECT_MAX_WIDTH_PX,
  );

  // 自动设置频率到后端（避免递归调用）
  const autoSetFrequency = async (frequency: FrequencyOption) => {
    if (!isRadioConnectedRef.current) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        frequency: frequency.frequency,
        mode: frequency.mode,
        band: frequency.band,
        description: frequency.label
      };
      if (frequency.radioMode) {
        params.radioMode = frequency.radioMode;
      }

      const response = await api.setRadioFrequency(params);

      if (!response.success) {
        logger.debug('Auto set frequency failed:', response.message);
        return;
      }
    } catch (error) {
      logger.debug('Auto set frequency failed:', error);
      // 自动设置失败，静默处理，不影响用户体验
    }
  };

  // 当模式改变时，自动选择第一个匹配的频率（仅数字模式）
  React.useEffect(() => {
    // Skip in voice mode - VoiceFrequencyControl manages its own frequency
    if (radioMode.engineMode === 'voice') return;

    if (filteredFrequencies.length > 0) {
      const currentFreqExists = filteredFrequencies.some(freq => freq.key === selectedFrequencyKey);
      if (!currentFreqExists) {
        const firstFreq = filteredFrequencies[0];
        logger.debug(`Mode changed, auto-selecting first frequency: ${firstFreq.label}`);
        setCurrentFrequency(firstFreq.key);
        setCustomFrequencyOption(null);
        // 自动设置频率到后端
        autoSetFrequency(firstFreq);
      }
    }
  }, [filteredFrequencies, radioMode.engineMode, selectedFrequencyKey]);

  // 处理频率切换
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFrequencyChange = async (keys: any) => {
    if (!connection.state.isConnected) {
      return;
    }

    const selectedFrequencyKey = Array.from(keys)[0] as string;
    if (!selectedFrequencyKey) return;

    // 检查是否选择了自定义频率选项
    if (selectedFrequencyKey === CUSTOM_FREQUENCY_ACTION_KEY) {
      setIsCustomFrequencyModalOpen(true);
      setCustomFrequencyInput('');
      setCustomFrequencyError('');
      // 不改变当前选中的频率
      return;
    }

    if (selectedFrequencyKey === CURRENT_CUSTOM_FREQUENCY_KEY) {
      return;
    }

    const selectedFrequency = filteredFrequencies.find(freq => freq.key === selectedFrequencyKey);
    if (!selectedFrequency) {
      return;
    }

    // Multi-user SDR confirmation: if OpenWebRX has other users, confirm before switching
    if (openwebrxClientCountRef.current > 1) {
      setSdrConfirmPending({ frequency: selectedFrequencyKey, count: openwebrxClientCountRef.current });
      return;
    }

    await executeFrequencySwitch(selectedFrequencyKey, selectedFrequency);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeFrequencySwitch = async (selectedFrequencyKey: string, selectedFrequency: any) => {
    try {
      // 设置频率和电台调制模式
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        frequency: selectedFrequency.frequency,
        mode: selectedFrequency.mode,
        band: selectedFrequency.band,
        description: selectedFrequency.label
      };
      if (selectedFrequency.radioMode) {
        params.radioMode = selectedFrequency.radioMode;
      }

      const response = await api.setRadioFrequency(params);

      if (response.success) {
        setCurrentFrequency(selectedFrequencyKey);
        setCustomFrequencyOption(null);
        resetOperatorsAfterOperatingStateChange();

        const successMessage = selectedFrequency.radioMode
          ? t('frequency.switchedWithMode', { label: selectedFrequency.label, mode: selectedFrequency.radioMode })
          : t('frequency.switchedLabel', { label: selectedFrequency.label });

        if (response.radioConnected) {
          logger.info(`Frequency switched to: ${selectedFrequency.label}`);
          addToast({
            title: t('frequency.switchSuccess'),
            description: successMessage,
            color: 'success',
            timeout: 3000
          });
        } else {
          addToast({
            title: t('frequency.recorded'),
            description: t('frequency.recordedDetail', { message: successMessage }),
            timeout: 4000
          });
        }
      } else {
        logger.error('Frequency switch failed:', response.message);
        addToast({
          title: t('frequency.switchFailed'),
          description: response.message,
          timeout: 5000
        });
      }
    } catch (error) {
      logger.error('Frequency switch failed:', error);
      if (error instanceof ApiError) {
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        addToast({
          title: t('frequency.switchFailed'),
          description: t('error.networkError'),
          timeout: 5000
        });
      }
    }
  };

  // Voice monitor mute: TX has priority, then software squelch gates output gain.
  useEffect(() => {
    const squelchStatus = radioState.squelchStatus;
    const localVoiceTxActive = voiceCaptureController?.isPTTActive ?? false;
    const voiceKeyerTxActive = voicePttLock?.locked && isVoiceKeyerLockHolder(voicePttLock.lockedBy);
    const isTransmitting = pttStatus.isTransmitting || localVoiceTxActive;
    const shouldMute = radioMode.engineMode === 'voice'
      && !voiceKeyerTxActive
      && (isTransmitting || (squelchStatus.supported && squelchStatus.open === false));
    const targetDb = shouldMute ? -60 : gainToDb(monitorVolume);
    audioMonitor.setVolume(targetDb);
  }, [audioMonitor, pttStatus.isTransmitting, voiceCaptureController?.isPTTActive, voicePttLock?.locked, voicePttLock?.lockedBy, radioMode.engineMode, monitorVolume, radioState.squelchStatus]);

  // 监听频率变化事件
  useEffect(() => {
    if (!connection.state.radioService) return;

    // 直接订阅 WSClient 事件
    const wsClient = connection.state.radioService.wsClientInstance;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleFrequencyChanged = (data: any) => {
      const frequencyKey = String(data.frequency);
      setCurrentFrequency(frequencyKey);

      // 检查是否是预设频率（在所有可用频率中查找，不仅仅是已筛选的）
      const isPreset = availableFrequencies.some(f => f.key === frequencyKey);

      if (!isPreset) {
        // 自定义频率：创建临时选项并添加到列表
        const customOption = buildCurrentCustomFrequencyOption(
          data.frequency,
          data.mode || 'FT8',
          data.band || '',
          data.radioMode,
        );
        setCustomFrequencyOption(customOption);
        logger.debug('Custom frequency option added:', customOption.label);
      } else {
        // 预设频率：清除自定义选项
        setCustomFrequencyOption(null);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('frequencyChanged', handleFrequencyChanged as any);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('frequencyChanged', handleFrequencyChanged as any);
    };
  }, [buildCurrentCustomFrequencyOption, connection.state.radioService, availableFrequencies]);

  return (
    <div className="relative flex flex-col gap-0 bg-content2 dark:bg-content1 px-4 py-2 pt-3 rounded-lg cursor-default select-none">
      <span ref={frequencyMeasureRef} aria-hidden="true" className={SELECT_TEXT_MEASURE_CLASS}>
        {frequencySelectLabel}
      </span>
      <span ref={modeMeasureRef} aria-hidden="true" className={SELECT_TEXT_MEASURE_CLASS}>
        {modeSelectLabel}
      </span>
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RadioStatus
            connection={connection.state}
            radioConnection={{
              ...radioConnection,
              isDecoding: radioMode.isDecoding,
            }}
            profileName={activeProfile?.name}
            onPress={radioConnection.radioConnected ? () => setIsControlPanelOpen(true) : (isAdmin ? onOpenRadioSettings : undefined)}
            canConfigure={isAdmin}
            canOperate={isOperator}
          />
          <div className="flex items-center gap-0">
            {canOpenRadioControl && (
              <ToolbarIconTooltip label={t('control.openRadioControl')}>
                <Button
                  isIconOnly
                  variant="light"
                  size="sm"
                  className="text-default-400 min-w-unit-6 min-w-6 w-6 h-6"
                  aria-label={t('control.openRadioControl')}
                  onPress={() => setIsControlPanelOpen(true)}
                >
                  <FontAwesomeIcon icon={faSlidersH} className="text-xs" />
                </Button>
              </ToolbarIconTooltip>
            )}
            {isAdmin && (
              <ToolbarIconTooltip label={t('control.radioSettings')}>
                <Button
                  isIconOnly
                  variant="light"
                  size="sm"
                  className="text-default-400 min-w-unit-6 min-w-6 w-6 h-6"
                  aria-label={t('control.radioSettings')}
                  onPress={onOpenRadioSettings}
                >
                  <FontAwesomeIcon icon={faCog} className="text-xs" />
                </Button>
              </ToolbarIconTooltip>
            )}
            {isOperator && (
              <ToolbarIconTooltip label={t('control.txVolumeGain')}>
                <Popover>
                  <PopoverTrigger>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      className="text-default-400 min-w-unit-6 min-w-6 w-6 h-6"
                      aria-label={t('control.txVolumeGain')}
                    >
                      <FontAwesomeIcon icon={faVolumeUp} className="text-xs" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto min-w-0 px-3 py-2 pt-3">
                    <TxVolumeGainControl
                      orientation="vertical"
                      sliderClassName="w-10"
                      sliderStyle={{ height: '120px' }}
                      ariaLabel={t('control.volumeControl')}
                    />
                  </PopoverContent>
                </Popover>
              </ToolbarIconTooltip>
            )}
            {monitorActivationCta.shouldShowActivationCta ? (
              <Button
                size="sm"
                variant="flat"
                color="primary"
                className="h-6 min-w-0 px-2 text-xs font-medium"
                onPress={toggleMonitoring}
                isDisabled={!connection.state.isConnected}
                aria-label={t('monitor.activateAudioMonitor')}
              >
                <FontAwesomeIcon icon={faHeadphones} className="text-xs" />
                {t('monitor.activateAudioMonitor')}
              </Button>
            ) : (
              <ToolbarIconTooltip label={t('monitor.audioMonitor')}>
                <Popover>
                  <PopoverTrigger>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      className={`min-w-unit-6 min-w-6 w-6 h-6 ${audioMonitor.isPlaying ? 'text-success' : 'text-default-400'}`}
                      aria-label={t('monitor.audioMonitor')}
                    >
                      <FontAwesomeIcon icon={faHeadphones} className="text-xs" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto min-w-52 max-w-[calc(100vw-2rem)] px-3 py-3">
                    <div className="w-max max-w-[min(20rem,calc(100vw-4rem))] space-y-3">
                      <div className="font-medium text-sm text-default-700">
                        {t('monitor.audioMonitor')}
                      </div>

                      {/* 监听音量滑块 */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-default-500">{t('monitor.monitorVolume')}</span>
                          <span className="font-mono text-default-400">
                            {formatDbDisplay(gainToDb(monitorVolume))}
                          </span>
                        </div>
                        <Slider
                          className="w-48 max-w-full"
                          minValue={-60}
                          maxValue={20}
                          step={0.1}
                          value={[gainToDb(monitorVolume)]}
                          onChange={handleMonitorVolumeChange}
                          onWheel={handleMonitorVolumeWheel}
                          aria-label={t('monitor.monitorVolume')}
                        />
                      </div>

                      {/* 状态指示器 */}
                      {audioMonitor.isPlaying && (
                        <div className="space-y-2 pt-2 border-t border-divider text-xs">
                          {audioMonitor.stats && (
                            <>
                              <div className="grid grid-cols-[auto_auto] gap-x-5 gap-y-1">
                                <span className="text-default-500">{t('monitor.latency')}</span>
                                <span
                                  className={`font-mono text-right whitespace-nowrap ${
                                    audioMonitor.stats.endToEndLatencyMs == null ? 'text-default-400' :
                                    audioMonitor.stats.endToEndLatencyMs < 150 ? 'text-success' :
                                    audioMonitor.stats.endToEndLatencyMs <= 300 ? 'text-warning' :
                                    'text-danger'
                                  }`}
                                  title={
                                    audioMonitor.stats.endToEndLatencyMs == null
                                      ? undefined
                                      : `${t('monitor.sourceToSend')}: ${audioMonitor.stats.sourceToSendMs?.toFixed(0) ?? '-'}ms · ${t('monitor.transport')}: ${audioMonitor.stats.transportMs?.toFixed(0) ?? audioMonitor.stats.networkAgeMs?.toFixed(0) ?? '-'}ms · ${t('monitor.enqueue')}: ${audioMonitor.stats.mainToWorkletMs?.toFixed(0) ?? '-'}ms · ${t('monitor.buffer')}: ${audioMonitor.stats.playbackQueueMs.toFixed(0)}ms · ${t('monitor.output')}: ${audioMonitor.stats.outputDeviceLatencyMs.toFixed(0)}ms · RTT: ${audioMonitor.stats.clockRttMs?.toFixed(0) ?? '-'}ms`
                                  }
                                >
                                  {audioMonitor.stats.endToEndLatencyMs == null
                                    ? t('monitor.estimating')
                                    : `${audioMonitor.stats.endToEndLatencyMs.toFixed(0)}ms`}
                                </span>

                                <span className="text-default-500">{t('monitor.buffer')}</span>
                                <span className="font-mono text-default-400 text-right whitespace-nowrap">
                                  {audioMonitor.stats.playbackQueueMs.toFixed(0)}
                                  /
                                  {audioMonitor.stats.receiver?.targetBufferMs?.toFixed(0) ?? '-'}ms
                                </span>

                                <span className="text-default-500">{t('monitor.audioPath')}</span>
                                <span className="font-mono text-default-400 text-right whitespace-nowrap">
                                  {audioMonitor.stats.receiver?.codec === 'opus' ? 'Opus' : 'PCM'}
                                  {' · '}
                                  {getMonitorTransportLabel(audioMonitor.transportKind)}
                                </span>

                                <span className="text-default-500">{t('monitor.bitrate')}</span>
                                <span className="font-mono text-default-400 text-right whitespace-nowrap">
                                  {formatBitrateMetric(audioMonitor.stats.receiver?.bitrateKbps)}
                                </span>
                              </div>

                              <div className="space-y-1 pt-1 border-t border-divider">
                                <div className="inline-flex items-center gap-1 text-default-500">
                                  {t('monitor.codecPreference')}
                                  <Tooltip
                                    size="sm"
                                    placement="top"
                                    content={t('monitor.codecPreferenceHelp')}
                                    classNames={{ content: 'max-w-56 whitespace-normal text-xs leading-snug' }}
                                  >
                                    <span
                                      className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center text-default-400"
                                      aria-label={t('monitor.codecPreferenceHelp')}
                                    >
                                      <FontAwesomeIcon icon={faCircleInfo} className="text-[11px]" />
                                    </span>
                                  </Tooltip>
                                </div>
                                <Tabs
                                  size="sm"
                                  fullWidth
                                  selectedKey={monitorAudioCodecPreference}
                                  onSelectionChange={(key) => {
                                    void handleMonitorCodecPreferenceChange(key as RealtimeAudioCodecPreference);
                                  }}
                                  isDisabled={isSwitchingMonitorTransport}
                                  aria-label={t('monitor.codecPreference')}
                                  classNames={{
                                    tabList: 'gap-1 p-0.5',
                                    tab: 'h-6 px-1 text-[11px]',
                                  }}
                                >
                                  {REALTIME_AUDIO_CODEC_PREFERENCES.map((preference) => (
                                    <Tab key={preference} title={getAudioCodecPreferenceLabel(preference)} />
                                  ))}
                                </Tabs>
                                {audioMonitor.stats.receiver?.codecFallbackReason
                                  && audioMonitor.stats.receiver.codecFallbackReason !== 'client-forced-pcm' && (
                                  <div className="text-[11px] text-warning text-center">
                                    {t('monitor.codecFallbackPcm')}
                                  </div>
                                )}
                              </div>

                              <div className="space-y-1 pt-1 border-t border-divider">
                                <div className="flex items-center justify-between gap-2 text-default-500">
                                  <span className="inline-flex items-center gap-1">
                                    {t('monitor.bufferPolicy')}
                                    <Tooltip
                                      size="sm"
                                      placement="top"
                                      content={t('monitor.bufferPolicyHelp')}
                                      classNames={{ content: 'max-w-52 whitespace-normal text-xs leading-snug' }}
                                    >
                                      <span
                                        className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center text-default-400"
                                        aria-label={t('monitor.bufferPolicyHelp')}
                                      >
                                        <FontAwesomeIcon icon={faCircleInfo} className="text-[11px]" />
                                      </span>
                                    </Tooltip>
                                  </span>
                                </div>
                                <Tabs
                                  size="sm"
                                  fullWidth
                                  selectedKey={selectedMonitorBufferProfile}
                                  onSelectionChange={(key) => handleMonitorBufferProfileChange(key as MonitorPlaybackBufferProfile)}
                                  isDisabled={isMonitorBufferControlDisabled}
                                  aria-label={t('monitor.bufferPolicy')}
                                  classNames={{
                                    tabList: 'gap-1 p-0.5',
                                    tab: 'h-6 px-1 text-[11px]',
                                  }}
                                >
                                  {MONITOR_PLAYBACK_BUFFER_PROFILES.map((profile) => (
                                    <Tab key={profile} title={getMonitorPlaybackBufferProfileLabel(profile)} />
                                  ))}
                                </Tabs>
                                {selectedMonitorBufferProfile === 'custom' && (
                                  <Input
                                    size="sm"
                                    type="number"
                                    min={MONITOR_PLAYBACK_BUFFER_CUSTOM_MIN_MS}
                                    max={MONITOR_PLAYBACK_BUFFER_CUSTOM_MAX_MS}
                                    step={MONITOR_PLAYBACK_BUFFER_CUSTOM_STEP_MS}
                                    value={String(monitorCustomBufferMs)}
                                    onValueChange={handleMonitorCustomBufferChange}
                                    isDisabled={isMonitorBufferControlDisabled}
                                    label={t('monitor.customBufferTarget')}
                                    labelPlacement="outside-left"
                                    endContent={<span className="text-[11px] text-default-400">ms</span>}
                                    classNames={{
                                      base: 'pt-1',
                                      label: 'text-[11px] text-default-500',
                                      input: 'text-right font-mono text-xs',
                                    }}
                                  />
                                )}
                              </div>
                            </>
                          )}

                          <Button
                            size="sm"
                            variant="flat"
                            color={audioMonitor.transportKind === 'ws-compat' ? 'primary' : 'warning'}
                            className="w-full h-7"
                            onPress={handleSwitchMonitorTransport}
                            isLoading={isSwitchingMonitorTransport}
                            isDisabled={!audioMonitor.transportKind || isSwitchingMonitorTransport}
                          >
                            {audioMonitor.transportKind === 'ws-compat'
                              ? t('monitor.switchToWebrtc')
                              : t('monitor.switchToWsPcm')}
                          </Button>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-6 pt-2 border-t border-divider text-xs">
                        <span className="text-default-500">{t('monitor.monitorSwitch')}</span>
                        <Switch
                          size="sm"
                          isSelected={audioMonitor.isPlaying}
                          onValueChange={toggleMonitoring}
                          aria-label={t('monitor.monitorSwitch')}
                        />
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </ToolbarIconTooltip>
            )}
            {radioMode.engineMode === 'voice' && isOperator && voiceCaptureController && (
              <ToolbarIconTooltip label={t('voiceTx.audioUplink')}>
                <Popover
                  isOpen={isVoiceTxPopoverOpen}
                  onOpenChange={setIsVoiceTxPopoverOpen}
                >
                  <PopoverTrigger>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      className={`min-w-unit-6 min-w-6 w-6 h-6 ${
                        voiceCaptureController.isPTTActive
                          ? 'text-danger'
                          : currentVoiceTransport
                          ? 'text-success'
                          : 'text-default-400'
                      }`}
                      aria-label={t('voiceTx.audioUplink')}
                    >
                      <FontAwesomeIcon icon={faMicrophone} className="text-xs" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto min-w-0 max-w-[calc(100vw-2rem)] px-3 py-3">
                    <div className="w-max max-w-[min(16rem,calc(100vw-4rem))] space-y-3 text-xs">
                      <div className="font-medium text-sm text-default-700">
                        {t('voiceTx.audioUplink')}
                      </div>

                      <div className="grid grid-cols-[auto_auto] gap-x-5 gap-y-1">
                        <span className="text-default-500">{t('voiceTx.status')}</span>
                        <span className="font-mono text-default-400 text-right whitespace-nowrap">
                          {voiceTxStatusLabel}
                        </span>

                        <span className="text-default-500">{t('voiceTx.audioPath')}</span>
                        <span className="font-mono text-default-400 text-right whitespace-nowrap">
                          {voiceTxAudioPathSummary}
                        </span>

                        <span className="text-default-500">{t('voiceTx.bitrate')}</span>
                        <span className="font-mono text-default-400 text-right whitespace-nowrap">
                          {formatBitrateMetric(voiceTxBitrateKbps)}
                        </span>

                        <span className="text-default-500">{t('voiceTx.endToEndLatency')}</span>
                        <span className={`font-mono text-right whitespace-nowrap ${voiceTxLatencyClassName}`}>
                          {voiceTxDiagnostics?.display.endToEndLatencyMs != null
                            ? formatLatencyMetric(voiceTxDiagnostics.display.endToEndLatencyMs)
                            : t('voiceTx.endToEndLatencyUnavailable')}
                        </span>

                        <span className="text-default-500">{t('voiceTx.stability')}</span>
                        <span className={`font-mono text-right whitespace-nowrap ${
                          isVoiceTxCustomBufferMode && voiceTxDiagnostics?.display.underrunIncreasingTrend
                            ? 'text-danger'
                            : 'text-default-400'
                        }`}>
                          {voiceTxStabilityLabel}
                        </span>
                      </div>

                      <div className="space-y-1.5 border-t border-divider pt-2">
                        <div className="flex justify-between items-center gap-4">
                          <span className="inline-flex items-center gap-1 text-default-500">
                            {t('voiceTx.bufferPolicy')}
                            <Tooltip
                              size="sm"
                              placement="top"
                              content={t('voiceTx.bufferPolicyHelp')}
                              classNames={{ content: 'max-w-52 whitespace-normal text-xs leading-snug' }}
                            >
                              <span
                                className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center text-default-400"
                                aria-label={t('voiceTx.bufferPolicyHelp')}
                              >
                                <FontAwesomeIcon icon={faCircleInfo} className="text-[11px]" />
                              </span>
                            </Tooltip>
                          </span>
                          <span className="font-mono text-default-400 text-right whitespace-nowrap">
                            {voiceTxBufferPolicySummary}
                          </span>
                        </div>
                        <Tabs
                          size="sm"
                          fullWidth
                          selectedKey={selectedVoiceTxBufferProfile}
                          onSelectionChange={(key) => handleVoiceTxBufferProfileChange(key as VoiceTxBufferProfile)}
                          isDisabled={isVoiceTxBufferControlDisabled}
                          aria-label={t('voiceTx.bufferPolicy')}
                          classNames={{
                            tabList: 'gap-1 p-0.5',
                            tab: 'h-6 px-1 text-[11px]',
                          }}
                        >
                          {VOICE_TX_BUFFER_PROFILES.map((profile) => (
                            <Tab key={profile} title={getVoiceTxBufferProfileLabel(profile)} />
                          ))}
                        </Tabs>
                        {selectedVoiceTxBufferProfile === 'custom' && (
                          <Input
                            size="sm"
                            type="number"
                            min={40}
                            max={500}
                            step={10}
                            value={String(voiceTxCustomBufferMs)}
                            onValueChange={handleVoiceTxCustomBufferChange}
                            isDisabled={isVoiceTxBufferControlDisabled}
                            label={t('voiceTx.customBufferTarget')}
                            labelPlacement="outside-left"
                            endContent={<span className="text-[11px] text-default-400">ms</span>}
                            classNames={{
                              base: 'pt-1',
                              label: 'text-[11px] text-default-500',
                              input: 'text-right font-mono text-xs',
                            }}
                          />
                        )}
                        {voiceCaptureController.isPTTActive && (
                          <div className="text-[11px] text-warning text-center">
                            {t('voiceTx.bufferPolicyDisabledDuringTx')}
                          </div>
                        )}
                        {isVoiceTxCustomBufferMode && voiceTxDiagnostics?.display.underrunIncreasingTrend && (
                          <div className="w-full min-w-0 max-w-full rounded-md bg-danger/10 px-2 py-1 text-[11px] leading-snug text-danger whitespace-normal break-words">
                            {t('voiceTx.underrunTrendWarning')}
                          </div>
                        )}
                      </div>

                      <div className="space-y-1.5 border-t border-divider pt-2">
                        <div className="inline-flex items-center gap-1 text-default-500">
                          {t('monitor.codecPreference')}
                          <Tooltip
                            size="sm"
                            placement="top"
                            content={t('monitor.codecPreferenceHelp')}
                            classNames={{ content: 'max-w-56 whitespace-normal text-xs leading-snug' }}
                          >
                            <span
                              className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center text-default-400"
                              aria-label={t('monitor.codecPreferenceHelp')}
                            >
                              <FontAwesomeIcon icon={faCircleInfo} className="text-[11px]" />
                            </span>
                          </Tooltip>
                        </div>
                        <Tabs
                          size="sm"
                          fullWidth
                          selectedKey={voiceCaptureController.audioCodecPreference}
                          onSelectionChange={(key) => handleVoiceCodecPreferenceChange(key as RealtimeAudioCodecPreference)}
                          isDisabled={voiceCaptureController.isPTTActive || voiceCaptureController.captureState === 'starting'}
                          aria-label={t('monitor.codecPreference')}
                          classNames={{
                            tabList: 'gap-1 p-0.5',
                            tab: 'h-6 px-1 text-[11px]',
                          }}
                        >
                          {REALTIME_AUDIO_CODEC_PREFERENCES.map((preference) => (
                            <Tab key={preference} title={getAudioCodecPreferenceLabel(preference)} />
                          ))}
                        </Tabs>
                        {voiceCaptureController.activeAudioCodecPolicy?.fallbackReason
                          && voiceCaptureController.activeAudioCodecPolicy.fallbackReason !== 'client-forced-pcm' && (
                          <div className="text-[11px] text-warning text-center">
                            {t('monitor.codecFallbackPcm')}
                          </div>
                        )}
                      </div>

                      {voiceTxDiagnostics?.serverOutput.writeFailures > 0 && (
                        <div className="flex justify-between items-center gap-3 text-[11px] text-warning-500">
                            <span>{t('voiceTx.writeFailures')}</span>
                            <span className="font-mono">
                              {formatIntegerMetric(voiceTxDiagnostics.serverOutput.writeFailures)}
                            </span>
                          </div>
                      )}

                      <Button
                        size="sm"
                        variant="flat"
                        color={effectiveVoiceTransport === 'ws-compat' ? 'primary' : 'warning'}
                        className="w-full h-7"
                        onPress={handleSwitchVoiceTransport}
                        isLoading={isSwitchingVoiceTransport}
                        isDisabled={isSwitchingVoiceTransport || voiceCaptureController.isPTTActive || voiceCaptureController.captureState === 'starting'}
                      >
                        {effectiveVoiceTransport === 'ws-compat'
                          ? t('monitor.switchToWebrtc')
                          : t('monitor.switchToWsPcm')}
                      </Button>

                      {voiceCaptureController.isPTTActive && (
                        <div className="text-[11px] text-warning text-center">
                          {t('voiceTx.switchDisabledDuringTx')}
                        </div>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </ToolbarIconTooltip>
            )}
            {/* 天调控制：已连接且具备电台控制权限时统一露出内置/外接天调入口 */}
            {showAntennaTuneEntry && (
              <ToolbarIconTooltip label={t('tuner.control')}>
                <Popover>
                  <PopoverTrigger>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      className={`min-w-unit-6 min-w-6 w-6 h-6 ${
                        tuneToneActive
                          ? 'text-danger animate-pulse'
                          : tunerIsTuning
                          ? 'text-warning animate-pulse'
                          : tunerEnabled
                          ? 'text-success'
                          : 'text-default-400'
                      }`}
                      aria-label={t('tuner.control')}
                    >
                      <FontAwesomeIcon icon={faTowerBroadcast} className="text-xs" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="max-w-[calc(100vw-2rem)]">
                    <TunerCapabilitySurface />
                  </PopoverContent>
                </Popover>
              </ToolbarIconTooltip>
            )}
          </div>
        </div>
      </div>

      {/* 电台错误内联提示 */}
      {connection.state.isConnected && latestError && [
        RadioConnectionStatus.DISCONNECTED,
        RadioConnectionStatus.CONNECTION_LOST,
        RadioConnectionStatus.RECONNECTING,
      ].includes(radioConnection.radioConnectionStatus) && (
        <Alert
          color="danger"
          variant="flat"
          className="mt-1.5 -mx-1"
          classNames={{ base: 'py-1 px-2 min-h-0 items-center', mainWrapper: 'ms-0 min-h-0', iconWrapper: 'w-5 h-5', alertIcon: 'w-3' }}
          endContent={
            <Button
              size="sm"
              variant="light"
              color="danger"
              className="h-5 px-2 text-xs min-w-0 shrink-0"
              onPress={() => setIsErrorHistoryOpen(true)}
            >
              {t('error.details')}
            </Button>
          }
        >
          <span className="text-xs">
            {latestError.userMessageKey && i18n.exists(latestError.userMessageKey)
              ? t(latestError.userMessageKey, latestError.userMessageParams ?? {})
              : latestError.userMessage}
          </span>
        </Alert>
      )}
      <RadioErrorHistoryModal
        isOpen={isErrorHistoryOpen}
        onClose={() => setIsErrorHistoryOpen(false)}
      />
      <RadioControlPanel
        isOpen={isControlPanelOpen && canOpenRadioControl}
        onClose={() => setIsControlPanelOpen(false)}
      />

      {/* 主控制区域 */}
      <div className="flex items-center">
        {/* 左侧选择器 */}
        <div className="flex gap-1 flex-1 min-w-0 -ml-3">
          {canSetFrequency ? (
            <Select
              disableSelectorIconRotation
              fullWidth={false}
              className="min-w-0"
              style={{ width: frequencySelectWidth, maxWidth: '100%' }}
              labelPlacement="outside"
              placeholder={radioMode.currentMode ? `${radioMode.currentMode.name} ${t('control.frequency')}` : t('control.frequency')}
              selectorIcon={<SelectorIcon />}
              selectedKeys={selectedFrequencyKey ? [selectedFrequencyKey] : []}
              variant="flat"
              size="md"
              radius="md"
              aria-label={t('control.selectFrequency')}
              classNames={{
                base: "min-w-0",
                trigger: "font-bold text-lg border-0 bg-transparent hover:border-1 hover:border-default-300 transition-all duration-200 shadow-none",
                value: "font-bold text-lg",
                innerWrapper: "shadow-none",
                mainWrapper: "shadow-none"
              }}
              isDisabled={!connection.state.isConnected || isLoadingFrequencies || !canWriteFrequency}
              isLoading={isLoadingFrequencies}
              onSelectionChange={handleFrequencyChange}
              renderValue={() => {
                return selectedFrequencyOption ? <span className="font-bold text-lg">{selectedFrequencyOption.label}</span> : null;
              }}
            >
              {[...filteredFrequencies.map((frequency) => (
                <SelectItem key={frequency.key} textValue={frequency.label}>
                  {frequency.label}
                </SelectItem>
              )),
              <SelectItem key={CUSTOM_FREQUENCY_ACTION_KEY} textValue={t('frequency.customOption')} className="text-primary">
                {t('frequency.customOption')}
              </SelectItem>]}
            </Select>
          ) : (
            <div className="flex items-center pl-3 pr-2 h-10 cursor-not-allowed">
              <span className="font-bold text-lg text-default-foreground truncate">
                {selectedFrequencyOption?.label || ''}
              </span>
            </div>
          )}
          {canSwitchMode ? (
            <Select
              disableSelectorIconRotation
              fullWidth={false}
              className="min-w-0"
              style={{ width: modeSelectWidth, maxWidth: '100%' }}
              labelPlacement="outside"
              placeholder={modeError || t('mode.placeholder')}
              selectorIcon={<SelectorIcon />}
              selectedKeys={radioMode.engineMode === 'voice' ? ['VOICE'] : (radioMode.currentMode ? [radioMode.currentMode.name] : [])}
              variant="flat"
              size="md"
              radius="md"
              aria-label={t('control.selectMode')}
              classNames={{
                base: "min-w-0",
                trigger: "font-bold text-lg border-0 bg-transparent hover:border-1 hover:border-default-300 transition-all duration-200 shadow-none",
                value: "font-bold text-lg",
                innerWrapper: "shadow-none",
                mainWrapper: "shadow-none"
              }}
              isDisabled={!connection.state.isConnected || isLoadingModes}
              onSelectionChange={handleModeChange}
              isLoading={isLoadingModes}
              renderValue={() => (
                <span className="font-bold text-lg">{modeSelectLabel}</span>
              )}
            >
              {modeOptions.map((mode) => (
                <SelectItem
                  key={mode.name}
                  textValue={getModeDisplayLabel(mode.name)}
                  className="text-xs py-1 px-2 min-h-6"
                >
                  {getModeDisplayLabel(mode.name)}
                </SelectItem>
              ))}
            </Select>
          ) : (
            <div className="flex items-center px-2 h-10 cursor-not-allowed">
              <span className="font-bold text-lg text-default-foreground">
                {modeSelectLabel}
              </span>
            </div>
          )}
        </div>
        
        {/* 右侧开关 */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-default-600 hidden sm:inline">
              {t('monitor.listen')}
            </span>
            <Switch 
              isSelected={radioMode.isDecoding} 
              onValueChange={handleListenToggle}
              size="sm"
              color="primary"
              isDisabled={!connection.state.isConnected || isTogglingListen || !canStartStopEngine}
              aria-label={t('monitor.toggleListen')}
              className={isTogglingListen ? 'opacity-50 pointer-events-none' : ''}
            />
          </div>
        </div>
      </div>

      {/* SDR multi-user frequency switch confirmation */}
      <Modal
        isOpen={!!sdrConfirmPending}
        onClose={() => setSdrConfirmPending(null)}
        placement="center"
        size="sm"
      >
        <ModalContent>
          <ModalHeader>{t('openwebrx.clientConfirm.title')}</ModalHeader>
          <ModalBody>
            <p className="text-sm text-default-600">
              {t('openwebrx.clientConfirm.message', { count: sdrConfirmPending?.count ?? 0 })}
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setSdrConfirmPending(null)}>
              {t('openwebrx.clientConfirm.cancel')}
            </Button>
            <Button color="primary" onPress={() => {
              if (sdrConfirmPending) {
                const freq = filteredFrequencies.find(f => f.key === sdrConfirmPending.frequency);
                if (freq) {
                  executeFrequencySwitch(sdrConfirmPending.frequency, freq);
                }
              }
              setSdrConfirmPending(null);
            }}>
              {t('openwebrx.clientConfirm.confirm')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 自定义频率输入模态框 */}
      <Modal
        isOpen={isCustomFrequencyModalOpen}
        onClose={() => {
          setIsCustomFrequencyModalOpen(false);
          setCustomFrequencyInput('');
          setCustomFrequencyError('');
        }}
        placement="center"
        size="sm"
      >
        <ModalContent>
          <ModalHeader>
            <h3 className="text-lg font-semibold">{t('frequency.customTitle')}</h3>
          </ModalHeader>
          <ModalBody>
            <Input
              autoFocus
              label={t('control.frequency')}
              placeholder={t('frequency.inputPlaceholder')}
              value={customFrequencyInput}
              onValueChange={handleCustomFrequencyInputChange}
              variant="flat"
              isInvalid={!!customFrequencyError}
              errorMessage={customFrequencyError}
              description={
                customFrequencyInput && !customFrequencyError && parseFrequencyInput(customFrequencyInput)?.frequency
                  ? t('frequency.willSet', { freq: formatFrequencyDisplay(parseFrequencyInput(customFrequencyInput)!.frequency) })
                  : t('frequency.inputHint')
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isSettingCustomFrequency) {
                  handleCustomFrequencyConfirm();
                } else if (e.key === 'Escape') {
                  setIsCustomFrequencyModalOpen(false);
                  setCustomFrequencyInput('');
                  setCustomFrequencyError('');
                }
              }}
            />
          </ModalBody>
          <ModalFooter>
            <Button
              color="default"
              variant="flat"
              onPress={() => {
                setIsCustomFrequencyModalOpen(false);
                setCustomFrequencyInput('');
                setCustomFrequencyError('');
              }}
              isDisabled={isSettingCustomFrequency}
            >
              {t('common:button.cancel')}
            </Button>
            <Button
              color="primary"
              onPress={handleCustomFrequencyConfirm}
              isLoading={isSettingCustomFrequency}
              isDisabled={!customFrequencyInput.trim()}
            >
              {t('frequency.confirm')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};
