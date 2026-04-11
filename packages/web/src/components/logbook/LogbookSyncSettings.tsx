import React, { useState, useEffect } from 'react';
import {
  Tabs,
  Tab,
  Card,
  CardBody,
  Spinner,
} from '@heroui/react';
import { PluginIframeHost } from '../plugins/PluginIframeHost';
import { useTranslation } from 'react-i18next';

interface SyncProviderInfo {
  id: string;
  pluginName: string;
  displayName: string;
  settingsPageId: string;
}

interface LogbookSyncSettingsProps {
  callsign: string;
  initialTab?: string;
}

export function LogbookSyncSettings({ callsign, initialTab }: LogbookSyncSettingsProps) {
  const { t } = useTranslation('logbook');
  const [providers, setProviders] = useState<SyncProviderInfo[]>([]);
  const [activeTab, setActiveTab] = useState<string>(initialTab || '');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/plugins/sync-providers')
      .then(r => r.json())
      .then((data: SyncProviderInfo[]) => {
        setProviders(data);
        if (!activeTab && data.length > 0) {
          setActiveTab(initialTab || data[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab, callsign]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="md" />
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="text-center py-12 text-default-500">
        {t('logbookSyncSettings.noProviders', 'No sync providers available')}
      </div>
    );
  }

  const activeProvider = providers.find(p => p.id === activeTab);

  return (
    <Card>
      <CardBody className="p-0">
        <Tabs
          selectedKey={activeTab}
          onSelectionChange={(key) => setActiveTab(key as string)}
          size="md"
          fullWidth
          classNames={{
            tabList: "gap-0 w-full relative rounded-none p-0 border-b border-divider",
            tab: "max-w-fit px-6 h-12 rounded-none",
            tabContent: "group-data-[selected=true]:text-primary-600",
            panel: "p-6"
          }}
        >
          {providers.map((provider) => (
            <Tab
              key={provider.id}
              title={
                <span className="text-sm font-medium">{provider.displayName}</span>
              }
            >
              {activeProvider?.id === provider.id && (
                <PluginIframeHost
                  pluginName={provider.pluginName}
                  pageId={provider.settingsPageId}
                  params={{ callsign }}
                  minHeight={400}
                />
              )}
            </Tab>
          ))}
        </Tabs>
      </CardBody>
    </Card>
  );
}
