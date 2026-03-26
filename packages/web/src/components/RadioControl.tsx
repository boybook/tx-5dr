import * as React from 'react';
import {Select, SelectItem, Switch, Button, Slider, Popover, PopoverTrigger, PopoverContent, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Input, Spinner, Alert} from "@heroui/react";
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog, faChevronDown, faVolumeUp, faHeadphones, faRadio, faSlidersH } from '@fortawesome/free-solid-svg-icons';
import { useConnection, useRadioState, useProfiles, useRadioErrors } from '../store/radioStore';
import { RadioErrorHistoryModal } from './RadioErrorHistoryModal';
import { api, ApiError } from '@tx5dr/core';
import type { ModeDescriptor, TunerStatus } from '@tx5dr/contracts';
import type { ConnectionState, RadioState } from '../store/radioStore';
import { RadioConnectionStatus, UserRole } from '@tx5dr/contracts';
import { subject as caslSubject } from '@casl/ability';
import { showErrorToast } from '../utils/errorToast';
import { useHasMinRole, useCan, useAbility } from '../store/authStore';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioMonitorPlayback } from '../hooks/useAudioMonitorPlayback';
import { useWSEvent } from '../hooks/useWSEvent';
import { createLogger } from '../utils/logger';

const logger = createLogger('RadioControl');

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

