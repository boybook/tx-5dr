import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  Tabs,
  Tab,
  Card,
  CardBody,
} from '@heroui/react';
import { WaveLogSettings, type WaveLogSettingsRef } from './WaveLogSettings';

export interface LogbookSyncSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface LogbookSyncSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

type SyncProviderTab = 'wavelog' | 'qrz' | 'lotw';

export const LogbookSyncSettings = forwardRef<LogbookSyncSettingsRef, LogbookSyncSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
    const [activeTab, setActiveTab] = useState<SyncProviderTab>('wavelog');
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    
    // 各个同步服务的引用
    const waveLogRef = React.useRef<WaveLogSettingsRef>(null);
    // 未来的其他服务引用...
    // const qrzRef = React.useRef<QRZSettingsRef>(null);
    // const lotwRef = React.useRef<LOTWSettingsRef>(null);

    // 暴露给父组件的方法
    useImperativeHandle(ref, () => ({
      hasUnsavedChanges: () => {
        switch (activeTab) {
          case 'wavelog':
            return waveLogRef.current?.hasUnsavedChanges() || false;
          // case 'qrz':
          //   return qrzRef.current?.hasUnsavedChanges() || false;
          // case 'lotw':
          //   return lotwRef.current?.hasUnsavedChanges() || false;
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
          // case 'qrz':
          //   if (qrzRef.current) {
          //     await qrzRef.current.save();
          //   }
          //   break;
          // case 'lotw':
          //   if (lotwRef.current) {
          //     await lotwRef.current.save();
          //   }
          //   break;
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
        // case 'qrz':
        //   currentHasChanges = qrzRef.current?.hasUnsavedChanges() || false;
        //   break;
        // case 'lotw':
        //   currentHasChanges = lotwRef.current?.hasUnsavedChanges() || false;
        //   break;
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
            description: '支持双向同步的业余无线电日志服务'
          };
        case 'qrz':
          return { 
            title: 'QRZ.com', 
            icon: '🔍',
            description: '全球业余无线电操作员数据库' 
          };
        case 'lotw':
          return { 
            title: 'LoTW', 
            icon: '📋',
            description: 'ARRL\'s Logbook of The World' 
          };
        default:
          return { title: '未知', icon: '❓', description: '' };
      }
    };

    // 渲染Tab内容
    const renderTabContent = () => {
      switch (activeTab) {
        case 'wavelog':
          return (
            <WaveLogSettings
              ref={waveLogRef}
              onUnsavedChanges={handleChildUnsavedChanges}
            />
          );
        case 'qrz':
          return (
            <div className="text-center py-12">
              <div className="text-6xl mb-4">🔍</div>
              <h3 className="text-lg font-semibold text-default-700 mb-2">QRZ.com 同步</h3>
              <p className="text-default-500 mb-4">即将推出...</p>
              <p className="text-sm text-default-400">
                QRZ.com 是全球最大的业余无线电操作员数据库，将支持联络人信息查询和日志上传功能。
              </p>
            </div>
          );
        case 'lotw':
          return (
            <div className="text-center py-12">
              <div className="text-6xl mb-4">📋</div>
              <h3 className="text-lg font-semibold text-default-700 mb-2">LoTW 同步</h3>
              <p className="text-default-500 mb-4">即将推出...</p>
              <p className="text-sm text-default-400">
                ARRL 的 Logbook of The World 是官方的QSL确认系统，将支持联络确认和奖状申请功能。
              </p>
            </div>
          );
        default:
          return null;
      }
    };

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">通联日志同步</h3>
          <p className="text-sm text-default-500 mt-1">
            配置与各种业余无线电日志服务的同步设置
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
                      <span className="text-xs text-default-400">已配置</span>
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
                      <span className="text-xs text-default-400">即将推出</span>
                    </div>
                  </div>
                }
                isDisabled
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
                      <span className="text-xs text-default-400">即将推出</span>
                    </div>
                  </div>
                }
                isDisabled
              >
                {renderTabContent()}
              </Tab>
            </Tabs>
          </CardBody>
        </Card>

        {/* 服务说明 */}
        <div className="p-4 bg-default-50 rounded-lg">
          <h5 className="text-sm font-medium text-default-700 mb-2">支持的同步服务</h5>
          <ul className="text-xs text-default-600 space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-primary-500">●</span>
              <div>
                <strong>WaveLog</strong> - 开源的业余无线电日志系统，支持双向同步、实时上传和批量下载
              </div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-default-400">●</span>
              <div>
                <strong>QRZ.com</strong> - 全球业余无线电数据库，用于联络人信息查询和验证
              </div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-default-400">●</span>
              <div>
                <strong>LoTW</strong> - ARRL官方QSL确认系统，用于奖状申请和联络确认
              </div>
            </li>
          </ul>
        </div>
      </div>
    );
  }
);

LogbookSyncSettings.displayName = 'LogbookSyncSettings';