import * as React from 'react';

export interface PersistentTabItem {
  key: string;
  label: string;
  content: React.ReactNode;
}

interface PersistentTabsProps {
  items: PersistentTabItem[];
  initialActiveKey?: string;
  hideSingleTabBar?: boolean;
  className?: string;
  tabBarClassName?: string;
  panelClassName?: string;
}

export const PersistentTabs: React.FC<PersistentTabsProps> = ({
  items,
  initialActiveKey,
  hideSingleTabBar = true,
  className = '',
  tabBarClassName = '',
  panelClassName = '',
}) => {
  const [selectedKey, setSelectedKey] = React.useState<string>(() => initialActiveKey ?? items[0]?.key ?? '');

  React.useEffect(() => {
    if (items.length === 0) {
      if (selectedKey !== '') {
        setSelectedKey('');
      }
      return;
    }

    if (!items.some((item) => item.key === selectedKey)) {
      setSelectedKey(initialActiveKey && items.some((item) => item.key === initialActiveKey)
        ? initialActiveKey
        : items[0].key);
    }
  }, [initialActiveKey, items, selectedKey]);

  if (items.length === 0) {
    return null;
  }

  const showTabBar = !(hideSingleTabBar && items.length === 1);

  return (
    <div className={`h-full min-h-0 flex flex-col ${className}`.trim()}>
      {showTabBar && (
        <div className={`flex-shrink-0 border-b border-default-200/70 px-2 pt-2 ${tabBarClassName}`.trim()}>
          <div className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-content2/90 p-1">
            {items.map((item) => {
              const selected = item.key === selectedKey;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSelectedKey(item.key)}
                  className={[
                    'min-w-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                    selected
                      ? 'bg-content1 text-foreground shadow-sm'
                      : 'text-default-500 hover:bg-content1/70 hover:text-foreground',
                  ].join(' ')}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className={`flex-1 min-h-0 flex flex-col ${panelClassName}`.trim()}>
        {items.map((item) => {
          const selected = item.key === selectedKey;
          return (
            <div
              key={item.key}
              className={selected ? 'flex h-full min-h-0 flex-1 flex-col' : 'hidden'}
            >
              {item.content}
            </div>
          );
        })}
      </div>
    </div>
  );
};
