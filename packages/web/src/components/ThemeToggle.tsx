import React from 'react';
import {
  Button,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Tooltip
} from '@heroui/react';
import { useTheme, ThemeMode } from '../hooks/useTheme';

// 图标组件
const SunIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0-2a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm12 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM4 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm18.192-8.192a1 1 0 0 1-1.414 1.414l-1.414-1.414a1 1 0 0 1 1.414-1.414l1.414 1.414zm-16.97 0l1.414 1.414a1 1 0 0 1-1.414 1.414l-1.414-1.414a1 1 0 0 1 1.414-1.414zM7.05 13.657l1.414 1.414a1 1 0 1 1-1.414 1.414L5.636 15.07a1 1 0 1 1 1.414-1.414zm9.9-7.071a1 1 0 0 1 1.414 1.414L16.95 9.414a1 1 0 1 1-1.414-1.414L17.95 6.586zm-9.9 0a1 1 0 1 1 1.414-1.414L9.879 7.515a1 1 0 1 1-1.414 1.414L7.05 7.515zM23 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
  </svg>
);

const MoonIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.742 13.045a8.088 8.088 0 0 1-2.077.271c-2.135 0-4.14-.83-5.646-2.336a8.025 8.025 0 0 1-2.064-7.723A1 1 0 0 0 9.73 2.034a10.014 10.014 0 0 0-4.489 2.582c-3.898 3.898-3.898 10.243 0 14.143a9.937 9.937 0 0 0 7.072 2.93 9.93 9.93 0 0 0 7.07-2.929 10.007 10.007 0 0 0 2.583-4.491 1.001 1.001 0 0 0-1.224-1.224zm-2.772 4.301a7.947 7.947 0 0 1-5.656 2.343 7.953 7.953 0 0 1-5.658-2.344c-3.118-3.119-3.118-8.195 0-11.314a7.923 7.923 0 0 1 2.06-1.483 10.027 10.027 0 0 0 2.89 7.848 9.972 9.972 0 0 0 7.848 2.891 7.977 7.977 0 0 1-1.484 2.059z"/>
  </svg>
);

const SystemIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6zm14 0H6v7h12V6zm-3 9a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1h7z"/>
  </svg>
);

interface ThemeToggleProps {
  variant?: 'button' | 'dropdown';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const ThemeToggle: React.FC<ThemeToggleProps> = ({ 
  variant = 'dropdown', 
  size = 'md',
  className = '' 
}) => {
  const { theme, themeMode, setThemeMode, toggleTheme } = useTheme();

  const getThemeIcon = (mode: ThemeMode) => {
    switch (mode) {
      case 'light':
        return <SunIcon size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />;
      case 'dark':
        return <MoonIcon size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />;
      case 'system':
        return <SystemIcon size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />;
    }
  };

  const getThemeLabel = (mode: ThemeMode) => {
    switch (mode) {
      case 'light':
        return '浅色模式';
      case 'dark':
        return '深色模式';
      case 'system':
        return '跟随系统';
    }
  };

  if (variant === 'button') {
    return (
      <Tooltip content={`切换到${theme === 'dark' ? '浅色' : '深色'}模式`}>
        <Button
          isIconOnly
          variant="light"
          size={size}
          className={className}
          onPress={toggleTheme}
          aria-label="切换主题"
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </Button>
      </Tooltip>
    );
  }

  return (
    <Dropdown>
      <DropdownTrigger>
        <Button
          isIconOnly
          variant="light"
          size={size}
          className={className}
          aria-label="选择主题"
        >
          {getThemeIcon(themeMode)}
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label="主题选择"
        selectedKeys={[themeMode]}
        selectionMode="single"
        onSelectionChange={(keys) => {
          const selectedKey = Array.from(keys)[0] as ThemeMode;
          if (selectedKey) {
            setThemeMode(selectedKey);
          }
        }}
      >
        <DropdownItem
          key="light"
          startContent={<SunIcon size={16} />}
          description="使用浅色主题"
        >
          浅色模式
        </DropdownItem>
        <DropdownItem
          key="dark"
          startContent={<MoonIcon size={16} />}
          description="使用深色主题"
        >
          深色模式
        </DropdownItem>
        <DropdownItem
          key="system"
          startContent={<SystemIcon size={16} />}
          description="跟随系统设置"
        >
          跟随系统
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  );
}; 