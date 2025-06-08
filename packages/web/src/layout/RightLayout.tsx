import React, { useState } from 'react';
import { 
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectItem
} from '@heroui/react';
import { useCurrentOperatorId, useOperators, useRadioState } from '../store/radioStore';
import { RadioControl } from '../components/RadioControl';
import { RadioOperatorList } from '../components/RadioOperatorList';
import { SettingsModal } from '../components/SettingsModal';
import { MyRelatedFramesTable } from '../components/MyRelatedFramesTable';
import { ThemeToggle } from '../components/ThemeToggle';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faCog } from '@fortawesome/free-solid-svg-icons';
import { AutomationSettingsPanel } from '../components/AutomationSettingsPanel';

export const RightLayout: React.FC = () => {
  const radio = useRadioState();
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const [selectedMode, setSelectedMode] = useState<string>('auto5');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'audio' | 'radio' | 'operator' | 'advanced'>('audio');

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
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          <div className="flex items-center gap-1">
            <Popover placement="bottom-start">
              <PopoverTrigger>
                <Button
                  variant="light" 
                  size="sm"
                  title="自动化程序"
                  className={`${isAutoMode ? 'bg-success-50 select-auto-mode' : 'bg-content2 select-manual-mode'} rounded-md px-3 h-6 text-xs font-mono text-default-600 leading-none`}
                >
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 bg-success-500 rounded-full flex-shrink-0"></div>
                    <span className="truncate">自动化程序</span>
                    <FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs -mr-1" />
                  </div>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="px-1">
                <div>
                  <AutomationSettingsPanel isOpen={true} onClose={() => {}} />
                </div>
              </PopoverContent>
            </Popover>
            
            <Button
              variant="light" 
              size="sm"
              title="电台呼号"
              className="bg-content2 rounded-md px-3 h-6 text-xs font-mono text-default-500 leading-none"
              onPress={() => {
                setSettingsInitialTab('operator');
                setIsSettingsOpen(true);
              }}
            >
              {
                currentOperatorId ? operators.find(op => op.id === currentOperatorId)?.context.myCall || 'N0CALL' : 'N0CALL'
              }
            </Button>
          </div>
          <div className="flex items-center gap-0">
            <ThemeToggle variant="dropdown" size="sm" />
            <Button
              onPress={handleOpenSettings}
              isIconOnly
              variant="light"
              size="sm"
              title="设置"
              aria-label="打开设置"
            >
              <FontAwesomeIcon icon={faCog} className="text-default-400 text-sm" />
            </Button>
          </div>
        </div>
      </div>
      
      {/* 主内容区域 */}
      <div className="flex-1 p-5 pt-0 flex flex-col gap-4 min-h-0">
        {/* 和我有关的通联信息 - 占据剩余空间 */}
        <div className="flex-1 min-h-0">
          <MyRelatedFramesTable className="h-full" />
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