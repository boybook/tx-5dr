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
import { useTheme, ThemeMode } from '../../hooks/useTheme';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation('common');
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

  const _getThemeLabel = (mode: ThemeMode) => {
    switch (mode) {
      case 'light':
        return t('theme.light');
      case 'dark':
        return t('theme.dark');
      case 'system':
        return t('theme.system');
    }
  };

  if (variant === 'button') {
    return (
      <Tooltip content={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}>
        <Button
          isIconOnly
          variant="light"
          size={size}
          className={className}
          onPress={toggleTheme}
          aria-label={t('theme.toggle')}
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
          aria-label={t('theme.select')}
        >
          {getThemeIcon(themeMode)}
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label={t('theme.select')}
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
          description={t('theme.lightDesc')}
        >
          {t('theme.light')}
        </DropdownItem>
        <DropdownItem
          key="dark"
          startContent={<FontAwesomeIcon icon={faMoon} className="text-sm text-default-400" />}
          description={t('theme.darkDesc')}
        >
          {t('theme.dark')}
        </DropdownItem>
        <DropdownItem
          key="system"
          startContent={<FontAwesomeIcon icon={faCircleHalfStroke} className="text-sm text-default-400" />}
          description={t('theme.systemDesc')}
        >
          {t('theme.system')}
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  );
}; 