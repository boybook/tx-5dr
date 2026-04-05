import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  Tabs,
  Tab,
  Card,
  CardBody,
} from '@heroui/react';
import { WaveLogSettings, type WaveLogSettingsRef } from './WaveLogSettings';
import { QRZSettings, type QRZSettingsRef } from './QRZSettings';
import { LoTWSettings, type LoTWSettingsRef } from './LoTWSettings';
import { useTranslation } from 'react-i18next';

export interface LogbookSyncSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

type SyncProviderTab = 'wavelog' | 'qrz' | 'lotw';

interface LogbookSyncSettingsProps {
  callsign: string;
  initialTab?: SyncProviderTab;
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const LogbookSyncSettings = forwardRef<LogbookSyncSettingsRef, LogbookSyncSettingsProps>(
  ({ callsign, initialTab, onUnsavedChanges }, ref) => {
    const { t } = useTranslation('logbook');
    const [activeTab, setActiveTab] = useState<SyncProviderTab>(initialTab || 'wavelog');
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

    // 各个同步服务的引用
    const waveLogRef = React.useRef<WaveLogSettingsRef>(null);
    const qrzRef = React.useRef<QRZSettingsRef>(null);
    const lotwRef = React.useRef<LoTWSettingsRef>(null);

    useEffect(() => {
      setActiveTab(initialTab || 'wavelog');
    }, [initialTab, callsign]);

    // 暴露给父组件的方法
    useImperativeHandle(ref, () => ({
      hasUnsavedChanges: () => {
        switch (activeTab) {
          case 'wavelog':
            return waveLogRef.current?.hasUnsavedChanges() || false;
          case 'qrz':
            return qrzRef.current?.hasUnsavedChanges() || false;
          case 'lotw':
            return lotwRef.current?.hasUnsavedChanges() || false;
          default:
            return false;
        }
      },
      save: async () => {
        switch (activeTab) {
          case 'wavelog':
            if (waveLogRef.current) {
              await waveLogRef.current.save();
            }
            break;
          case 'qrz':
            if (qrzRef.current) {
              await qrzRef.current.save();
            }
            break;
          case 'lotw':
            if (lotwRef.current) {
              await lotwRef.current.save();
            }
            break;
          default:
            break;
        }
      }
    }));

    // 检查当前活动Tab是否有未保存的更改
    useEffect(() => {
      let currentHasChanges = false;

      switch (activeTab) {
        case 'wavelog':
          currentHasChanges = waveLogRef.current?.hasUnsavedChanges() || false;
          break;
        case 'qrz':
          currentHasChanges = qrzRef.current?.hasUnsavedChanges() || false;
          break;
        case 'lotw':
          currentHasChanges = lotwRef.current?.hasUnsavedChanges() || false;
          break;
        default:
          currentHasChanges = false;
      }

      if (currentHasChanges !== hasUnsavedChanges) {
        setHasUnsavedChanges(currentHasChanges);
        onUnsavedChanges?.(currentHasChanges);
      }
    }, [activeTab, hasUnsavedChanges, onUnsavedChanges]);

    // 处理子组件的未保存更改通知
    const handleChildUnsavedChanges = (hasChanges: boolean) => {
      setHasUnsavedChanges(hasChanges);
      onUnsavedChanges?.(hasChanges);
    };

    // 获取Tab标题和图标
    const getTabInfo = (tab: SyncProviderTab) => {
      switch (tab) {
        case 'wavelog':
          return {
            title: 'WaveLog',
            icon: '📊',
            description: t('logbookSyncSettings.wavelogTabDesc')
          };
        case 'qrz':
          return {
            title: 'QRZ.com',
            icon: '🔍',
            description: t('logbookSyncSettings.qrzTabDesc')
          };
        case 'lotw':
          return {
            title: 'LoTW',
            icon: '📋',
            description: 'ARRL\'s Logbook of The World'
          };
        default:
          return { title: t('logbookSyncSettings.unknownTab'), icon: '❓', description: '' };
      }
    };

    // 渲染Tab内容
    const renderTabContent = () => {
      switch (activeTab) {
        case 'wavelog':
          return (
            <WaveLogSettings
              ref={waveLogRef}
              callsign={callsign}
              onUnsavedChanges={handleChildUnsavedChanges}
            />
          );
        case 'qrz':
          return (
            <QRZSettings
              ref={qrzRef}
              callsign={callsign}
              onUnsavedChanges={handleChildUnsavedChanges}
            />
          );
        case 'lotw':
          return (
            <LoTWSettings
              ref={lotwRef}
              callsign={callsign}
              onUnsavedChanges={handleChildUnsavedChanges}
            />
          );
        default:
          return null;
      }
    };

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">{t('logbookSyncSettings.title')}</h3>
          <p className="text-sm text-default-500 mt-1">
            {t('logbookSyncSettings.description')}
          </p>
        </div>

        <Card>
          <CardBody className="p-0">
            <Tabs
              selectedKey={activeTab}
              onSelectionChange={(key) => setActiveTab(key as SyncProviderTab)}
              size="md"
              fullWidth
              classNames={{
                tabList: "gap-0 w-full relative rounded-none p-0 border-b border-divider",
                tab: "max-w-fit px-6 h-12 rounded-none",
                tabContent: "group-data-[selected=true]:text-primary-600",
                panel: "p-6"
              }}
            >
              <Tab
                key="wavelog"
                title={
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{getTabInfo('wavelog').icon}</span>
                    <div className="flex flex-col items-start">
                      <span className="text-sm font-medium">{getTabInfo('wavelog').title}</span>
                      <span className="text-xs text-default-400">Web-based Logging</span>
                    </div>
                  </div>
                }
              >
                {renderTabContent()}
              </Tab>

              <Tab
                key="qrz"
                title={
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{getTabInfo('qrz').icon}</span>
                    <div className="flex flex-col items-start">
                      <span className="text-sm font-medium">{getTabInfo('qrz').title}</span>
                      <span className="text-xs text-default-400">QRZ.com Logbook</span>
                    </div>
                  </div>
                }
              >
                {renderTabContent()}
              </Tab>

              <Tab
                key="lotw"
                title={
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{getTabInfo('lotw').icon}</span>
                    <div className="flex flex-col items-start">
                      <span className="text-sm font-medium">{getTabInfo('lotw').title}</span>
                      <span className="text-xs text-default-400">Logbook of The World</span>
                    </div>
                  </div>
                }
              >
                {renderTabContent()}
              </Tab>
            </Tabs>
          </CardBody>
        </Card>

        {/* 服务说明 */}
        <div className="p-4 bg-default-50 rounded-lg">
          <h5 className="text-sm font-medium text-default-700 mb-2">{t('logbookSyncSettings.supportedServices')}</h5>
          <ul className="text-xs text-default-600 space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-primary-500">●</span>
              <div>
                <strong>WaveLog</strong> - {t('logbookSyncSettings.wavelogDesc')}
              </div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary-500">●</span>
              <div>
                <strong>QRZ.com</strong> - {t('logbookSyncSettings.qrzDesc')}
              </div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary-500">●</span>
              <div>
                <strong>LoTW</strong> - {t('logbookSyncSettings.lotwDesc')}
              </div>
            </li>
          </ul>
        </div>
      </div>
    );
  }
);

LogbookSyncSettings.displayName = 'LogbookSyncSettings';
