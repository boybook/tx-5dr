import React, { useState, useEffect } from 'react';
import { 
  Card, 
  CardHeader, 
  CardBody, 
  Divider, 
  ScrollShadow,
  Badge,
  Button,
  Select,
  SelectItem
} from '@heroui/react';
import { useSlotPacks } from '../store/radioStore';
import { RadioControl } from '../components/RadioControl';
import { SettingsModal } from '../components/SettingsModal';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog } from '@fortawesome/free-solid-svg-icons';

export const RightLayout: React.FC = () => {
  const slotPacks = useSlotPacks();
  const [logs, setLogs] = useState<string[]>([]);
  const [selectedMode, setSelectedMode] = useState<string>('auto5');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // 监听状态变化，生成日志
  useEffect(() => {
    if (slotPacks.state.lastUpdateTime) {
      const newLog = `${slotPacks.state.lastUpdateTime.toLocaleTimeString()} - 接收到新的FT8数据包`;
      setLogs(prev => [...prev.slice(-19), newLog]); // 保持最新20条日志
    }
  }, [slotPacks.state.lastUpdateTime]);

  // 清空日志
  const handleClearLogs = () => {
    setLogs([]);
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
    setIsSettingsOpen(true);
  };

  // 关闭设置弹窗
  const handleCloseSettings = () => {
    setIsSettingsOpen(false);
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
            BG5DRB
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
        {/* 系统日志 - 占据剩余空间 */}
        <Card className="flex-1 min-h-0">
          <CardHeader className="pb-2 flex-shrink-0">
            <div className="flex justify-between items-center w-full">
              <h3 className="text-lg font-semibold">系统日志</h3>
              <div className="flex items-center gap-2">
                <Badge content={logs.length} color="primary" size="sm" aria-label={`${logs.length}条系统日志`}>
                  <div className="w-4 h-4"></div>
                </Badge>
                <Button 
                  size="sm" 
                  color="default" 
                  variant="flat"
                  onPress={handleClearLogs}
                >
                  清空
                </Button>
              </div>
            </div>
          </CardHeader>
          <Divider className="flex-shrink-0" />
          <CardBody className="pt-4 flex-1 min-h-0">
            <ScrollShadow className="h-full">
              {logs.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-default-400 mb-2 text-4xl">📋</div>
                  <p className="text-default-500 mb-1">暂无系统日志</p>
                  <p className="text-default-400 text-sm">系统操作和事件将在这里显示</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {logs.map((log, index) => (
                    <div 
                      key={index} 
                      className="font-mono text-sm p-2 rounded bg-default-50 border-l-2 border-primary-200"
                    >
                      {log}
                    </div>
                  ))}
                </div>
              )}
            </ScrollShadow>
          </CardBody>
        </Card>
        
        {/* 电台控制 - 固定高度 */}
        <div className="flex-shrink-0">
          <RadioControl />
        </div>
      </div>

      {/* 设置弹窗 */}
      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={handleCloseSettings} 
      />
    </div>
  );
};