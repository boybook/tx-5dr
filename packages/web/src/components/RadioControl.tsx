import * as React from 'react';
import {Select, SelectItem, Switch, Button} from "@heroui/react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useConnection, useRadioState } from '../store/radioStore';

const frequencies = [
  { key: "50313", label: "50.313MHz" }
]

const modes = [
  { key: "ft8", label: "FT8" },
  { key: "ft4", label: "FT4" },
]

export const SelectorIcon = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <FontAwesomeIcon icon={faChevronDown} className="text-default-400" />
  );
};

export const RadioControl: React.FC = () => {
  const connection = useConnection();
  const radio = useRadioState();
  const [isConnecting, setIsConnecting] = React.useState(false);
  
  // 本地UI状态管理
  const [isListenLoading, setIsListenLoading] = React.useState(false);
  const [pendingListenState, setPendingListenState] = React.useState<boolean | null>(null);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  // 添加调试信息
  React.useEffect(() => {
    console.log('🔍 RadioControl状态更新:', {
      isConnected: connection.state.isConnected,
      isDecoding: radio.state.isDecoding,
      hasRadioService: !!connection.state.radioService,
      isListenLoading,
      pendingListenState
    });
  }, [connection.state.isConnected, radio.state.isDecoding, connection.state.radioService, isListenLoading, pendingListenState]);

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
      console.log('🔗 开始连接到服务器...');
      await connection.state.radioService.connect();
      console.log('✅ 连接成功');
    } catch (error) {
      console.error('❌ 连接失败:', error);
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

  return (
    <div className="flex flex-col gap-0 bg-gray-100 px-4 py-2 pt-3 rounded-lg cursor-default">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0">
          {connection.state.isConnected ? (
            <span className="text-sm text-default-400">已连接电台 IC-705</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-default-400">未连接</span>
              <Button
                size="sm"
                color="primary"
                variant="flat"
                onPress={handleConnect}
                isLoading={isConnecting}
                className="h-6 px-2 text-xs"
              >
                {isConnecting ? '连接中' : '连接'}
              </Button>
            </div>
          )}
          <Button
            isIconOnly
            variant="light"
            size="sm"
            className="text-default-400 min-w-unit-6 w-6 h-6"
            aria-label="电台设置"
          >
            <FontAwesomeIcon icon={faCog} className="text-xs" />
          </Button>
        </div>
      </div>
      
      {/* 主控制区域 */}
      <div className="flex items-center">
        {/* 左侧选择器 */}
        <div className="flex gap-3 flex-1 -ml-3">
          <Select
            disableSelectorIconRotation
            className="w-[160px]"
            labelPlacement="outside"
            placeholder="频率"
            selectorIcon={<SelectorIcon />}
            defaultSelectedKeys={['50313']}
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
            isDisabled={!connection.state.isConnected}
          >
            {frequencies.map((frequency) => (
              <SelectItem key={frequency.key} textValue={frequency.label}>
                {frequency.label}
              </SelectItem>
            ))}
          </Select>
          <Select
            disableSelectorIconRotation
            className="w-[100px]"
            labelPlacement="outside"
            placeholder="通联模式"
            selectorIcon={<SelectorIcon />}
            defaultSelectedKeys={['ft8']}
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
            isDisabled={!connection.state.isConnected}
          >
            {modes.map((format) => (
              <SelectItem key={format.key} textValue={format.label}>
                {format.label}
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
          <div className="flex items-center gap-2">
            <span className="text-sm text-default-600">发射</span>
            <Switch 
              isSelected={false} 
              color="danger" 
              onValueChange={() => {}} 
              size="sm"
              isDisabled={true}
              aria-label="切换发射状态"
            />
          </div>
        </div>
      </div>
    </div>
  );
};