import * as React from 'react';
import {Select, SelectItem, Switch, Button, Slider, Popover, PopoverTrigger, PopoverContent, addToast} from "@heroui/react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog, faChevronDown, faVolumeUp, faWifi, faSpinner, faExclamationTriangle } from '@fortawesome/free-solid-svg-icons';
import { useConnection, useRadioState } from '../store/radioStore';
import { api } from '@tx5dr/core';
import type { ModeDescriptor } from '@tx5dr/contracts';
import { useState, useEffect, useRef } from 'react';

interface FrequencyOption {
  key: string;
  label: string;
  frequency: number;
  band: string;
  mode: string;
}

export const SelectorIcon = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <FontAwesomeIcon icon={faChevronDown} className="text-default-400" />
  );
};

// 连接状态指示器组件
const ConnectionStatus: React.FC<{ connection: any }> = ({ connection }) => {
  const [currentTime, setCurrentTime] = useState(Date.now());

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
  const getStatusIcon = () => {
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

  const getStatusText = () => {
    if (connection.isConnected) {
      return '已连接服务端';
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

  const getStatusColor = () => {
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

  return (
    <div className="flex items-center gap-2">
      {getStatusIcon()}
      <span className={`text-sm ${getStatusColor()}`}>
        {getStatusText()}
      </span>
    </div>
  );
};

export const RadioControl: React.FC = () => {
  const connection = useConnection();
  const radio = useRadioState();
  const [isConnecting, setIsConnecting] = useState(false);
  const [availableModes, setAvailableModes] = useState<ModeDescriptor[]>([]);
  const [isLoadingModes, setIsLoadingModes] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [availableFrequencies, setAvailableFrequencies] = useState<FrequencyOption[]>([]);
  const [isLoadingFrequencies, setIsLoadingFrequencies] = useState(false);
  const [currentFrequency, setCurrentFrequency] = useState<string>('14074000');
  
  // 本地UI状态管理
  const [isListenLoading, setIsListenLoading] = useState(false);
  const [pendingListenState, setPendingListenState] = useState<boolean | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [volumeGain, setVolumeGain] = useState(1.0);

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
            mode: preset.mode
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

  // 添加调试信息
  React.useEffect(() => {
    console.log('🔍 RadioControl状态更新:', {
      isConnected: connection.state.isConnected,
      isDecoding: radio.state.isDecoding,
      hasRadioService: !!connection.state.radioService,
      isListenLoading,
      pendingListenState,
      currentMode: radio.state.currentMode,
      availableModes: availableModes.length,
      isLoadingModes,
      modeError
    });
  }, [
    connection.state.isConnected, 
    radio.state.isDecoding, 
    connection.state.radioService, 
    isListenLoading, 
    pendingListenState, 
    radio.state.currentMode,
    availableModes.length,
    isLoadingModes,
    modeError
  ]);

  // 监听WebSocket状态变化，清除loading状态
  React.useEffect(() => {
    if (pendingListenState !== null && radio.state.isDecoding === pendingListenState) {
      // 状态已同步，清除loading
      console.log('✅ 监听状态已同步，清除loading状态');
      setIsListenLoading(false);
      setPendingListenState(null);
      
      // 清除超时定时器
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
  }, [radio.state.isDecoding, pendingListenState]);

  // 组件卸载时清理定时器
  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

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

  // 监听开关控制 - 优雅的loading状态管理
  const handleListenToggle = (isSelected: boolean) => {
    if (!connection.state.radioService) {
      console.warn('⚠️ RadioService未初始化，无法切换监听状态');
      return;
    }

    if (!connection.state.isConnected) {
      console.warn('⚠️ 未连接到服务器，无法切换监听状态');
      return;
    }

    if (isListenLoading) {
      console.warn('⚠️ 正在处理中，请稍候...');
      return;
    }
    
    console.log(`🎧 切换监听状态: ${isSelected ? '开启' : '关闭'}`);
    
    // 立即进入loading状态
    setIsListenLoading(true);
    setPendingListenState(isSelected);
    
    // 设置超时处理（5秒后自动恢复）
    timeoutRef.current = setTimeout(() => {
      console.warn('⚠️ 监听状态切换超时，恢复UI状态');
      setIsListenLoading(false);
      setPendingListenState(null);
      timeoutRef.current = null;
    }, 5000);
    
    // 发送命令
    if (isSelected) {
      connection.state.radioService.startDecoding();
    } else {
      connection.state.radioService.stopDecoding();
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

  // 处理音量变化
  const handleVolumeChange = (value: number | number[]) => {
    const gain = Array.isArray(value) ? value[0] : value;
    setVolumeGain(gain);
    connection.state.radioService?.setVolumeGain(gain);
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
      console.log(`🔄 自动设置频率: ${frequency.label} (${frequency.frequency} Hz)`);
      const baseUrl = '/api';
      const res = await fetch(`${baseUrl}/radio/frequency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency: frequency.frequency }),
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

    const selectedFrequency = availableFrequencies.find(freq => freq.key === selectedFrequencyKey);
    if (!selectedFrequency) {
      console.warn('⚠️ 未找到选中的频率:', selectedFrequencyKey);
      return;
    }

    try {
      console.log(`🔄 切换频率到: ${selectedFrequency.label} (${selectedFrequency.frequency} Hz)`);
      // 临时直接调用API，直到类型问题解决
      const baseUrl = '/api';
      const res = await fetch(`${baseUrl}/radio/frequency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency: selectedFrequency.frequency }),
      });
      const response = await res.json();
      
      if (response.success) {
        setCurrentFrequency(selectedFrequencyKey);
        if (response.radioConnected) {
          console.log(`✅ 频率已切换到: ${selectedFrequency.label}`);
          addToast({
            title: '✅ 频率切换成功',
            description: `已切换到 ${selectedFrequency.label}`,
            timeout: 3000
          });
        } else {
          console.log(`📝 频率已记录: ${selectedFrequency.label} (电台未连接)`);
          addToast({
            title: '📝 频率已记录',
            description: `${selectedFrequency.label} (电台未连接)`,
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
      connection.state.radioService.on('volumeGainChanged', (gain: number) => {
        console.log('🔊 收到服务器音量变化:', gain);
        setVolumeGain(gain);
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
          setVolumeGain(status.volumeGain);
        }
      });
    }
  }, [connection.state.radioService]);

  return (
    <div className="flex flex-col gap-0 bg-content2 dark:bg-content1 px-4 py-2 pt-3 rounded-lg cursor-default select-none">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ConnectionStatus connection={connection.state} />
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
              onPress={() => {}}
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
                  minValue={0}
                  maxValue={1.2}
                  step={0.01}
                  value={[volumeGain]}
                  onChange={handleVolumeChange}
                  style={{
                    height: '120px'
                  }}
                  aria-label='音量控制'
                />
                <div className="text-sm text-default-400">
                  {(volumeGain * 100).toFixed(0)}
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
          >
            {filteredFrequencies.map((frequency) => (
              <SelectItem key={frequency.key} textValue={frequency.label}>
                {frequency.label}
              </SelectItem>
            ))}
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
              isDisabled={!connection.state.isConnected || isListenLoading}
              aria-label="切换监听状态"
              className={isListenLoading ? 'opacity-50 pointer-events-none' : ''}
            />
          </div>
        </div>
      </div>
    </div>
  );
};