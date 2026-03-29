import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../utils/logger';

const logger = createLogger('SettingsModal');
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Tabs,
  Tab
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSave } from '@fortawesome/free-solid-svg-icons';
import { OperatorSettings, type OperatorSettingsRef } from './OperatorSettings';
import { DisplayNotificationSettings, type DisplayNotificationSettingsRef } from './DisplayNotificationSettings';
import { SystemSettings, type SystemSettingsRef } from './SystemSettings';
import { FrequencyPresetSettings, type FrequencyPresetSettingsRef } from './FrequencyPresetSettings';
import { TokenManagement } from './TokenManagement';
import { StationInfoSettings, type StationInfoSettingsRef } from './StationInfoSettings';
import { OpenWebRXSettings } from './OpenWebRXSettings';
import { useHasMinRole, useCan } from '../store/authStore';
import { UserRole } from '@tx5dr/contracts';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTab; // 可选的初始标签页
  initialFrequencyPresetMode?: string;
}

// 设置标签页类型（radio 和 audio 已迁移到 ProfileModal，logbook_sync 已迁移到 SyncConfigModal）
export type SettingsTab = 'radio' | 'audio' | 'operator' | 'display' | 'radio_profile' | 'system' | 'frequency_presets' | 'tokens' | 'station_info' | 'openwebrx';

