import React, { useState } from 'react';
import { 
  Button,
  Select,
  SelectItem
} from '@heroui/react';
import { useRadioState } from '../store/radioStore';
import { RadioControl } from '../components/RadioControl';
import { RadioOperatorList } from '../components/RadioOperatorList';
import { SettingsModal } from '../components/SettingsModal';
import { MyRelatedFT8Table } from '../components/MyRelatedFT8Table';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog } from '@fortawesome/free-solid-svg-icons';

export const RightLayout: React.FC = () => {
  const radio = useRadioState();
  const [selectedMode, setSelectedMode] = useState<string>('auto5');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'audio' | 'radio' | 'operator' | 'advanced'>('audio');

  // 获取当前操作员的呼号
  const getCurrentOperatorCallsign = (): string => {
    const firstOperator = radio.state.operators[0];
    return firstOperator?.context?.myCall || 'N0CALL';
  };

  // 判断是否为自动模式
  const isAutoMode = selectedMode.startsWith('auto');

  // 处理模式选择变化
  const handleModeChange = (keys: any) => {
    const selectedKey = Array.from(keys)[0] as string;
    setSelectedMode(selectedKey);
  };

  // 打开设置弹窗
  const handleOpenSettings = () => {
    setSettingsInitialTab('audio');
    setIsSettingsOpen(true);
  };

  // 关闭设置弹窗
  const handleCloseSettings = () => {
    setIsSettingsOpen(false);
  };

  // 处理创建操作员
  const handleCreateOperator = () => {
    setSettingsInitialTab('operator');
    setIsSettingsOpen(true);
  };

  return (
    <div className="h-screen flex flex-col">
      {/* 顶部工具栏 */}
      <div
        className="flex-shrink-0 flex justify-between items-center p-2 px-3"
        style={{ 
          WebkitAppRegion: 'drag',
        } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        <div></div> {/* 左侧空白 */}
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          <Select
            variant="flat"
            size="sm"
            radius="md"
            className="w-[110px] h-6"
            aria-label="选择自动程序模式"
            classNames={{
              trigger: `${isAutoMode ? 'bg-success-50 select-auto-mode' : 'bg-gray-100 select-manual-mode'} rounded-md px-2 h-6 min-h-6 max-h-6 text-xs font-mono text-default-400 leading-none border-0 shadow-none transition-colors duration-200 !py-0`,
              value: "text-xs font-mono text-default-400",
              innerWrapper: "shadow-none h-6",
              mainWrapper: "shadow-none h-6",
              selectorIcon: "right-1",
              popoverContent: "p-1 min-w-[140px]"
            }}
            selectedKeys={[selectedMode]}
            onSelectionChange={handleModeChange}
            renderValue={(items) => {
              const item = Array.from(items)[0];
              if (item && item.key && item.key.toString().startsWith('auto')) {
                return (
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 bg-success-500 rounded-full flex-shrink-0"></div>
                    <span className="truncate">{item.textValue}</span>
                  </div>
                );
              }
              return item?.textValue || '';
            }}
          >
            <SelectItem key="manual" textValue="手动" className="text-xs py-1 px-2 min-h-6">手动</SelectItem>
            <SelectItem key="auto1" textValue="自动程序1" className="text-xs py-1 px-2 min-h-6">自动程序1</SelectItem>
            <SelectItem key="auto2" textValue="自动程序2" className="text-xs py-1 px-2 min-h-6">自动程序2</SelectItem>
            <SelectItem key="auto3" textValue="自动程序3" className="text-xs py-1 px-2 min-h-6">自动程序3</SelectItem>
            <SelectItem key="auto4" textValue="自动程序4" className="text-xs py-1 px-2 min-h-6">自动程序4</SelectItem>
            <SelectItem key="auto5" textValue="自动程序5" className="text-xs py-1 px-2 min-h-6">自动程序5</SelectItem>
          </Select>
          <Button
            onPress={() => {}}
            variant="light" 
            size="sm"
            title="电台呼号"
            className="bg-gray-100 rounded-md px-3 h-6 text-xs font-mono text-default-400 leading-none"
          >
            {getCurrentOperatorCallsign()}
          </Button>
          <Button
            onPress={handleOpenSettings}
            isIconOnly
            variant="light"
            size="sm"
            title="设置"
            aria-label="打开设置"
          >
            <FontAwesomeIcon icon={faCog} className="text-default-400" />
          </Button>
        </div>
      </div>
      
      {/* 主内容区域 */}
      <div className="flex-1 p-5 pt-0 flex flex-col gap-4 min-h-0">
        {/* 和我有关的通联信息 - 占据剩余空间 */}
        <div className="flex-1 min-h-0">
          <MyRelatedFT8Table className="h-full" />
        </div>
        
        {/* 操作员列表 - 固定高度 */}
        <div className="flex-shrink-0">
          <RadioOperatorList onCreateOperator={handleCreateOperator} />
        </div>
        
        {/* 电台控制 - 固定高度 */}
        <div className="flex-shrink-0">
          <RadioControl />
        </div>
      </div>

      {/* 设置弹窗 */}
      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={handleCloseSettings}
        initialTab={settingsInitialTab}
      />
    </div>
  );
};