// 电台连接状态指示器组件
const RadioStatus: React.FC<{ connection: ConnectionState; radio: { state: RadioState }; profileName?: string | null; onPress?: () => void; canConfigure?: boolean; canOperate?: boolean }> = ({ connection, radio, profileName, onPress, canConfigure = true, canOperate = true }) => {
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
    const config = radio.state.radioConfig;
    if (radio.state.radioInfo) {
      return `${radio.state.radioInfo.manufacturer} ${radio.state.radioInfo.model}`;
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

  const status = radio.state.radioConnectionStatus;
  const label = profileName || getRadioModelText();

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
          </div>
        );

      case RadioConnectionStatus.RECONNECTING: {
        const progress = radio.state.reconnectProgress;
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
            {canOperate && radio.state.radioConfig?.type && radio.state.radioConfig.type !== 'none' && !radio.state.isDecoding && (
              <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                <Button
                  size="sm"
                  color="primary"
                  variant="flat"
                  onPress={() => connection.radioService?.startDecoding()}
                  className="h-6 px-2 text-xs"
                >
                  {t('status.connect')}
                </Button>
              </span>
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
}

export const RadioControl: React.FC<RadioControlProps> = ({ onOpenRadioSettings }) => {
  const { t } = useTranslation('radio');
  const connection = useConnection();
  const radio = useRadioState();
  const { activeProfile } = useProfiles();
  const { latestError } = useRadioErrors();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const isOperator = useHasMinRole(UserRole.OPERATOR);
  const canSetFrequency = useCan('execute', 'RadioFrequency');
  const canSwitchMode = useCan('execute', 'ModeSwitch');
  const canStartStopEngine = useCan('execute', 'Engine');
  const canSetTuner = useCan('execute', 'RadioTuner');
  const canManualTune = useCan('execute', 'RadioTune');
  const ability = useAbility();
  const [isErrorHistoryOpen, setIsErrorHistoryOpen] = useState(false);
  const [availableModes, setAvailableModes] = useState<ModeDescriptor[]>([]);
  const [isLoadingModes, setIsLoadingModes] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [availableFrequencies, setAvailableFrequencies] = useState<FrequencyOption[]>([]);
  const [isLoadingFrequencies, setIsLoadingFrequencies] = useState(false);
  const [currentFrequency, setCurrentFrequency] = useState<string>('14074000');

  // 简化的UI状态管理
  const [isTogglingListen, setIsTogglingListen] = useState(false);

  const [volumeGain, setVolumeGain] = useState(1.0);

  // 音频监听 (reusable hook)
  const audioMonitor = useAudioMonitorPlayback({ wsPath: '/ws/audio-monitor' });
  const [monitorVolume, setMonitorVolume] = useState(1.0); // 监听音量（线性增益）

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
  const [_customFrequencyLabel, setCustomFrequencyLabel] = useState<string>(''); // 保存自定义频率的显示标签
  const [customFrequencyOption, setCustomFrequencyOption] = useState<FrequencyOption | null>(null); // 保存自定义频率选项

  // 天调能力从全局 store 读取（由 radioStatusChanged 事件推送，连接时更新）
  const tunerCapabilities = radio.state.tunerCapabilities;

  // 天调相关状态
  const [tunerStatus, setTunerStatus] = useState<TunerStatus>({
    enabled: false,
    active: false,
    status: 'idle'
  });
  const [isTunerLoading, setIsTunerLoading] = useState(false);

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
  }, [connection.state.isConnected]);

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
            label: preset.description || `${preset.band} ${(preset.frequency / 1000000).toFixed(3)} MHz`,
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
      if (!connection.state.isConnected || availableFrequencies.length === 0) {
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

          if (matchingFreq && radio.state.currentMode?.name === lastFreq.mode) {
            logger.debug(`Restoring last frequency: ${matchingFreq.label}`);
            setCurrentFrequency(matchingFreq.key);
            // 自动设置频率到电台
            autoSetFrequency(matchingFreq);
          }
        }
      } catch (error) {
        logger.error('Failed to load last frequency:', error);
        // 静默失败，不影响用户体验
      }
    };

    // 延迟执行，等待频率列表和模式都加载完成
    if (availableFrequencies.length > 0 && radio.state.currentMode) {
      setTimeout(loadLastFrequency, 500);
    }
  }, [availableFrequencies, radio.state.currentMode, connection.state.isConnected]);



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

  // 处理音量变化（现在使用dB单位）
  const handleVolumeChange = (value: number | number[]) => {
    const dbValue = Array.isArray(value) ? value[0] : value;
    // 确保dB值有效
    if (!isNaN(dbValue) && dbValue >= -60 && dbValue <= 20) {
      const gainValue = dbToGain(dbValue);
      setVolumeGain(gainValue);
      // 使用新的dB API发送到后端
      connection.state.radioService?.setVolumeGainDb(dbValue);
    }
  };

  // 监听音量变化
  const handleMonitorVolumeChange = (value: number | number[]) => {
    const dbValue = Array.isArray(value) ? value[0] : value;
    if (!isNaN(dbValue) && dbValue >= -60 && dbValue <= 20) {
      const gainValue = dbToGain(dbValue);
      setMonitorVolume(gainValue);
      audioMonitor.setVolume(dbValue);
    }
  };

  // 切换监听状态
  const toggleMonitoring = async () => {
    if (audioMonitor.isPlaying) {
      audioMonitor.stop();
    } else {
      try {
        await audioMonitor.start();
      } catch (error) {
        logger.error('Failed to start audio monitor', error);
        addToast({
          title: t('monitor.startFailed'),
          description: error instanceof Error ? error.message : t('error.unknown'),
          color: 'danger'
        });
      }
    }
  };

  // Auto-start audio monitoring in voice mode
  const voiceAutoMonitorTriggered = React.useRef(false);
  React.useEffect(() => {
    if (radio.state.engineMode === 'voice' && !audioMonitor.isPlaying && connection.state.isConnected && !voiceAutoMonitorTriggered.current) {
      voiceAutoMonitorTriggered.current = true;
      logger.info('Voice mode detected, auto-starting audio monitor');
      audioMonitor.start().catch(err => logger.error('Voice auto-monitor failed', err));
    }
    if (radio.state.engineMode !== 'voice') {
      voiceAutoMonitorTriggered.current = false;
    }
  }, [radio.state.engineMode, connection.state.isConnected, audioMonitor.isPlaying]);

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
        mode: radio.state.currentMode?.name || 'FT8',
        band: t('frequency.custom'),
        description: `${formatFrequencyDisplay(frequency)} MHz (${t('frequency.custom')})`
      });

      if (response.success) {
        // 关闭模态框
        setIsCustomFrequencyModalOpen(false);
        setCustomFrequencyInput('');
        setCustomFrequencyError('');

        // 更新当前频率显示
        const frequencyLabel = `${formatFrequencyDisplay(frequency)} MHz (${t('frequency.custom')})`;
        setCurrentFrequency(String(frequency));
        setCustomFrequencyLabel(frequencyLabel);

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
    if (!radio.state.currentMode) {
      return availableFrequencies;
    }

    const currentModeName = radio.state.currentMode.name;
    let filtered = availableFrequencies.filter(freq => freq.mode === currentModeName);

    // 如果存在自定义频率选项且模式匹配，添加到列表开头
    if (customFrequencyOption && customFrequencyOption.mode === currentModeName) {
      // 确保不重复添加
      const exists = filtered.some(f => f.key === customFrequencyOption.key);
      if (!exists) {
        filtered = [customFrequencyOption, ...filtered];
      }
    }

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
  }, [availableFrequencies, radio.state.currentMode, customFrequencyOption, isAdmin, canSetFrequency, ability]);

  // 自动设置频率到后端（避免递归调用）
  const autoSetFrequency = async (frequency: FrequencyOption) => {
    if (!connection.state.isConnected) return;

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
      }
    } catch (error) {
      logger.debug('Auto set frequency failed:', error);
      // 自动设置失败，静默处理，不影响用户体验
    }
  };

  // 当模式改变时，自动选择第一个匹配的频率（仅数字模式）
  React.useEffect(() => {
    // Skip in voice mode - VoiceFrequencyControl manages its own frequency
    if (radio.state.engineMode === 'voice') return;

    if (filteredFrequencies.length > 0) {
      const currentFreqExists = filteredFrequencies.some(freq => freq.key === currentFrequency);
      if (!currentFreqExists) {
        const firstFreq = filteredFrequencies[0];
        logger.debug(`Mode changed, auto-selecting first frequency: ${firstFreq.label}`);
        setCurrentFrequency(firstFreq.key);
        // 清除自定义频率标签
        setCustomFrequencyLabel('');
        // 自动设置频率到后端
        autoSetFrequency(firstFreq);
      }
    }
  }, [filteredFrequencies, radio.state.engineMode]);

  // 处理频率切换
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFrequencyChange = async (keys: any) => {
    if (!connection.state.isConnected) {
      return;
    }

    const selectedFrequencyKey = Array.from(keys)[0] as string;
    if (!selectedFrequencyKey) return;

    // 检查是否选择了自定义频率选项
    if (selectedFrequencyKey === '__custom__') {
      setIsCustomFrequencyModalOpen(true);
      setCustomFrequencyInput('');
      setCustomFrequencyError('');
      // 不改变当前选中的频率
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
        // 切换到预设频率时清除自定义频率标签
        setCustomFrequencyLabel('');

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

  // 监听音量变化事件
  useEffect(() => {
    if (!connection.state.radioService) return;

    // 直接订阅 WSClient 事件
    const wsClient = connection.state.radioService.wsClientInstance;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleVolumeGainChanged = (data: any) => {
      // 处理新的数据格式（包含gain和gainDb）
      if (data && typeof data === 'object' && data.gain !== undefined) {
        // 新格式：{ gain: number, gainDb: number }
        if (!isNaN(data.gain) && data.gain >= 0) {
          setVolumeGain(data.gain);
        } else {
          logger.debug('Received invalid volume gain value:', data);
        }
      } else if (typeof data === 'number') {
        // 向后兼容：直接是gain数值
        if (!isNaN(data) && data >= 0) {
          setVolumeGain(data);
        } else {
          logger.debug('Received invalid volume gain value:', data);
        }
      } else {
        logger.debug('Received unknown format volume gain data:', data);
      }
    };

    wsClient.onWSEvent('volumeGainChanged', handleVolumeGainChanged);

    return () => {
      wsClient.offWSEvent('volumeGainChanged', handleVolumeGainChanged);
    };
  }, [connection.state.radioService]);

  // 在连接成功后获取当前音量
  useEffect(() => {
    if (connection.state.isConnected && connection.state.radioService) {
      // 获取系统状态，其中包含当前音量
      connection.state.radioService.getSystemStatus();
    }
  }, [connection.state.isConnected]);

  // Voice PTT mute: mute monitor during voice transmission to prevent echo
  useEffect(() => {
    if (radio.state.engineMode !== 'voice') return;
    const shouldMute = radio.state.pttStatus.isTransmitting;
    audioMonitor.setVolume(shouldMute ? -60 : gainToDb(monitorVolume));
  }, [radio.state.pttStatus.isTransmitting, radio.state.engineMode, monitorVolume]);

  // 监听系统状态更新
  useEffect(() => {
    if (!connection.state.radioService) return;

    // 直接订阅 WSClient 事件
    const wsClient = connection.state.radioService.wsClientInstance;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleSystemStatus = (status: any) => {
      if (status.volumeGain !== undefined) {
        // 确保系统状态中的gain值有效
        const gain = status.volumeGain;
        if (!isNaN(gain) && gain >= 0) {
          setVolumeGain(gain);
        } else {
          logger.debug('Received invalid volume gain in system status:', gain);
        }
      }
      // 支持dB格式的系统状态（如果后续添加）
      if (status.volumeGainDb !== undefined) {
        const gainDb = status.volumeGainDb;
        if (!isNaN(gainDb) && gainDb >= -60 && gainDb <= 20) {
          const gain = dbToGain(gainDb);
          setVolumeGain(gain);
        }
      }
    };

    wsClient.onWSEvent('systemStatus', handleSystemStatus);

    return () => {
      wsClient.offWSEvent('systemStatus', handleSystemStatus);
    };
  }, [connection.state.radioService]);

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
        const customOption: FrequencyOption = {
          key: frequencyKey,
          label: data.description || `${(data.frequency / 1000000).toFixed(3)} MHz`,
          frequency: data.frequency,
          band: data.band || '',
          mode: data.mode || 'FT8',
          radioMode: data.radioMode
        };
        setCustomFrequencyOption(customOption);
        setCustomFrequencyLabel(customOption.label);
        logger.debug('Custom frequency option added:', customOption.label);
      } else {
        // 预设频率：清除自定义选项
        setCustomFrequencyOption(null);
        setCustomFrequencyLabel('');
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('frequencyChanged', handleFrequencyChanged as any);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('frequencyChanged', handleFrequencyChanged as any);
    };
  }, [connection.state.radioService, availableFrequencies]);

  // 监听天调状态变化事件
  useEffect(() => {
    if (!connection.state.radioService) return;

    const wsClient = connection.state.radioService.wsClientInstance;

    const handleTunerStatusChanged = (status: TunerStatus) => {
      setTunerStatus(status);
      setIsTunerLoading(false);
    };

    wsClient.onWSEvent('tunerStatusChanged', handleTunerStatusChanged);

    return () => {
      wsClient.offWSEvent('tunerStatusChanged', handleTunerStatusChanged);
    };
  }, [connection.state.radioService]);

  // 天调控制方法
  const handleTunerToggle = async () => {
    if (!tunerCapabilities?.hasSwitch) {
      return;
    }

    setIsTunerLoading(true);

    try {
      const newEnabled = !tunerStatus.enabled;
      await api.setTuner(newEnabled);
      logger.info(`Tuner ${newEnabled ? 'enabled' : 'disabled'}`);

      addToast({
        title: newEnabled ? t('tuner.enabled') : t('tuner.disabled'),
        color: 'success',
        timeout: 2000
      });
    } catch (error) {
      logger.error('Tuner toggle failed:', error);
      setIsTunerLoading(false);

      if (error instanceof ApiError) {
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        addToast({
          title: t('tuner.toggleFailed'),
          description: t('error.networkError'),
          timeout: 3000
        });
      }
    }
  };

  const handleStartTuning = async () => {
    if (!tunerCapabilities?.hasManualTune) {
      return;
    }

    if (!tunerStatus.enabled) {
      addToast({
        title: t('tuner.enableFirst'),
        description: t('tuner.enableFirstDesc'),
        timeout: 3000
      });
      return;
    }

    setIsTunerLoading(true);

    try {
      const response = await api.startTuning();
      if (response.success) {
        logger.info('Manual tuning started');
        addToast({
          title: t('tuner.tuningStarted'),
          color: 'success',
          timeout: 2000
        });
      }
    } catch (error) {
      logger.error('Manual tuning failed:', error);
      setIsTunerLoading(false);

      if (error instanceof ApiError) {
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        addToast({
          title: t('tuner.startFailed'),
          description: t('error.networkError'),
          timeout: 3000
        });
      }
    }
  };

  return (
    <div className="flex flex-col gap-0 bg-content2 dark:bg-content1 px-4 py-2 pt-3 rounded-lg cursor-default select-none">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RadioStatus connection={connection.state} radio={radio} profileName={activeProfile?.name} onPress={isAdmin ? onOpenRadioSettings : undefined} canConfigure={isAdmin} canOperate={isOperator} />
          <div className="flex items-center gap-0">
            {isAdmin && (
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
            )}
            {isOperator && (
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
                <PopoverContent className="py-2 pt-3 space-y-1">
                  <Slider
                    orientation="vertical"
                    minValue={-60}
                    maxValue={20}
                    step={0.1}
                    value={[gainToDb(volumeGain)]}
                    onChange={handleVolumeChange}
                    style={{
                      height: '120px'
                    }}
                    aria-label={t('control.volumeControl')}
                  />
                  <div className="text-sm text-default-400 text-center font-mono">
                    {formatDbDisplay(gainToDb(volumeGain))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
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
              <PopoverContent className="py-2 pt-3 space-y-2">
                <div className="space-y-2">
                  {/* 监听音量滑块 */}
                  <div className="flex flex-col items-center px-2">
                    <Slider
                      orientation="vertical"
                      minValue={-60}
                      maxValue={20}
                      step={0.1}
                      value={[gainToDb(monitorVolume)]}
                      onChange={handleMonitorVolumeChange}
                      style={{ height: '120px' }}
                      aria-label={t('monitor.monitorVolume')}
                    />
                    <div className="text-sm text-default-400 text-center font-mono">
                      {formatDbDisplay(gainToDb(monitorVolume))}
                    </div>
                  </div>

                  {/* 状态指示器 */}
                  {audioMonitor.isPlaying && audioMonitor.stats && (
                    <div className="space-y-1 pt-2 border-t border-divider text-xs">
                      {/* 延迟显示 */}
                      <div className="flex justify-between items-center">
                        {t('monitor.latency')}
                        <span className={`font-mono ${
                          audioMonitor.stats.latencyMs < 50 ? 'text-success' :
                          audioMonitor.stats.latencyMs < 100 ? 'text-warning' :
                          'text-danger'
                        }`}>
                          {audioMonitor.stats.latencyMs.toFixed(0)}ms
                        </span>
                      </div>

                      {/* 缓冲区状态 */}
                      <div className="space-y-1">
                        <div className="flex justify-between items-center">
                          {t('monitor.buffer')}
                          <span className="font-mono text-default-400">
                            {audioMonitor.stats.bufferFillPercent.toFixed(0)}%
                          </span>
                        </div>
                      </div>

                      {/* 音频活动指示 */}
                      <div className="flex justify-between items-center">
                        {t('monitor.active')}
                        <div className={`w-2 h-2 rounded-full ${
                          audioMonitor.stats.isActive ? 'bg-success animate-pulse' : 'bg-default-300'
                        }`} />
                      </div>

                      {/* 编解码器 */}
                      <div className="flex justify-between items-center">
                        {t('monitor.codec')}
                        <span className="font-mono text-default-400 uppercase">
                          {audioMonitor.codec}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* 监听开关 */}
                  <div className="flex items-center justify-center px-2 w-full pt-2 border-t border-divider">
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
            {/* 天调控制：电台已连接时始终显示入口，按钮可见性由各自能力字段控制 */}
            {radio.state.radioConnected && (
              <Popover>
                <PopoverTrigger>
                  <Button
                    isIconOnly
                    variant="light"
                    size="sm"
                    className={`min-w-unit-6 min-w-6 w-6 h-6 ${
                      tunerStatus.status === 'tuning'
                        ? 'text-success animate-pulse'
                        : tunerStatus.enabled
                        ? 'text-success'
                        : 'text-default-400'
                    }`}
                    aria-label={t('tuner.control')}
                  >
                    <FontAwesomeIcon icon={faSlidersH} className="text-xs" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="py-4 space-y-2">
                  <div className="space-y-2">
                    {/* 天调开关 */}
                    {tunerCapabilities?.hasSwitch && (
                      <div className="flex items-center justify-between px-2 gap-2">
                        <span className="text-sm text-default-500">{t('tuner.auto')}</span>
                        <Switch
                          size="sm"
                          isSelected={tunerStatus.enabled}
                          onValueChange={handleTunerToggle}
                          isDisabled={isTunerLoading || !canSetTuner}
                          aria-label={t('tuner.switch')}
                        />
                      </div>
                    )}

                    {/* 手动调谐按钮 */}
                    {tunerCapabilities?.hasManualTune && (
                      <div className="px-2">
                        <Button
                          size="sm"
                          color="primary"
                          variant="flat"
                          className="w-full"
                          onPress={handleStartTuning}
                          isLoading={isTunerLoading && tunerStatus.status === 'tuning'}
                          isDisabled={!tunerStatus.enabled || isTunerLoading || !canManualTune}
                        >
                          {tunerStatus.status === 'tuning' ? t('tuner.tuning') : t('tuner.manual')}
                        </Button>
                      </div>
                    )}

                    {/* SWR显示（如果有） */}
                    {tunerStatus.swr !== undefined && (
                      <div className="space-y-1 pt-2 border-t border-divider text-xs px-2">
                        <div className="flex justify-between items-center">
                          <span className="text-default-500">SWR</span>
                          <span className={`font-mono ${
                            tunerStatus.swr < 1.5 ? 'text-success' :
                            tunerStatus.swr < 2.0 ? 'text-warning' :
                            'text-danger'
                          }`}>
                            {tunerStatus.swr.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>

      {/* 电台错误内联提示 */}
      {connection.state.isConnected && latestError && [
        RadioConnectionStatus.DISCONNECTED,
        RadioConnectionStatus.CONNECTION_LOST,
        RadioConnectionStatus.RECONNECTING,
      ].includes(radio.state.radioConnectionStatus) && (
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
          <span className="text-xs">{latestError.userMessage}</span>
        </Alert>
      )}
      <RadioErrorHistoryModal
        isOpen={isErrorHistoryOpen}
        onClose={() => setIsErrorHistoryOpen(false)}
      />

      {/* 主控制区域 */}
      <div className="flex items-center">
        {/* 左侧选择器 */}
        <div className="flex gap-1 flex-1 -ml-3">
          {canSetFrequency ? (
            <Select
              disableSelectorIconRotation
              className="w-[200px]"
              labelPlacement="outside"
              placeholder={radio.state.currentMode ? `${radio.state.currentMode.name} ${t('control.frequency')}` : t('control.frequency')}
              selectorIcon={<SelectorIcon />}
              selectedKeys={[currentFrequency]}
              variant="flat"
              size="md"
              radius="md"
              aria-label={t('control.selectFrequency')}
              classNames={{
                trigger: "font-bold text-lg border-0 bg-transparent hover:border-1 hover:border-default-300 transition-all duration-200 shadow-none",
                value: "font-bold text-lg",
                innerWrapper: "shadow-none",
                mainWrapper: "shadow-none"
              }}
              isDisabled={!connection.state.isConnected || isLoadingFrequencies || !radio.state.currentMode}
              isLoading={isLoadingFrequencies}
              onSelectionChange={handleFrequencyChange}
              renderValue={() => {
                // 直接在 filteredFrequencies 中查找（现在包含了自定义频率）
                const selectedFreq = filteredFrequencies.find(f => f.key === currentFrequency);
                return selectedFreq ? <span className="font-bold text-lg">{selectedFreq.label}</span> : null;
              }}
            >
              {[...filteredFrequencies.map((frequency) => (
                <SelectItem key={frequency.key} textValue={frequency.label}>
                  {frequency.label}
                </SelectItem>
              )),
              <SelectItem key="__custom__" textValue={t('frequency.customOption')} className="text-primary">
                {t('frequency.customOption')}
              </SelectItem>]}
            </Select>
          ) : (
            <div className="flex items-center pl-3 pr-2 h-10 cursor-not-allowed">
              <span className="font-bold text-lg text-default-foreground truncate">
                {filteredFrequencies.find(f => f.key === currentFrequency)?.label || ''}
              </span>
            </div>
          )}
          {canSwitchMode ? (
            <Select
              disableSelectorIconRotation
              className="w-[88px]"
              labelPlacement="outside"
              placeholder={modeError || t('mode.placeholder')}
              selectorIcon={<SelectorIcon />}
              selectedKeys={radio.state.engineMode === 'voice' ? ['VOICE'] : (radio.state.currentMode ? [radio.state.currentMode.name] : [])}
              variant="flat"
              size="md"
              radius="md"
              aria-label={t('control.selectMode')}
              classNames={{
                trigger: "font-bold text-lg border-0 bg-transparent hover:border-1 hover:border-default-300 transition-all duration-200 shadow-none",
                value: "font-bold text-lg",
                innerWrapper: "shadow-none",
                mainWrapper: "shadow-none"
              }}
              isDisabled={!connection.state.isConnected || isLoadingModes}
              onSelectionChange={handleModeChange}
              isLoading={isLoadingModes}
            >
              {(availableModes || []).filter(mode => mode && mode.name).map((mode) => (
                <SelectItem
                  key={mode.name}
                  textValue={mode.name}
                  className="text-xs py-1 px-2 min-h-6"
                >
                  {mode.name}
                </SelectItem>
              ))}
            </Select>
          ) : (
            <div className="flex items-center px-2 h-10 cursor-not-allowed">
              <span className="font-bold text-lg text-default-foreground">
                {radio.state.engineMode === 'voice' ? 'VOICE' : (radio.state.currentMode?.name || '')}
              </span>
            </div>
          )}
        </div>
        
        {/* 右侧开关 */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`text-sm text-default-600`}>
              {t('monitor.listen')}
            </span>
            <Switch 
              isSelected={radio.state.isDecoding} 
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
