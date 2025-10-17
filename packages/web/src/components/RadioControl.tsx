import * as React from 'react';
import {Select, SelectItem, Switch, Button, Slider, Popover, PopoverTrigger, PopoverContent, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Input} from "@heroui/react";
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog, faChevronDown, faVolumeUp, faWifi, faSpinner, faExclamationTriangle } from '@fortawesome/free-solid-svg-icons';
import { useConnection, useRadioState } from '../store/radioStore';
import { api } from '@tx5dr/core';
import type { ModeDescriptor } from '@tx5dr/contracts';
import { useState, useEffect } from 'react';

interface FrequencyOption {
  key: string;
  label: string;
  frequency: number;
  band: string;
  mode: string;
  radioMode?: string; // 电台调制模式，如 USB, LSB
}

export const SelectorIcon = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <FontAwesomeIcon icon={faChevronDown} className="text-default-400" />
  );
};

// 服务器和电台连接状态指示器组件
const ConnectionAndRadioStatus: React.FC<{ connection: any; radio: any }> = ({ connection, radio }) => {
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [isConnectingRadio, setIsConnectingRadio] = useState(false);
  const [supportedRigs, setSupportedRigs] = useState<any[]>([]);
  
  // 电台重连状态
  const [radioReconnectInfo, setRadioReconnectInfo] = useState({
    isReconnecting: false,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    hasReachedMaxAttempts: false,
    nextAttemptAt: 0
  });

  // 每秒更新当前时间，用于重连倒计时
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (connection.isReconnecting && connection.lastReconnectInfo) {
      timer = setInterval(() => {
        setCurrentTime(Date.now());
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [connection.isReconnecting, connection.lastReconnectInfo]);

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

  // 加载电台状态
  useEffect(() => {
    const loadRadioStatus = async () => {
      if (connection.isConnected && connection.radioService) {
        try {
          const status = await api.getRadioStatus();
          if (status.success) {
            radio.dispatch({
              type: 'radioStatusUpdate',
              payload: {
                radioConnected: status.isConnected,
                radioInfo: status.radioInfo,
                radioConfig: status.config
              }
            });
          }
        } catch (error) {
          console.error('获取电台状态失败:', error);
        }
      }
    };

    loadRadioStatus();
  }, [connection.isConnected, connection.radioService]);

  // 监听电台重连事件（仅处理UI相关的本地状态，不处理全局状态）
  useEffect(() => {
    if (connection.radioService) {
      // 电台重连中
      connection.radioService.on('radioReconnecting', (data: any) => {
        console.log('🔄 [RadioControl] 电台重连中:', data);
        const reconnectInfo = data.reconnectInfo || {};
        setRadioReconnectInfo(prev => ({
          ...prev,
          isReconnecting: true,
          reconnectAttempts: data.attempt || 0,
          maxReconnectAttempts: reconnectInfo.maxReconnectAttempts || -1,
          hasReachedMaxAttempts: reconnectInfo.hasReachedMaxAttempts || false,
          nextAttemptAt: Date.now() + (reconnectInfo.nextReconnectDelay || 3000)
        }));
      });

      // 电台状态变化 - 只处理本地UI状态，全局状态由radioStore处理
      connection.radioService.on('radioStatusChanged', (data: any) => {
        console.log('📡 [RadioControl] 电台状态变化（仅更新本地UI状态）:', data);
        
        if (data.connected) {
          // 连接成功，清除重连状态
          setRadioReconnectInfo(prev => ({
            ...prev,
            isReconnecting: false,
            reconnectAttempts: 0,
            hasReachedMaxAttempts: false
          }));
        } else {
          // 连接断开时，如果不在重连过程中，重置重连状态
          setRadioReconnectInfo(prev => {
            if (!data.reconnectInfo?.isReconnecting) {
              return {
                ...prev,
                isReconnecting: false,
                hasReachedMaxAttempts: false
              };
            }
            return prev;
          });
        }
      });

      // 电台重连停止
      connection.radioService.on('radioReconnectStopped', (data: any) => {
        console.log('⏹️ [RadioControl] 电台重连已停止:', data);
        const reconnectInfo = data.reconnectInfo || {};
        setRadioReconnectInfo(prev => ({
          ...prev,
          isReconnecting: false,
          hasReachedMaxAttempts: reconnectInfo.hasReachedMaxAttempts || true,
          maxReconnectAttempts: reconnectInfo.maxReconnectAttempts || prev.maxReconnectAttempts
        }));
      });

      // 电台重连失败
      connection.radioService.on('radioReconnectFailed', (data: any) => {
        console.log('❌ [RadioControl] 电台重连失败:', data);
        const reconnectInfo = data.reconnectInfo || {};
        setRadioReconnectInfo(prev => ({
          ...prev,
          reconnectAttempts: data.attempt || prev.reconnectAttempts,
          maxReconnectAttempts: reconnectInfo.maxReconnectAttempts || -1,
          hasReachedMaxAttempts: reconnectInfo.hasReachedMaxAttempts || false,
          nextAttemptAt: Date.now() + (reconnectInfo.nextReconnectDelay || 3000)
        }));
      });

      // 电台发射中断开连接
      connection.radioService.on('radioDisconnectedDuringTransmission', (data: any) => {
        console.warn('🚨 [RadioControl] 电台发射中断开连接:', data);
        
        // 显示专门的错误提示
        addToast({
          title: '⚠️ 电台发射中断连接',
          description: data.message,
          timeout: 10000 // 10秒显示
        });
        
        // 再显示一个包含建议的提示
        setTimeout(() => {
          addToast({
            title: '💡 建议',
            description: data.recommendation,
            timeout: 15000 // 15秒显示
          });
        }, 1000);
      });
    }

    return () => {
      if (connection.radioService) {
        connection.radioService.off('radioReconnecting');
        connection.radioService.off('radioStatusChanged');
        connection.radioService.off('radioReconnectStopped');
        connection.radioService.off('radioReconnectFailed');
        connection.radioService.off('radioDisconnectedDuringTransmission');
      }
    };
  }, [connection.radioService]);

  // 电台重连倒计时更新
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (radioReconnectInfo.isReconnecting && radioReconnectInfo.nextAttemptAt > Date.now()) {
      timer = setInterval(() => {
        setCurrentTime(Date.now());
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [radioReconnectInfo.isReconnecting, radioReconnectInfo.nextAttemptAt]);

  // 连接电台
  const handleConnectRadio = async () => {
    setIsConnectingRadio(true);
    try {
      const result = await api.connectRadio();
      if (result.success) {
        radio.dispatch({
          type: 'radioStatusUpdate',
          payload: {
            radioConnected: result.isConnected,
            radioInfo: null,
            radioConfig: radio.state.radioConfig
          }
        });
        // 重新获取状态以获取电台信息
        const status = await api.getRadioStatus();
        if (status.success) {
          radio.dispatch({
            type: 'radioStatusUpdate',
            payload: {
              radioConnected: status.isConnected,
              radioInfo: status.radioInfo,
              radioConfig: status.config
            }
          });
        }
      }
    } catch (error) {
      console.error('连接电台失败:', error);
    } finally {
      setIsConnectingRadio(false);
    }
  };

  // 手动重连电台
  const handleManualReconnectRadio = async () => {
    setIsConnectingRadio(true);
    try {
      if (connection.radioService) {
        // 通过WebSocket发送手动重连命令
        connection.radioService.radioManualReconnect();
        
        // 清除所有重连状态
        setRadioReconnectInfo(prev => ({
          ...prev,
          isReconnecting: false,
          hasReachedMaxAttempts: false,
          reconnectAttempts: 0
        }));
      }
    } catch (error) {
      console.error('手动重连电台失败:', error);
    } finally {
      // 延迟清除loading状态，给重连一些时间
      setTimeout(() => {
        setIsConnectingRadio(false);
      }, 2000);
    }
  };

  const getServerStatusIcon = () => {
    if (connection.isConnected) {
      return undefined;
    } else if (connection.isReconnecting) {
      return <FontAwesomeIcon icon={faSpinner} className="text-warning animate-spin" />;
    } else if (connection.hasReachedMaxAttempts) {
      return <FontAwesomeIcon icon={faExclamationTriangle} className="text-danger" />;
    } else if (connection.isConnecting) {
      return <FontAwesomeIcon icon={faSpinner} className="text-primary animate-spin" />;
    } else {
      return <FontAwesomeIcon icon={faWifi} className="text-default-400" />;
    }
  };

  const getServerStatusText = () => {
    if (connection.isConnected) {
      return '服务器已连接';
    } else if (connection.isReconnecting) {
      const nextAttemptIn = connection.lastReconnectInfo 
        ? Math.max(0, Math.ceil((connection.lastReconnectInfo.nextAttemptAt - currentTime) / 1000))
        : 0;
      const attemptText = connection.maxReconnectAttempts === -1 
        ? `第${connection.reconnectAttempts}次` 
        : `${connection.reconnectAttempts}/${connection.maxReconnectAttempts}`;
      return `重连中 (${attemptText}) ${nextAttemptIn > 0 ? `${nextAttemptIn}s后重试` : ''}`;
    } else if (connection.hasReachedMaxAttempts) {
      return '连接失败，已停止重试';
    } else if (connection.isConnecting) {
      return '连接中...';
    } else {
      return '未连接';
    }
  };

  const getServerStatusColor = () => {
    if (connection.isConnected) {
      return 'text-default-500';
    } else if (connection.isReconnecting) {
      return 'text-warning';
    } else if (connection.hasReachedMaxAttempts) {
      return 'text-danger';
    } else if (connection.isConnecting) {
      return 'text-primary';
    } else {
      return 'text-default-400';
    }
  };

  const getRadioDisplayText = () => {
    if (!connection.isConnected) {
      return null;
    }

    const config = radio.state.radioConfig;
    if (config.type === 'none') {
      return <span className="text-sm text-default-500">无电台模式</span>;
    }

    // 电台已连接 - 修复条件判断，只依赖radioConnected状态
    if (radio.state.radioConnected) {
      const displayText = radio.state.radioInfo 
        ? `${radio.state.radioInfo.manufacturer} ${radio.state.radioInfo.model} 电台已连接`
        : '电台已连接';
      return (
        <span className="text-sm text-default-500">
          {displayText}
        </span>
      );
    }

    // 获取电台型号文本
    let radioModelText = '';
    if (config.type === 'serial' && config.rigModel) {
      const rigInfo = supportedRigs.find(r => r.rigModel === config.rigModel);
      if (rigInfo) {
        radioModelText = `${rigInfo.mfgName} ${rigInfo.modelName}`;
      } else {
        radioModelText = `电台型号 ${config.rigModel}`;
      }
    } else if (config.type === 'network') {
      radioModelText = 'Network RigCtrl';
    } else {
      radioModelText = '已配置电台';
    }

    // 电台正在重连中
    if (radioReconnectInfo.isReconnecting) {
      const nextAttemptIn = radioReconnectInfo.nextAttemptAt > currentTime 
        ? Math.ceil((radioReconnectInfo.nextAttemptAt - currentTime) / 1000) 
        : 0;
      const attemptText = `第${radioReconnectInfo.reconnectAttempts}次`;
      
      return (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <FontAwesomeIcon icon={faSpinner} className="text-warning animate-spin text-xs" />
            <span className="text-sm text-warning">
              电台重连中 ({attemptText}) {nextAttemptIn > 0 ? `${nextAttemptIn}s后重试` : ''}
            </span>
          </div>
        </div>
      );
    }

    // 电台重连已达最大次数
    if (radioReconnectInfo.hasReachedMaxAttempts) {
      return (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <FontAwesomeIcon icon={faExclamationTriangle} className="text-danger text-xs" />
            <span className="text-sm text-danger">{radioModelText} 连接失败</span>
          </div>
          <Button
            size="sm"
            color="warning"
            variant="flat"
            onPress={handleManualReconnectRadio}
            isLoading={isConnectingRadio}
            className="h-6 px-2 text-xs"
          >
            {isConnectingRadio ? '重连中' : '手动重连'}
          </Button>
        </div>
      );
    }

    // 电台未连接（初始状态）
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-default-500">{radioModelText}</span>
        <Button
          size="sm"
          color="primary"
          variant="flat"
          onPress={handleConnectRadio}
          isLoading={isConnectingRadio}
          className="h-6 px-2 text-xs"
        >
          {isConnectingRadio ? '连接中' : '连接'}
        </Button>
      </div>
    );
  };

  return (
    <div className="flex items-center gap-2">
      {connection.isConnected ? (
        // 服务器已连接时，只显示电台连接状态
        getRadioDisplayText()
      ) : (
        // 服务器未连接时，显示服务器连接状态
        <>
          {getServerStatusIcon()}
          <span className={`text-sm ${getServerStatusColor()}`}>
            {getServerStatusText()}
          </span>
        </>
      )}
    </div>
  );
};

interface RadioControlProps {
  onOpenRadioSettings?: () => void;
}

export const RadioControl: React.FC<RadioControlProps> = ({ onOpenRadioSettings }) => {
  const connection = useConnection();
  const radio = useRadioState();
  const [isConnecting, setIsConnecting] = useState(false);
  const [availableModes, setAvailableModes] = useState<ModeDescriptor[]>([]);
  const [isLoadingModes, setIsLoadingModes] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [availableFrequencies, setAvailableFrequencies] = useState<FrequencyOption[]>([]);
  const [isLoadingFrequencies, setIsLoadingFrequencies] = useState(false);
  const [currentFrequency, setCurrentFrequency] = useState<string>('14074000');

  // 简化的UI状态管理
  const [isTogglingListen, setIsTogglingListen] = useState(false);

  const [volumeGain, setVolumeGain] = useState(1.0);

  // 自定义频率相关状态
  const [isCustomFrequencyModalOpen, setIsCustomFrequencyModalOpen] = useState(false);
  const [customFrequencyInput, setCustomFrequencyInput] = useState('');
  const [customFrequencyError, setCustomFrequencyError] = useState('');
  const [isSettingCustomFrequency, setIsSettingCustomFrequency] = useState(false);
  const [customFrequencyLabel, setCustomFrequencyLabel] = useState<string>(''); // 保存自定义频率的显示标签

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
        const baseUrl = '/api';
        const res = await fetch(`${baseUrl}/radio/last-frequency`);
        const response = await res.json();
        
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
      }
    };

    // 延迟执行，等待频率列表和模式都加载完成
    if (availableFrequencies.length > 0 && radio.state.currentMode) {
      setTimeout(loadLastFrequency, 500);
    }
  }, [availableFrequencies, radio.state.currentMode, connection.state.isConnected]);



  // 连接到服务器
  const handleConnect = async () => {
    if (!connection.state.radioService) {
      console.warn('⚠️ RadioService未初始化');
      return;
    }
    
    setIsConnecting(true);
    try {
      console.log('🔗 开始手动连接到服务器...');
      
      // 如果达到最大重连次数，需要重置重连计数器
      if (connection.state.hasReachedMaxAttempts) {
        connection.state.radioService.resetReconnectAttempts();
      }
      
      await connection.state.radioService.connect();
      console.log('✅ 手动连接成功');
    } catch (error) {
      console.error('❌ 手动连接失败:', error);
    } finally {
      setIsConnecting(false);
    }
  };

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

      const baseUrl = '/api';
      const requestBody: any = {
        frequency: frequency,
        mode: radio.state.currentMode?.name || 'FT8',
        band: '自定义',
        description: `${formatFrequencyDisplay(frequency)} MHz (自定义)`
      };

      const res = await fetch(`${baseUrl}/radio/frequency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const response = await res.json();

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
            title: '✅ 频率切换成功',
            description: successMessage,
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
      setCustomFrequencyError('网络错误或服务器无响应');
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
    const filtered = availableFrequencies.filter(freq => freq.mode === currentModeName);

    console.log(`🔍 当前模式: ${currentModeName}, 筛选出 ${filtered.length} 个频率`);
    return filtered;
  }, [availableFrequencies, radio.state.currentMode]);

  // 自动设置频率到后端（避免递归调用）
  const autoSetFrequency = async (frequency: FrequencyOption) => {
    if (!connection.state.isConnected) return;
    
    try {
      console.log(`🔄 自动设置频率: ${frequency.label} (${frequency.frequency} Hz)${frequency.radioMode ? ` [${frequency.radioMode}]` : ''}`);
      const baseUrl = '/api';
      const requestBody: any = { 
        frequency: frequency.frequency,
        mode: frequency.mode,
        band: frequency.band,
        description: frequency.label
      };
      if (frequency.radioMode) {
        requestBody.radioMode = frequency.radioMode;
      }
      
      const res = await fetch(`${baseUrl}/radio/frequency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const response = await res.json();
      
      if (response.success) {
        console.log(`✅ 自动设置频率成功: ${frequency.label}`);
      } else {
        console.error('❌ 自动设置频率失败:', response.message);
      }
    } catch (error) {
      console.error('❌ 自动设置频率失败:', error);
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
      const baseUrl = '/api';
      const requestBody: any = { 
        frequency: selectedFrequency.frequency,
        mode: selectedFrequency.mode,
        band: selectedFrequency.band,
        description: selectedFrequency.label
      };
      if (selectedFrequency.radioMode) {
        requestBody.radioMode = selectedFrequency.radioMode;
      }
      
      const res = await fetch(`${baseUrl}/radio/frequency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const response = await res.json();
      
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
            title: '✅ 频率切换成功',
            description: successMessage,
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
      addToast({
        title: '❌ 频率切换失败',
        description: '网络错误或服务器无响应',
        timeout: 5000
      });
    }
  };

  // 监听音量变化事件
  useEffect(() => {
    if (connection.state.radioService) {
      connection.state.radioService.on('volumeGainChanged', (data: any) => {
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
      });
    }
  }, [connection.state.radioService]);

  // 在连接成功后获取当前音量
  useEffect(() => {
    if (connection.state.isConnected && connection.state.radioService) {
      // 获取系统状态，其中包含当前音量
      connection.state.radioService.getSystemStatus();
    }
  }, [connection.state.isConnected]);

  // 监听系统状态更新
  useEffect(() => {
    if (connection.state.radioService) {
      connection.state.radioService.on('systemStatus', (status: any) => {
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
      });
    }
  }, [connection.state.radioService]);

  // 监听频率变化事件
  useEffect(() => {
    if (!connection.state.radioService) return;

    const handleFrequencyChanged = (data: any) => {
      console.log('📻 收到频率变化广播:', data);

      // 更新当前频率
      setCurrentFrequency(String(data.frequency));

      // 判断是否是预设频率
      const isPreset = filteredFrequencies.some(f => f.key === String(data.frequency));
      if (!isPreset) {
        // 自定义频率,显示自定义标签
        setCustomFrequencyLabel(data.description);
      } else {
        // 预设频率,清除自定义标签
        setCustomFrequencyLabel('');
      }
    };

    connection.state.radioService.on('frequencyChanged', handleFrequencyChanged as any);

    return () => {
      connection.state.radioService?.off('frequencyChanged', handleFrequencyChanged as any);
    };
  }, [connection.state.radioService, filteredFrequencies]);

  return (
    <div className="flex flex-col gap-0 bg-content2 dark:bg-content1 px-4 py-2 pt-3 rounded-lg cursor-default select-none">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ConnectionAndRadioStatus connection={connection.state} radio={radio} />
          {(!connection.state.isConnected && !connection.state.isConnecting && !connection.state.isReconnecting) && (
            <Button
              size="sm"
              color="primary"
              variant="flat"
              onPress={handleConnect}
              isLoading={isConnecting}
              className="h-6 px-2 text-xs"
            >
              {isConnecting ? '连接中' : '重新连接'}
            </Button>
          )}
          {connection.state.hasReachedMaxAttempts && (
            <Button
              size="sm"
              color="warning"
              variant="flat"
              onPress={handleConnect}
              isLoading={isConnecting}
              className="h-6 px-2 text-xs"
            >
              {isConnecting ? '连接中' : '重试'}
            </Button>
          )}
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
          </div>
        </div>
      </div>
      
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
            renderValue={(items: any) => {
              // 如果选中的是自定义频率,显示自定义标签
              if (customFrequencyLabel && !filteredFrequencies.find(f => f.key === currentFrequency)) {
                return <span className="font-bold text-lg">{customFrequencyLabel}</span>;
              }
              // 否则显示预设频率的标签
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
