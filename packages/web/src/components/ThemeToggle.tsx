import React from 'react';
import {
  Button,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Tooltip
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSun, faMoon, faCircleHalfStroke } from '@fortawesome/free-solid-svg-icons';
import { useTheme, ThemeMode } from '../hooks/useTheme';

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
    const iconSize = size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-lg' : 'text-base';
    
    switch (mode) {
      case 'light':
        return <FontAwesomeIcon icon={faSun} className={`${iconSize} text-default-400`} />;
      case 'dark':
        return <FontAwesomeIcon icon={faMoon} className={`${iconSize} text-default-400`} />;
      case 'system':
        return <FontAwesomeIcon icon={faCircleHalfStroke} className={`${iconSize} text-default-400`} />;
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
          {theme === 'dark' ? 
            <FontAwesomeIcon icon={faSun} className="text-default-400" /> : 
            <FontAwesomeIcon icon={faMoon} className="text-default-400" />
          }
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
          startContent={<FontAwesomeIcon icon={faSun} className="text-sm text-default-400" />}
          description="使用浅色主题"
        >
          浅色模式
        </DropdownItem>
        <DropdownItem
          key="dark"
          startContent={<FontAwesomeIcon icon={faMoon} className="text-sm text-default-400" />}
          description="使用深色主题"
        >
          深色模式
        </DropdownItem>
        <DropdownItem
          key="system"
          startContent={<FontAwesomeIcon icon={faCircleHalfStroke} className="text-sm text-default-400" />}
          description="跟随系统设置"
        >
          跟随系统
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  );
}; 