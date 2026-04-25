import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useVisiblePluginPanelsForSlot } from '../plugins/pluginPanelSlots';
import { PluginPanelRenderer } from '../plugins/PluginPanelRenderer';

interface VoiceRightTopTabsProps {
  operatorId: string | null | undefined;
  nativeContent: React.ReactNode;
  toolbarRight?: React.ReactNode;
}

interface VoiceWorkspaceItem {
  key: string;
  label: string;
  content: React.ReactNode;
}

export const VoiceRightTopTabs: React.FC<VoiceRightTopTabsProps> = ({
  operatorId,
  nativeContent,
  toolbarRight,
}) => {
  const { t } = useTranslation('common');
  const entries = useVisiblePluginPanelsForSlot(operatorId, 'voice-right-top');

  const items = React.useMemo<VoiceWorkspaceItem[]>(() => {
    const nativeItem: VoiceWorkspaceItem = {
      key: 'native-qso',
      label: t('voice.qsoTab', 'QSOs'),
      content: nativeContent,
    };

    if (!operatorId) {
      return [nativeItem];
    }

    return [
      nativeItem,
      ...entries.map((entry) => ({
        key: entry.key,
        label: entry.tabLabel,
        content: (
          <PluginPanelRenderer
            pluginName={entry.pluginName}
            operatorId={operatorId}
            panelId={entry.panel.id}
            pluginGeneration={entry.pluginGeneration}
            title={entry.resolvedTitle}
            component={entry.panel.component}
            pageId={entry.panel.pageId}
            variant="pane"
            minHeight={260}
            fillHeight
            className="h-full min-h-0 flex-1"
            initialPanelMeta={entry.initialPanelMeta}
          />
        ),
      })),
    ];
  }, [entries, nativeContent, operatorId, t]);

  const [selectedKey, setSelectedKey] = React.useState<string>(() => items[0]?.key ?? '');

  React.useEffect(() => {
    if (items.length === 0) {
      if (selectedKey !== '') {
        setSelectedKey('');
      }
      return;
    }

    if (!items.some((item) => item.key === selectedKey)) {
      setSelectedKey(items[0].key);
    }
  }, [items, selectedKey]);

  const showTabBar = items.length > 1;

  return (
    <div className="h-full flex flex-col">
      <div
        className="flex-shrink-0 flex items-center gap-2 p-1 px-2 md:p-2 md:px-3 select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        {showTabBar ? (
          <div
            className="min-w-0 flex-shrink overflow-hidden"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}
          >
            <div className="flex flex-wrap items-center gap-1">
              {items.map((item) => {
                const selected = item.key === selectedKey;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setSelectedKey(item.key)}
                    className={[
                      'min-w-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      selected
                        ? 'bg-content2 text-foreground'
                        : 'text-default-500 hover:bg-content2/80 hover:text-foreground',
                    ].join(' ')}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="min-w-0 flex-1 self-stretch" aria-hidden="true" />
        <div
          className="flex flex-shrink-0 items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}
        >
          {toolbarRight}
        </div>
      </div>

      <div className="flex-1 px-2 pb-1 pt-0 md:px-5 md:pb-2 md:pt-0 flex flex-col gap-2 md:gap-3 min-h-0">
        {items.map((item) => {
          const selected = item.key === selectedKey;
          return (
            <div
              key={item.key}
              className={selected ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}
            >
              {item.content}
            </div>
          );
        })}
      </div>
    </div>
  );
};
