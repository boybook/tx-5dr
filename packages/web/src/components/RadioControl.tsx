import * as React from 'react';
import {Select, SelectItem, Switch, Button, Slider, Popover, PopoverTrigger, PopoverContent, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Input, Spinner, Alert} from "@heroui/react";
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog, faChevronDown, faVolumeUp, faHeadphones, faRadio, faSlidersH } from '@fortawesome/free-solid-svg-icons';
import { useConnection, useRadioState, useProfiles, useRadioErrors } from '../store/radioStore';
import { RadioErrorHistoryModal } from './RadioErrorHistoryModal';
import { api, ApiError } from '@tx5dr/core';
import type { ModeDescriptor, TunerStatus, TunerCapabilities } from '@tx5dr/contracts';
import type { ConnectionState, RadioState } from '../store/radioStore';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { showErrorToast } from '../utils/errorToast';
import { useState, useEffect } from 'react';

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
const RadioStatus: React.FC<{ connection: ConnectionState; radio: { state: RadioState }; profileName?: string | null; onPress?: () => void }> = ({ connection, radio, profileName, onPress }) => {
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
          console.error('获取支持的电台列表失败:', error);
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
      console.warn('🚨 [RadioControl] 电台发射中断开连接:', data);
      addToast({
        title: '⚠️ 电台发射中断连接',
        description: data.message,
        timeout: 10000
      });
      setTimeout(() => {
        addToast({
          title: '💡 建议',
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
      return `电台型号 ${config.serial.rigModel}`;
    }
    if (config.type === 'network') return 'Network RigCtrl';
    if (config.type === 'icom-wlan') return 'ICOM WLAN';
    return '电台';
  };

  if (!connection.isConnected) {
    return null;
  }

  const status = radio.state.radioConnectionStatus;
  const label = profileName || getRadioModelText();

  const renderStatus = () => {
    switch (status) {
      case RadioConnectionStatus.NOT_CONFIGURED:
        return <span className="text-sm text-default-500">{label} | 无电台模式</span>;

      case RadioConnectionStatus.CONNECTING:
        return (
          <div className="flex items-center gap-2">
            <Spinner size="sm" color="primary" />
            <span className="text-sm text-primary">{label} 连接中...</span>
          </div>
        );

      case RadioConnectionStatus.CONNECTED:
        return (
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faRadio} className="text-success text-ms -mt-0.5" />
            <span className="text-sm text-default-500">
              {label} 已连接
            </span>
          </div>
        );

      case RadioConnectionStatus.RECONNECTING: {
        const progress = radio.state.reconnectProgress;
        return (
          <div className="flex items-center gap-2">
            <Spinner size="sm" color="warning" />
            <span className="text-sm text-warning">
              {label} 重连中{progress ? ` (${progress.attempt}/${progress.maxAttempts})` : ''}...
            </span>
            <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
              <Button
                size="sm"
                color="warning"
                variant="flat"
                onPress={() => connection.radioService?.stopReconnect()}
                className="h-6 px-2 text-xs"
              >
                停止
              </Button>
            </span>
          </div>
        );
      }

      case RadioConnectionStatus.CONNECTION_LOST:
        return (
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faRadio} className="text-danger text-xs" />
            <span className="text-sm text-danger">{label} 连接丢失</span>
            <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
              <Button
                size="sm"
                color="danger"
                variant="flat"
                onPress={() => connection.radioService?.startDecoding()}
                className="h-6 px-2 text-xs"
              >
                重连
              </Button>
            </span>
          </div>
        );

      case RadioConnectionStatus.DISCONNECTED:
      default:
        return (
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faRadio} className="text-default-400 text-xs" />
            <span className="text-sm text-default-500">{label} 未连接</span>
            {radio.state.radioConfig?.type && radio.state.radioConfig.type !== 'none' && !radio.state.isDecoding && (
              <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                <Button
                  size="sm"
                  color="primary"
                  variant="flat"
                  onPress={() => connection.radioService?.startDecoding()}
                  className="h-6 px-2 text-xs"
                >
                  连接
                </Button>
              </span>
            )}
          </div>
        );
    }
  };

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
};

interface RadioControlProps {
  onOpenRadioSettings?: () => void;
}