export function SettingsModal({ isOpen, onClose, initialTab, initialFrequencyPresetMode }: SettingsModalProps) {
  const { t } = useTranslation('settings');
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const isOperator = useHasMinRole(UserRole.OPERATOR);
  const canRadioConfig = useCan('update', 'RadioConfig');
  const canFrequencyPresets = useCan('update', 'SettingsFrequencyPresets');
  const canStationInfo = useCan('update', 'StationInfo');
  // Viewers cannot access the operator tab; fall back to display
  const defaultTab: SettingsTab = isOperator ? 'operator' : 'display';
  // radio/audio 已迁移到 ProfileModal，默认 Tab 改为 operator（或 display 对 viewer）
  const effectiveInitialTab = (initialTab === 'radio' || initialTab === 'audio') ? defaultTab : (initialTab || defaultTab);
  const [activeTab, setActiveTab] = useState<SettingsTab>(effectiveInitialTab);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'close' | 'changeTab' | null>(null);
  const [pendingTab, setPendingTab] = useState<SettingsTab | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  // 用于检查组件是否有未保存的更改
  const operatorSettingsRef = useRef<OperatorSettingsRef | null>(null);
  const displaySettingsRef = useRef<DisplayNotificationSettingsRef | null>(null);
  const systemSettingsRef = useRef<SystemSettingsRef | null>(null);
  const frequencyPresetSettingsRef = useRef<FrequencyPresetSettingsRef | null>(null);
  const stationInfoSettingsRef = useRef<StationInfoSettingsRef | null>(null);

  // 当弹窗打开时，重置到初始标签页
  useEffect(() => {
    if (isOpen) {
      const tab = (initialTab === 'radio' || initialTab === 'audio') ? defaultTab : (initialTab || defaultTab);
      setActiveTab(tab);
      setHasUnsavedChanges(false);
    }
  }, [isOpen, initialTab, defaultTab]);

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
      case 'operator':
        return operatorSettingsRef.current?.hasUnsavedChanges() || false;
      case 'display':
        return displaySettingsRef.current?.hasUnsavedChanges() || false;
      case 'system':
        return systemSettingsRef.current?.hasUnsavedChanges() || false;
      case 'frequency_presets':
        return frequencyPresetSettingsRef.current?.hasUnsavedChanges() || false;
      case 'station_info':
        return stationInfoSettingsRef.current?.hasUnsavedChanges() || false;
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
        case 'system':
          if (systemSettingsRef.current) {
            await systemSettingsRef.current.save();
          }
          break;
        case 'frequency_presets':
          if (frequencyPresetSettingsRef.current) {
            await frequencyPresetSettingsRef.current.save();
          }
          break;
        case 'station_info':
          if (stationInfoSettingsRef.current) {
            await stationInfoSettingsRef.current.save();
          }
          break;
        default:
          break;
      }
      
      setHasUnsavedChanges(false);
    } catch (error) {
      logger.error('Failed to save settings:', error);
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
      logger.error('Failed to save settings:', error);
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
        case 'operator':
          return '👤';
        case 'display':
          return '🎨';
        case 'radio_profile':
          return '📻';
        case 'system':
          return '⚙️';
        case 'frequency_presets':
          return '📡';
        case 'tokens':
          return '🔑';
        case 'station_info':
          return '📡';
        case 'openwebrx':
          return '📻';
        default:
          return '⚙️';
      }
    }

    // 桌面端返回完整标题
    switch (tab) {
      case 'operator':
        return `👤 ${t('modal.tabOperator')}`;
      case 'display':
        return `🎨 ${t('modal.tabDisplay')}`;
      case 'radio_profile':
        return `📻 ${t('modal.tabRadioProfile')}`;
      case 'system':
        return `⚙️ ${t('modal.tabSystem')}`;
      case 'frequency_presets':
        return `📡 ${t('modal.tabFrequencyPresets')}`;
      case 'tokens':
        return `🔑 ${t('modal.tabTokens')}`;
      case 'station_info':
        return `📡 ${t('tab.stationInfo')}`;
      case 'openwebrx':
        return `📻 ${t('openwebrx.tabTitle')}`;
      default:
        return t('modal.defaultTab');
    }
  };

  // 渲染标签页内容
  const renderTabContent = () => {
    switch (activeTab) {
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
      case 'system':
        return (
          <SystemSettings
            ref={systemSettingsRef}
            onUnsavedChanges={setHasUnsavedChanges}
          />
        );
      case 'radio_profile':
        return (
          <div className="flex flex-col items-center justify-center py-12 gap-4 text-center">
            <p className="text-lg text-default-600">
              {t('modal.radioProfileDesc1')}
            </p>
            <p className="text-sm text-default-400">
              {t('modal.radioProfileDesc2')}
            </p>
            <Button
              color="primary"
              size="lg"
              className="mt-4"
              onPress={() => {
                onClose();
                window.dispatchEvent(new Event('openProfileModal'));
              }}
            >
              {t('modal.goToRadioProfile')}
            </Button>
          </div>
        );
      case 'frequency_presets':
        return (
          <FrequencyPresetSettings
            ref={frequencyPresetSettingsRef}
            onUnsavedChanges={setHasUnsavedChanges}
            initialModeFilter={initialFrequencyPresetMode}
          />
        );
      case 'tokens':
        return <TokenManagement />;
      case 'station_info':
        return <StationInfoSettings ref={stationInfoSettingsRef} onUnsavedChanges={setHasUnsavedChanges} />;
      case 'openwebrx':
        return <OpenWebRXSettings />;
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
        backdrop="opaque"
        disableAnimation
        classNames={{
          body: "p-0",
          header: "border-b border-divider px-3 sm:px-6 py-3 sm:py-4",
          footer: "border-t border-divider px-3 sm:px-6 py-3 sm:py-4",
        }}
      >
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            <h2 className="text-xl font-bold">{t('modal.title')}</h2>
            <p className="text-sm text-default-500 font-normal">
              {t('modal.subtitle')}
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
                  {isOperator && (
                    <Tab
                      key="operator"
                      title={getTabTitle('operator', isMobile)}
                    />
                  )}
                  <Tab
                    key="display"
                    title={getTabTitle('display', isMobile)}
                  />
                  {canRadioConfig && (
                    <Tab
                      key="radio_profile"
                      title={getTabTitle('radio_profile', isMobile)}
                    />
                  )}
                  {isAdmin && (
                    <Tab
                      key="system"
                      title={getTabTitle('system', isMobile)}
                    />
                  )}
                  {canFrequencyPresets && (
                    <Tab
                      key="frequency_presets"
                      title={getTabTitle('frequency_presets', isMobile)}
                    />
                  )}
                  {isAdmin && (
                    <Tab
                      key="tokens"
                      title={getTabTitle('tokens', isMobile)}
                    />
                  )}
                  {canStationInfo && (
                    <Tab
                      key="station_info"
                      title={getTabTitle('station_info', isMobile)}
                    />
                  )}
                  {isAdmin && (
                    <Tab
                      key="openwebrx"
                      title={getTabTitle('openwebrx', isMobile)}
                    />
                  )}
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
                  <span className="text-warning-600">{t('hasUnsavedChanges')}</span>
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
                  {t('modal.saveSettings')}
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
        backdrop="opaque"
        disableAnimation
      >
        <ModalContent>
          <ModalHeader>
            <h3 className="text-lg font-semibold">{t('confirmDialog.title')}</h3>
          </ModalHeader>
          <ModalBody>
            <p className="text-default-600">
              {t('confirmDialog.message')}
            </p>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={handleConfirmCancel}
            >
              {t('common:button.cancel')}
            </Button>
            <Button
              color="danger"
              variant="flat"
              onPress={handleConfirmDiscard}
            >
              {t('confirmDialog.discard')}
            </Button>
            <Button
              color="primary"
              onPress={handleConfirmSave}
            >
              {t('common:button.save')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
} 
