import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Tabs,
  Tab,
  Divider
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSave } from '@fortawesome/free-solid-svg-icons';
import { AudioDeviceSettings, type AudioDeviceSettingsRef } from './AudioDeviceSettings';
import { RadioDeviceSettings, type RadioDeviceSettingsRef } from './RadioDeviceSettings';
import { OperatorSettings, type OperatorSettingsRef } from './OperatorSettings';
import { DisplayNotificationSettings, type DisplayNotificationSettingsRef } from './DisplayNotificationSettings';
import { LogbookSyncSettings, type LogbookSyncSettingsRef } from './LogbookSyncSettings';
import { SystemSettings, type SystemSettingsRef } from './SystemSettings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTab; // 可选的初始标签页
}

// 设置标签页类型
type SettingsTab = 'radio' | 'audio' | 'operator' | 'display' | 'logbook_sync' | 'system';

export function SettingsModal({ isOpen, onClose, initialTab }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab || 'radio');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'close' | 'changeTab' | null>(null);
  const [pendingTab, setPendingTab] = useState<SettingsTab | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  
  // 用于检查组件是否有未保存的更改
  const audioSettingsRef = useRef<AudioDeviceSettingsRef | null>(null);
  const radioSettingsRef = useRef<RadioDeviceSettingsRef | null>(null);
  const operatorSettingsRef = useRef<OperatorSettingsRef | null>(null);
  const displaySettingsRef = useRef<DisplayNotificationSettingsRef | null>(null);
  const logbookSyncSettingsRef = useRef<LogbookSyncSettingsRef | null>(null);
  const systemSettingsRef = useRef<SystemSettingsRef | null>(null);

  // 当弹窗打开时，重置到初始标签页
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab || 'radio');
      setHasUnsavedChanges(false);
    }
  }, [isOpen, initialTab]);

  // 监听屏幕宽度变化，判断是否为移动端
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');

    setIsMobile(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  // 检查是否有未保存的更改
  const checkUnsavedChanges = useCallback(() => {
    // 根据当前活动标签页检查对应的组件
    switch (activeTab) {
      case 'audio':
        return audioSettingsRef.current?.hasUnsavedChanges() || false;
      case 'radio':
        return radioSettingsRef.current?.hasUnsavedChanges() || false;
      case 'operator':
        return operatorSettingsRef.current?.hasUnsavedChanges() || false;
      case 'display':
        return displaySettingsRef.current?.hasUnsavedChanges() || false;
      case 'logbook_sync':
        return logbookSyncSettingsRef.current?.hasUnsavedChanges() || false;
      case 'system':
        return systemSettingsRef.current?.hasUnsavedChanges() || false;
      default:
        return false;
    }
  }, [activeTab]);

  // 处理标签页切换
  const handleTabChange = useCallback((key: React.Key) => {
    const newTab = key as SettingsTab;
    
    if (checkUnsavedChanges()) {
      setPendingAction('changeTab');
      setPendingTab(newTab);
      setIsConfirmDialogOpen(true);
    } else {
      setActiveTab(newTab);
      setHasUnsavedChanges(false);
    }
  }, [checkUnsavedChanges]);

  // 处理关闭弹窗
  const handleClose = useCallback(() => {
    if (checkUnsavedChanges()) {
      setPendingAction('close');
      setPendingTab(null);
      setIsConfirmDialogOpen(true);
    } else {
      onClose();
      setHasUnsavedChanges(false);
    }
  }, [checkUnsavedChanges, onClose]);

  // 处理保存操作
  const handleSave = useCallback(async () => {
    try {
      // 根据当前活动标签页调用对应组件的保存方法
      switch (activeTab) {
        case 'audio':
          if (audioSettingsRef.current) {
            await audioSettingsRef.current.save();
          }
          break;
        case 'radio':
          if (radioSettingsRef.current) {
            await radioSettingsRef.current.save();
          }
          break;
        case 'operator':
          if (operatorSettingsRef.current) {
            await operatorSettingsRef.current.save();
          }
          break;
        case 'display':
          if (displaySettingsRef.current) {
            await displaySettingsRef.current.save();
          }
          break;
        case 'logbook_sync':
          if (logbookSyncSettingsRef.current) {
            await logbookSyncSettingsRef.current.save();
          }
          break;
        case 'system':
          if (systemSettingsRef.current) {
            await systemSettingsRef.current.save();
          }
          break;
        // 其他标签页的保存逻辑将在后续实现
        default:
          break;
      }
      
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('保存设置失败:', error);
      // 这里可以添加错误提示
    }
  }, [activeTab]);

  // 处理确认对话框的确认保存
  const handleConfirmSave = useCallback(async () => {
    try {
      // 先保存当前设置
      await handleSave();
      
      setIsConfirmDialogOpen(false);
      
      if (pendingAction === 'close') {
        onClose();
      } else if (pendingAction === 'changeTab' && pendingTab) {
        setActiveTab(pendingTab);
      }
      
      setPendingAction(null);
      setPendingTab(null);
    } catch (error) {
      console.error('保存设置失败:', error);
      // 保存失败时不执行后续操作
      setIsConfirmDialogOpen(false);
      setPendingAction(null);
      setPendingTab(null);
    }
  }, [handleSave, pendingAction, pendingTab, onClose]);

  // 处理确认对话框的不保存
  const handleConfirmDiscard = useCallback(() => {
    setIsConfirmDialogOpen(false);
    
    if (pendingAction === 'close') {
      onClose();
    } else if (pendingAction === 'changeTab' && pendingTab) {
      setActiveTab(pendingTab);
    }
    
    setHasUnsavedChanges(false);
    setPendingAction(null);
    setPendingTab(null);
  }, [pendingAction, pendingTab, onClose]);

  // 处理确认对话框的取消
  const handleConfirmCancel = useCallback(() => {
    setIsConfirmDialogOpen(false);
    setPendingAction(null);
    setPendingTab(null);
  }, []);

  // 获取标签页标题
  const getTabTitle = (tab: SettingsTab, mobileMode: boolean = false) => {
    // 移动端只返回emoji
    if (mobileMode) {
      switch (tab) {
        case 'audio':
          return '🎤';
        case 'radio':
          return '📻';
        case 'operator':
          return '👤';
        case 'display':
          return '🎨';
        case 'logbook_sync':
          return '📊';
        case 'system':
          return '⚙️';
        default:
          return '⚙️';
      }
    }

    // 桌面端返回完整标题
    switch (tab) {
      case 'audio':
        return '🎤 音频设备';
      case 'radio':
        return '📻 电台设备';
      case 'operator':
        return '👤 操作员';
      case 'display':
        return '🎨 显示通知';
      case 'logbook_sync':
        return '📊 通联日志同步';
      case 'system':
        return '⚙️ 系统设置';
      default:
        return '设置';
    }
  };

  // 渲染标签页内容
  const renderTabContent = () => {
    switch (activeTab) {
      case 'audio':
        return (
          <AudioDeviceSettings
            ref={audioSettingsRef}
            onUnsavedChanges={setHasUnsavedChanges}
          />
        );
      case 'radio':
        return (
          <RadioDeviceSettings
            ref={radioSettingsRef}
            onUnsavedChanges={setHasUnsavedChanges}
          />
        );
      case 'operator':
        return (
          <OperatorSettings
            ref={operatorSettingsRef}
            onUnsavedChanges={setHasUnsavedChanges}
          />
        );
      case 'display':
        return (
          <DisplayNotificationSettings
            ref={displaySettingsRef}
            onUnsavedChanges={setHasUnsavedChanges}
          />
        );
      case 'logbook_sync':
        return (
          <LogbookSyncSettings
            ref={logbookSyncSettingsRef}
            onUnsavedChanges={setHasUnsavedChanges}
          />
        );
      case 'system':
        return (
          <SystemSettings
            ref={systemSettingsRef}
            onUnsavedChanges={setHasUnsavedChanges}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      {/* 主设置弹窗 */}
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        size={isMobile ? "full" : "5xl"}
        scrollBehavior="inside"
        placement="center"
        backdrop="blur"
        classNames={{
          body: "p-0",
          header: "border-b border-divider px-3 sm:px-6 py-3 sm:py-4",
          footer: "border-t border-divider px-3 sm:px-6 py-3 sm:py-4",
        }}
      >
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            <h2 className="text-xl font-bold">TX5DR 设置</h2>
            <p className="text-sm text-default-500 font-normal">
              配置应用程序的各种设置选项
            </p>
          </ModalHeader>
          
          <ModalBody>
            <div
              className={`min-h-0 ${isMobile ? 'flex flex-col' : 'flex'}`}
              style={{
                height: isMobile ? 'calc(100vh - 180px)' : 'calc(95vh - 180px)',
                minHeight: '400px',
                maxHeight: isMobile ? 'none' : '600px'
              }}
            >
              {/* 标签页菜单 */}
              <div className={isMobile ? 'px-3 py-2 border-b border-divider' : 'p-5 pr-1'}>
                <Tabs
                  selectedKey={activeTab}
                  onSelectionChange={handleTabChange}
                  isVertical={!isMobile}
                  size='md'
                  className={isMobile ? '' : 'h-full'}
                  classNames={{
                    tab: isMobile ? "h-10" : "w-full h-10 sm:px-4",
                    tabContent: `group-data-[selected=true]:text-primary-600 text-default-500 ${isMobile ? 'text-xl' : ''}`,
                    tabList: isMobile ? 'overflow-x-auto' : '',
                  }}
                >
                  <Tab
                    key="radio"
                    title={getTabTitle('radio', isMobile)}
                  />
                  <Tab
                    key="audio"
                    title={getTabTitle('audio', isMobile)}
                  />
                  <Tab
                    key="operator"
                    title={getTabTitle('operator', isMobile)}
                  />
                  <Tab
                    key="display"
                    title={getTabTitle('display', isMobile)}
                  />
                  <Tab
                    key="logbook_sync"
                    title={getTabTitle('logbook_sync', isMobile)}
                  />
                  <Tab
                    key="system"
                    title={getTabTitle('system', isMobile)}
                  />
                </Tabs>
              </div>

              {/* 内容区域 */}
              <div className="flex-1 overflow-auto min-h-0">
                <div className="p-3 sm:p-6">
                  {renderTabContent()}
                </div>
              </div>
            </div>
          </ModalBody>

          <ModalFooter>
            <div className="flex justify-between items-center w-full">
              <div className="text-sm text-default-400">
                {hasUnsavedChanges && (
                  <span className="text-warning-600">● 有未保存的更改</span>
                )}
              </div>
              <div className="flex gap-3">
                <Button 
                  variant="flat"
                  onPress={handleSave}
                  isDisabled={!hasUnsavedChanges}
                  className="bg-content1 border border-divider hover:bg-content2"
                >
                  <FontAwesomeIcon icon={faSave} className="mr-2" />
                  保存设置
                </Button>
              </div>
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 确认对话框 */}
      <Modal 
        isOpen={isConfirmDialogOpen} 
        onClose={handleConfirmCancel}
        size="sm"
        placement="center"
        backdrop="blur"
      >
        <ModalContent>
          <ModalHeader>
            <h3 className="text-lg font-semibold">未保存的更改</h3>
          </ModalHeader>
          <ModalBody>
            <p className="text-default-600">
              您有未保存的设置更改。您希望保存这些更改吗？
            </p>
          </ModalBody>
          <ModalFooter>
            <Button 
              variant="flat"
              onPress={handleConfirmCancel}
            >
              取消
            </Button>
            <Button 
              color="danger"
              variant="flat"
              onPress={handleConfirmDiscard}
            >
              不保存
            </Button>
            <Button 
              color="primary"
              onPress={handleConfirmSave}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
} 