export const RadioControl: React.FC<RadioControlProps> = ({ onOpenRadioSettings }) => {
  const connection = useConnection();
  const radio = useRadioState();
  const { activeProfile } = useProfiles();
  const { latestError } = useRadioErrors();
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

  // 音频监听相关状态
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [monitorStats, setMonitorStats] = useState<{
    latencyMs: number;
    bufferFillPercent: number;
    isActive: boolean;
    audioLevel?: number;
  } | null>(null);
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const workletNodeRef = React.useRef<AudioWorkletNode | null>(null);
  const isInitializingWorklet = React.useRef<boolean>(false); // 初始化锁，防止重复初始化

  // 自定义频率相关状态
  const [isCustomFrequencyModalOpen, setIsCustomFrequencyModalOpen] = useState(false);
  const [customFrequencyInput, setCustomFrequencyInput] = useState('');
  const [customFrequencyError, setCustomFrequencyError] = useState('');
  const [isSettingCustomFrequency, setIsSettingCustomFrequency] = useState(false);
  const [_customFrequencyLabel, setCustomFrequencyLabel] = useState<string>(''); // 保存自定义频率的显示标签
  const [customFrequencyOption, setCustomFrequencyOption] = useState<FrequencyOption | null>(null); // 保存自定义频率选项

  // 天调相关状态
  const [tunerCapabilities, setTunerCapabilities] = useState<TunerCapabilities | null>(null);
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
        console.log('🔌 未连接到服务器，清空模式列表');
        setAvailableModes([]);
        return;
      }
      
      setIsLoadingModes(true);
      setModeError(null);
      
      try {
        console.log('🔄 开始加载模式列表...');
        const response = await api.getAvailableModes();
        console.log('📦 收到模式列表响应:', response);
        
        if (response.success && Array.isArray(response.data)) {
          if (response.data.length === 0) {
            console.warn('⚠️ 模式列表为空');
            setModeError('没有可用的模式');
          } else {
            console.log(`✅ 成功加载 ${response.data.length} 个模式:`, response.data.map(m => m.name).join(', '));
            setAvailableModes(response.data);
          }
        } else {
          console.error('❌ 加载模式列表失败: 返回数据格式错误', response);
          setModeError('加载模式列表失败: 数据格式错误');
        }
      } catch (error) {
        console.error('❌ 加载模式列表失败:', error);
        setModeError('加载模式列表失败: ' + (error instanceof Error ? error.message : '未知错误'));
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
        console.log('🔌 未连接到服务器，清空频率列表');
        setAvailableFrequencies([]);
        return;
      }
      
      setIsLoadingFrequencies(true);
      
      try {
        console.log('🔄 开始加载频率列表...');
        const response = await api.getPresetFrequencies();
        console.log('📦 收到频率列表响应:', response);
        
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
          console.log(`✅ 成功加载 ${frequencyOptions.length} 个预设频率`);
        } else {
          console.error('❌ 加载频率列表失败: 返回数据格式错误', response);
        }
      } catch (error) {
        console.error('❌ 加载频率列表失败:', error);
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
        console.log('🔄 加载上次选择的频率...');
        const response = await api.getLastFrequency();

        if (response.success && response.lastFrequency) {
          const lastFreq = response.lastFrequency;
          console.log('📦 找到上次选择的频率:', lastFreq);

          // 查找匹配的频率选项
          const matchingFreq = availableFrequencies.find(freq =>
            freq.frequency === lastFreq.frequency && freq.mode === lastFreq.mode
          );

          if (matchingFreq && radio.state.currentMode?.name === lastFreq.mode) {
            console.log(`🔄 自动恢复上次频率: ${matchingFreq.label}`);
            setCurrentFrequency(matchingFreq.key);
            // 自动设置频率到电台
            autoSetFrequency(matchingFreq);
          } else {
            console.log('⚠️ 上次选择的频率与当前模式不匹配或未找到对应选项');
          }
        } else {
          console.log('ℹ️ 没有找到上次选择的频率记录');
        }
      } catch (error) {
        console.error('❌ 加载上次选择的频率失败:', error);
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
      console.error('❌ 切换监听状态失败:', error);
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
      console.warn('⚠️ 未连接到服务器，无法切换模式');
      return;
    }

    const selectedModeName = Array.from(keys)[0];
    const selectedMode = availableModes.find(mode => mode.name === selectedModeName);
    
    if (!selectedMode) {
      console.warn('⚠️ 未找到选中的模式:', selectedModeName);
      return;
    }

    try {
      const response = await api.switchMode(selectedMode);
      if (response.success) {
        console.log(`✅ 模式已切换到: ${selectedMode.name}`);
      }
    } catch (error) {
      console.error('❌ 切换模式失败:', error);
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

  // 初始化AudioWorklet（动态采样率）
  const initAudioWorklet = async (sampleRate: number) => {
    // 设置初始化锁
    isInitializingWorklet.current = true;

    try {
      console.log(`🎧 [AudioMonitor] 创建AudioContext，采样率=${sampleRate}Hz`);
      const audioContext = new AudioContext({ sampleRate });
      await audioContext.audioWorklet.addModule('/audio-monitor-worklet.js');
      const workletNode = new AudioWorkletNode(audioContext, 'audio-monitor-processor');
      workletNode.connect(audioContext.destination);

      // 监听来自worklet的统计信息
      workletNode.port.onmessage = (e) => {
        if (e.data.type === 'stats') {
          setMonitorStats(e.data.data);
        }
      };

      audioContextRef.current = audioContext;
      workletNodeRef.current = workletNode;
      console.log('✅ [AudioMonitor] AudioWorklet初始化成功');
    } catch (error) {
      console.error('❌ [AudioMonitor] AudioWorklet初始化失败:', error);
      throw error;
    } finally {
      // 释放初始化锁
      isInitializingWorklet.current = false;
    }
  };

  // 开始监听（简化版：连接即接收）
  const startMonitoring = async () => {
    try {
      console.log('🎧 [AudioMonitor] 开始监听...');

      // 在用户点击回调中立即创建 AudioContext（浏览器自动播放策略要求）
      // 使用 48kHz 采样率（与服务端 AudioMonitorService 的 TARGET_SAMPLE_RATE 匹配）
      await initAudioWorklet(48000);

      // 设置isMonitoring为true，触发useEffect注册事件监听器和数据处理器
      setIsMonitoring(true);

      // 等待一个tick确保useEffect已执行
      await new Promise(resolve => setTimeout(resolve, 100));

      // 然后连接音频WebSocket（连接后服务端自动广播）
      connection.state.radioService?.connectAudioMonitor();

      console.log('✅ [AudioMonitor] 监听已开启');
    } catch (error) {
      console.error('❌ [AudioMonitor] 开始监听失败:', error);
      addToast({
        title: '监听启动失败',
        description: error instanceof Error ? error.message : '未知错误',
        color: 'danger'
      });

      // 清理资源
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      workletNodeRef.current = null;
      isInitializingWorklet.current = false; // 重置初始化锁
      setIsMonitoring(false);
    }
  };

  // 停止监听
  const stopMonitoring = () => {
    try {
      console.log('🛑 [AudioMonitor] 停止监听...');

      // 断开音频WebSocket连接
      connection.state.radioService?.disconnectAudioMonitor();

      // 清理AudioWorklet
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      workletNodeRef.current = null;
      isInitializingWorklet.current = false; // 重置初始化锁

      setIsMonitoring(false);
      setMonitorStats(null);
      console.log('✅ [AudioMonitor] 监听已停止');
    } catch (error) {
      console.error('❌ [AudioMonitor] 停止监听失败:', error);
    }
  };

  // 切换监听状态
  const toggleMonitoring = async () => {
    if (isMonitoring) {
      stopMonitoring();
    } else {
      await startMonitoring();
    }
  };

  // 频率格式验证和转换
  const parseFrequencyInput = (input: string): { frequency: number; error: string } | null => {
    const trimmed = input.trim();
    if (!trimmed) {
      return { frequency: 0, error: '请输入频率' };
    }

    // 尝试解析为数字
    const value = parseFloat(trimmed);
    if (isNaN(value) || value <= 0) {
      return { frequency: 0, error: '请输入有效的数字' };
    }

    let frequencyHz: number;

    // 判断输入格式:包含小数点视为MHz,否则视为Hz
    if (trimmed.includes('.')) {
      // MHz 格式
      if (value < 1 || value > 1000) {
        return { frequency: 0, error: '频率范围: 1-1000 MHz' };
      }
      frequencyHz = Math.round(value * 1000000);
    } else {
      // Hz 格式
      if (value < 1000000 || value > 1000000000) {
        return { frequency: 0, error: '频率范围: 1-1000 MHz (1000000-1000000000 Hz)' };
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
      setCustomFrequencyError(result?.error || '输入无效');
      return;
    }

    const { frequency } = result;
    setIsSettingCustomFrequency(true);

    try {
      console.log(`🔄 设置自定义频率: ${formatFrequencyDisplay(frequency)} MHz (${frequency} Hz)`);

      const response = await api.setRadioFrequency({
        frequency: frequency,
        mode: radio.state.currentMode?.name || 'FT8',
        band: '自定义',
        description: `${formatFrequencyDisplay(frequency)} MHz (自定义)`
      });

      if (response.success) {
        // 关闭模态框
        setIsCustomFrequencyModalOpen(false);
        setCustomFrequencyInput('');
        setCustomFrequencyError('');

        // 更新当前频率显示
        const frequencyLabel = `${formatFrequencyDisplay(frequency)} MHz (自定义)`;
        setCurrentFrequency(String(frequency));
        setCustomFrequencyLabel(frequencyLabel);

        const successMessage = `已切换到 ${formatFrequencyDisplay(frequency)} MHz`;

        if (response.radioConnected) {
          console.log(`✅ 自定义频率已设置: ${formatFrequencyDisplay(frequency)} MHz`);
          addToast({
            title: '频率切换成功',
            description: successMessage,
            color: 'success',
            timeout: 3000
          });
        } else {
          console.log(`📝 自定义频率已记录: ${formatFrequencyDisplay(frequency)} MHz (电台未连接)`);
          addToast({
            title: '📝 频率已记录',
            description: `${successMessage} (电台未连接)`,
            timeout: 4000
          });
        }
      } else {
        console.error('❌ 设置自定义频率失败:', response.message);
        setCustomFrequencyError(response.message || '设置失败');
      }
    } catch (error) {
      console.error('❌ 设置自定义频率失败:', error);
      if (error instanceof ApiError) {
        setCustomFrequencyError(error.userMessage);
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        setCustomFrequencyError('网络错误或服务器无响应');
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

    console.log(`🔍 当前模式: ${currentModeName}, 筛选出 ${filtered.length} 个频率${customFrequencyOption ? ' (含自定义)' : ''}`);
    return filtered;
  }, [availableFrequencies, radio.state.currentMode, customFrequencyOption]);

  // 自动设置频率到后端（避免递归调用）
  const autoSetFrequency = async (frequency: FrequencyOption) => {
    if (!connection.state.isConnected) return;

    try {
      console.log(`🔄 自动设置频率: ${frequency.label} (${frequency.frequency} Hz)${frequency.radioMode ? ` [${frequency.radioMode}]` : ''}`);

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

      if (response.success) {
        console.log(`✅ 自动设置频率成功: ${frequency.label}`);
      } else {
        console.error('❌ 自动设置频率失败:', response.message);
      }
    } catch (error) {
      console.error('❌ 自动设置频率失败:', error);
      // 自动设置失败，静默处理，不影响用户体验
    }
  };

  // 当模式改变时，自动选择第一个匹配的频率
  React.useEffect(() => {
    if (filteredFrequencies.length > 0) {
      const currentFreqExists = filteredFrequencies.some(freq => freq.key === currentFrequency);
      if (!currentFreqExists) {
        const firstFreq = filteredFrequencies[0];
        console.log(`🔄 模式改变，自动选择第一个频率: ${firstFreq.label}`);
        setCurrentFrequency(firstFreq.key);
        // 清除自定义频率标签
        setCustomFrequencyLabel('');
        // 自动设置频率到后端
        autoSetFrequency(firstFreq);
      }
    }
  }, [filteredFrequencies]);

  // 处理频率切换
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFrequencyChange = async (keys: any) => {
    if (!connection.state.isConnected) {
      console.warn('⚠️ 未连接到服务器，无法切换频率');
      return;
    }

    const selectedFrequencyKey = Array.from(keys)[0] as string;
    if (!selectedFrequencyKey) return;

    // 检查是否选择了自定义频率选项
    if (selectedFrequencyKey === '__custom__') {
      console.log('📝 打开自定义频率输入框');
      setIsCustomFrequencyModalOpen(true);
      setCustomFrequencyInput('');
      setCustomFrequencyError('');
      // 不改变当前选中的频率
      return;
    }

    const selectedFrequency = filteredFrequencies.find(freq => freq.key === selectedFrequencyKey);
    if (!selectedFrequency) {
      console.warn('⚠️ 未找到选中的频率:', selectedFrequencyKey);
      return;
    }

    try {
      console.log(`🔄 切换频率到: ${selectedFrequency.label} (${selectedFrequency.frequency} Hz)${selectedFrequency.radioMode ? ` [${selectedFrequency.radioMode}]` : ''}`);

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
          ? `已切换到 ${selectedFrequency.label} (${selectedFrequency.radioMode})`
          : `已切换到 ${selectedFrequency.label}`;

        if (response.radioConnected) {
          console.log(`✅ 频率已切换到: ${selectedFrequency.label}`);
          addToast({
            title: '频率切换成功',
            description: successMessage,
            color: 'success',
            timeout: 3000
          });
        } else {
          console.log(`📝 频率已记录: ${selectedFrequency.label} (电台未连接)`);
          addToast({
            title: '📝 频率已记录',
            description: `${successMessage} (电台未连接)`,
            timeout: 4000
          });
        }
      } else {
        console.error('❌ 切换频率失败:', response.message);
        addToast({
          title: '❌ 频率切换失败',
          description: response.message,
          timeout: 5000
        });
      }
    } catch (error) {
      console.error('❌ 切换频率失败:', error);
      if (error instanceof ApiError) {
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        addToast({
          title: '❌ 频率切换失败',
          description: '网络错误或服务器无响应',
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
      console.log('🔊 收到服务器音量变化:', data);

      // 处理新的数据格式（包含gain和gainDb）
      if (data && typeof data === 'object' && data.gain !== undefined) {
        // 新格式：{ gain: number, gainDb: number }
        if (!isNaN(data.gain) && data.gain >= 0) {
          setVolumeGain(data.gain);
        } else {
          console.warn('⚠️ 收到无效的音量增益值:', data);
        }
      } else if (typeof data === 'number') {
        // 向后兼容：直接是gain数值
        if (!isNaN(data) && data >= 0) {
          setVolumeGain(data);
        } else {
          console.warn('⚠️ 收到无效的音量增益值:', data);
        }
      } else {
        console.warn('⚠️ 收到未知格式的音量增益数据:', data);
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

  // 监听音频监听事件
  useEffect(() => {
    if (!connection.state.radioService || !isMonitoring) return;

    const radioService = connection.state.radioService;
    const wsClient = radioService.wsClientInstance;

    // 用于存储当前采样率（从元数据获取）
    let currentSampleRate: number | null = null;
    let lastSequence = -1;
    let _frameCount = 0;
    let _droppedFrames = 0;

    // 处理音频元数据（从控制WebSocket接收）
    // AudioContext 已在用户点击 startMonitoring() 时创建，这里仅处理采样率变化和统计
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleAudioMonitorData = async (data: any) => {
      // 检测丢帧（通过序列号）
      if (data.sequence !== undefined) {
        if (lastSequence >= 0 && data.sequence !== lastSequence + 1) {
          const dropped = data.sequence - lastSequence - 1;
          _droppedFrames += dropped;
        }
        lastSequence = data.sequence;
      }

      // 计算端到端延迟（服务端timestamp到客户端接收）
      if (data.timestamp) {
        _frameCount++;
      }

      if (!data.sampleRate) {
        console.warn('⚠️ [AudioMonitor] 元数据缺少采样率');
        return;
      }

      // 更新当前采样率
      currentSampleRate = data.sampleRate;

      // 确保 AudioContext 处于 running 状态（可能被浏览器挂起）
      if (audioContextRef.current?.state === 'suspended') {
        try {
          await audioContextRef.current.resume();
          console.log('▶️ [AudioMonitor] AudioContext 已恢复');
        } catch (error) {
          console.error('❌ [AudioMonitor] AudioContext 恢复失败:', error);
        }
      }

      // 如果采样率发生变化，重新创建 AudioContext
      if (audioContextRef.current &&
          audioContextRef.current.sampleRate !== data.sampleRate) {

        if (isInitializingWorklet.current) {
          console.log('⏭️ [AudioMonitor] 正在初始化中，跳过重复请求');
          return;
        }

        console.log(`🔄 [AudioMonitor] 采样率变化 ${audioContextRef.current.sampleRate} → ${data.sampleRate}，重新创建AudioContext`);
        audioContextRef.current.close();
        audioContextRef.current = null;
        workletNodeRef.current = null;

        try {
          await initAudioWorklet(data.sampleRate);
        } catch (error) {
          console.error('❌ [AudioMonitor] 重建AudioContext失败:', error);
        }
      }
    };

    // 处理二进制音频数据（从音频专用WebSocket接收）
    const handleBinaryAudioData = (buffer: ArrayBuffer) => {
      const _t_receive = performance.now(); // 接收时间戳

      // 确保AudioContext和Worklet已就绪
      if (!workletNodeRef.current) {
        console.warn('⚠️ [AudioMonitor] AudioWorklet未就绪，丢弃音频数据');
        return;
      }

      // 直接发送ArrayBuffer到AudioWorklet（零拷贝传输）
      workletNodeRef.current.port.postMessage({
        type: 'audioData',
        buffer: buffer,
        sampleRate: currentSampleRate || 48000,
        clientTimestamp: _t_receive // 添加客户端时间戳
      }, [buffer]); // Transferable objects - 零拷贝传输
    };

    // 处理统计信息（可选，AudioWorklet也会生成统计）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleAudioMonitorStats = (_stats: any) => {
      // 服务端的统计信息可以作为补充
    };

    console.log('🔧 [AudioMonitor] 注册事件监听器和数据处理器');

    // 订阅控制WebSocket的元数据事件
    wsClient.onWSEvent('audioMonitorData', handleAudioMonitorData);
    wsClient.onWSEvent('audioMonitorStats', handleAudioMonitorStats);

    // 注册二进制音频数据处理器（音频专用WebSocket）
    radioService.setAudioMonitorDataHandler(handleBinaryAudioData);

    console.log('✅ [AudioMonitor] 事件监听器和数据处理器已注册');

    return () => {
      console.log('🧹 [AudioMonitor] 清理事件监听器和数据处理器');

      // 清理控制WebSocket事件
      wsClient.offWSEvent('audioMonitorData', handleAudioMonitorData);
      wsClient.offWSEvent('audioMonitorStats', handleAudioMonitorStats);

      // 清理音频数据处理器
      radioService.setAudioMonitorDataHandler(null);
    };
  }, [connection.state.radioService, isMonitoring]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (isMonitoring) {
        stopMonitoring();
      }
    };
  }, []);

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
          console.warn('⚠️ 系统状态中收到无效的音量增益值:', gain);
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
      console.log('📻 收到频率变化广播:', data);

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
        console.log('📻 添加自定义频率选项:', customOption);
      } else {
        // 预设频率：清除自定义选项
        setCustomFrequencyOption(null);
        setCustomFrequencyLabel('');
        console.log('📻 切换到预设频率，清除自定义选项');
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('frequencyChanged', handleFrequencyChanged as any);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('frequencyChanged', handleFrequencyChanged as any);
    };
  }, [connection.state.radioService, availableFrequencies]);

  // 加载天调能力
  useEffect(() => {
    const loadTunerCapabilities = async () => {
      if (!connection.state.isConnected || !radio.state.radioConnected) {
        setTunerCapabilities(null);
        return;
      }

      try {
        const response = await api.getTunerCapabilities();
        if (response.success) {
          console.log('📡 天调能力:', response.capabilities);
          setTunerCapabilities(response.capabilities);

          // 如果支持天调，获取当前状态
          if (response.capabilities.supported) {
            const statusResponse = await api.getTunerStatus();
            if (statusResponse.success) {
              setTunerStatus(statusResponse.status);
            }
          }
        }
      } catch (error) {
        console.error('❌ 获取天调能力失败:', error);
        setTunerCapabilities(null);
      }
    };

    loadTunerCapabilities();
  }, [connection.state.isConnected, radio.state.radioConnected]);

  // 监听天调状态变化事件
  useEffect(() => {
    if (!connection.state.radioService) return;

    const wsClient = connection.state.radioService.wsClientInstance;

    const handleTunerStatusChanged = (status: TunerStatus) => {
      console.log('📡 收到天调状态变化:', status);
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
    if (!tunerCapabilities?.supported || !tunerCapabilities.hasSwitch) {
      console.warn('⚠️ 天调不支持开关控制');
      return;
    }

    setIsTunerLoading(true);

    try {
      const newEnabled = !tunerStatus.enabled;
      await api.setTuner(newEnabled);
      console.log(`✅ 天调已${newEnabled ? '启用' : '禁用'}`);

      addToast({
        title: `天调已${newEnabled ? '启用' : '禁用'}`,
        color: 'success',
        timeout: 2000
      });
    } catch (error) {
      console.error('❌ 切换天调状态失败:', error);
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
          title: '切换天调状态失败',
          description: '网络错误或服务器无响应',
          timeout: 3000
        });
      }
    }
  };

  const handleStartTuning = async () => {
    if (!tunerCapabilities?.supported || !tunerCapabilities.hasManualTune) {
      console.warn('⚠️ 天调不支持手动调谐');
      return;
    }

    if (!tunerStatus.enabled) {
      addToast({
        title: '请先启用天调',
        description: '需要先打开天调开关才能进行手动调谐',
        timeout: 3000
      });
      return;
    }

    setIsTunerLoading(true);

    try {
      const response = await api.startTuning();
      if (response.success) {
        console.log('✅ 手动调谐已启动');
        addToast({
          title: '手动调谐已启动',
          color: 'success',
          timeout: 2000
        });
      }
    } catch (error) {
      console.error('❌ 启动手动调谐失败:', error);
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
          title: '启动手动调谐失败',
          description: '网络错误或服务器无响应',
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
          <RadioStatus connection={connection.state} radio={radio} profileName={activeProfile?.name} onPress={onOpenRadioSettings} />
          <div className="flex items-center gap-0">
            <Button
              isIconOnly
              variant="light"
              size="sm"
              className="text-default-400 min-w-unit-6 min-w-6 w-6 h-6"
              aria-label="电台设置"
              onPress={onOpenRadioSettings}
            >
              <FontAwesomeIcon icon={faCog} className="text-xs" />
            </Button>
            <Popover>
              <PopoverTrigger>
                <Button
                  isIconOnly
                  variant="light"
                  size="sm"
                  className="text-default-400 min-w-unit-6 min-w-6 w-6 h-6"
                  aria-label="发射音量增益"
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
                  aria-label='音量控制'
                />
                <div className="text-sm text-default-400 text-center font-mono">
                  {formatDbDisplay(gainToDb(volumeGain))}
                </div>
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger>
                <Button
                  isIconOnly
                  variant="light"
                  size="sm"
                  className={`min-w-unit-6 min-w-6 w-6 h-6 ${isMonitoring ? 'text-success' : 'text-default-400'}`}
                  aria-label="音频监听"
                >
                  <FontAwesomeIcon icon={faHeadphones} className="text-xs" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="py-2 pt-3 space-y-2">
                <div className="space-y-2">
                  {/* 监听开关 */}
                  <div className="flex items-center justify-center px-2 w-full">
                    <Switch
                      size="sm"
                      isSelected={isMonitoring}
                      onValueChange={toggleMonitoring}
                      aria-label="音频监听开关"
                    />
                  </div>

                  {/* 状态指示器 */}
                  {isMonitoring && monitorStats && (
                    <div className="space-y-1 pt-2 border-t border-divider text-xs">
                      {/* 延迟显示 */}
                      <div className="flex justify-between items-center">
                        <span className="text-default-500 pr-1">延迟</span>
                        <span className={`font-mono ${
                          monitorStats.latencyMs < 50 ? 'text-success' :
                          monitorStats.latencyMs < 100 ? 'text-warning' :
                          'text-danger'
                        }`}>
                          {monitorStats.latencyMs.toFixed(0)}ms
                        </span>
                      </div>

                      {/* 缓冲区状态 */}
                      <div className="space-y-1">
                        <div className="flex justify-between items-center">
                          <span className="text-default-500 pr-1">缓冲</span>
                          <span className="font-mono text-default-400">
                            {monitorStats.bufferFillPercent.toFixed(0)}%
                          </span>
                        </div>
                      </div>

                      {/* 音频活动指示 */}
                      <div className="flex justify-between items-center">
                        <span className="text-default-500 pr-1">活动</span>
                        <div className={`w-2 h-2 rounded-full ${
                          monitorStats.isActive ? 'bg-success animate-pulse' : 'bg-default-300'
                        }`} />
                      </div>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            {/* 天调控制 */}
            {tunerCapabilities?.supported && (
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
                    aria-label="天调控制"
                  >
                    <FontAwesomeIcon icon={faSlidersH} className="text-xs" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="py-4 space-y-2">
                  <div className="space-y-2">
                    {/* 天调开关 */}
                    {tunerCapabilities.hasSwitch && (
                      <div className="flex items-center justify-between px-2 gap-2">
                        <span className="text-sm text-default-500">自动天调</span>
                        <Switch
                          size="sm"
                          isSelected={tunerStatus.enabled}
                          onValueChange={handleTunerToggle}
                          isDisabled={isTunerLoading}
                          aria-label="天调开关"
                        />
                      </div>
                    )}

                    {/* 手动调谐按钮 */}
                    {tunerCapabilities.hasManualTune && (
                      <div className="px-2">
                        <Button
                          size="sm"
                          color="primary"
                          variant="flat"
                          className="w-full"
                          onPress={handleStartTuning}
                          isLoading={isTunerLoading && tunerStatus.status === 'tuning'}
                          isDisabled={!tunerStatus.enabled || isTunerLoading}
                        >
                          {tunerStatus.status === 'tuning' ? '调谐中...' : '手动调谐'}
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
              详情
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
          <Select
            disableSelectorIconRotation
            className="w-[200px]"
            labelPlacement="outside"
            placeholder={radio.state.currentMode ? `${radio.state.currentMode.name} 频率` : "频率"}
            selectorIcon={<SelectorIcon />}
            selectedKeys={[currentFrequency]}
            variant="flat"
            size="md"
            radius="md"
            aria-label="选择频率"
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
            <SelectItem key="__custom__" textValue="自定义频率..." className="text-primary">
              自定义频率...
            </SelectItem>]}
          </Select>
          <Select
            disableSelectorIconRotation
            className="w-[88px]"
            labelPlacement="outside"
            placeholder={modeError || "通联模式"}
            selectorIcon={<SelectorIcon />}
            selectedKeys={radio.state.currentMode ? [radio.state.currentMode.name] : []}
            variant="flat"
            size="md"
            radius="md"
            aria-label="选择通联模式"
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
            {availableModes?.filter(mode => mode && mode.name).map((mode) => (
              <SelectItem 
                key={mode.name} 
                textValue={mode.name}
                className="text-xs py-1 px-2 min-h-6"
              >
                {mode.name}
              </SelectItem>
            ))}
          </Select>
        </div>
        
        {/* 右侧开关 */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`text-sm text-default-600`}>
              监听
            </span>
            <Switch 
              isSelected={radio.state.isDecoding} 
              onValueChange={handleListenToggle}
              size="sm"
              color="primary"
              isDisabled={!connection.state.isConnected || isTogglingListen}
              aria-label="切换监听状态"
              className={isTogglingListen ? 'opacity-50 pointer-events-none' : ''}
            />
          </div>
        </div>
      </div>

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
            <h3 className="text-lg font-semibold">自定义频率</h3>
          </ModalHeader>
          <ModalBody>
            <Input
              autoFocus
              label="频率"
              placeholder="例如: 14.074 或 14074000"
              value={customFrequencyInput}
              onValueChange={handleCustomFrequencyInputChange}
              variant="flat"
              isInvalid={!!customFrequencyError}
              errorMessage={customFrequencyError}
              description={
                customFrequencyInput && !customFrequencyError && parseFrequencyInput(customFrequencyInput)?.frequency
                  ? `将设置为 ${formatFrequencyDisplay(parseFrequencyInput(customFrequencyInput)!.frequency)} MHz`
                  : '支持 MHz (如 14.074) 或 Hz (如 14074000) 格式'
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
              取消
            </Button>
            <Button
              color="primary"
              onPress={handleCustomFrequencyConfirm}
              isLoading={isSettingCustomFrequency}
              isDisabled={!customFrequencyInput.trim()}
            >
              确认
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};
