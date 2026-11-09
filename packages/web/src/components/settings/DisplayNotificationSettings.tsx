import React, { useState, useEffect, forwardRef, useImperativeHandle, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Switch,
  Button,
  Input,
  Tooltip,
  Chip,
  Select,
  SelectItem,
} from '@heroui/react';
import { useLanguage, type LanguageMode } from '../../hooks/useLanguage';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotateLeft, faPalette } from '@fortawesome/free-solid-svg-icons';
import { InteractiveColorPicker } from './InteractiveColorPicker';
import { ClientNotificationSettings } from './ClientNotificationSettings';
import { SettingsBlock, SettingsPage, SettingsRow, SettingsSection } from './SettingsLayout';
import {
  type DisplayNotificationSettings as DisplaySettings,
  type FrameTableCycleBackgrounds,
  HighlightType,
  getHighlightTypeLabels,
  getHighlightTypeDescriptions,
  PRESET_COLORS,
  getOrderedHighlightTypes,
  getDisplayNotificationSettings,
  getDefaultDisplayNotificationSettings,
  saveDisplayNotificationSettings,
  isDefaultSettings,
  isValidColor,
} from '../../utils/displayNotificationSettings';

export interface DisplayNotificationSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface DisplayNotificationSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const DisplayNotificationSettings = forwardRef<
  DisplayNotificationSettingsRef,
  DisplayNotificationSettingsProps
>(({ onUnsavedChanges }, ref) => {
  const { t } = useTranslation();
  const { languageMode, setLanguageMode } = useLanguage();
  const highlightTypeLabels = useMemo(() => getHighlightTypeLabels(t), [t]);
  const highlightTypeDescriptions = useMemo(() => getHighlightTypeDescriptions(t), [t]);
  const orderedHighlightTypes = useMemo(() => getOrderedHighlightTypes(), []);
  const [settings, setSettings] = useState<DisplaySettings>(getDisplayNotificationSettings());
  const [originalSettings, setOriginalSettings] = useState<DisplaySettings>(settings);
  const [_isSaving, setIsSaving] = useState(false);

  // 检查是否有未保存的更改
  const hasUnsavedChanges = () => {
    return JSON.stringify(settings) !== JSON.stringify(originalSettings);
  };

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    save: async () => {
      setIsSaving(true);
      try {
        saveDisplayNotificationSettings(settings);
        setOriginalSettings({ ...settings });
        onUnsavedChanges?.(false);
      } finally {
        setIsSaving(false);
      }
    },
  }));

  // 监听设置变化
  useEffect(() => {
    const hasChanges = hasUnsavedChanges();
    onUnsavedChanges?.(hasChanges);
  }, [settings, originalSettings, onUnsavedChanges]);

  // 更新全局开关
  const handleGlobalToggle = (enabled: boolean) => {
    setSettings((prev: DisplaySettings) => ({ ...prev, enabled }));
  };

  // 更新高亮类型的开关
  const handleHighlightToggle = (type: HighlightType, enabled: boolean) => {
    setSettings((prev: DisplaySettings) => ({
      ...prev,
      highlights: {
        ...prev.highlights,
        [type]: {
          ...prev.highlights[type],
          enabled,
        },
      },
    }));
  };

  // 更新高亮类型的颜色
  const handleColorChange = (type: HighlightType, color: string) => {
    if (!isValidColor(color)) return;
    
    setSettings((prev: DisplaySettings) => ({
      ...prev,
      highlights: {
        ...prev.highlights,
        [type]: {
          ...prev.highlights[type],
          color,
        },
      },
    }));
  };

  const handleFrameTableCycleBackgroundChange = (
    theme: keyof FrameTableCycleBackgrounds,
    cycle: keyof FrameTableCycleBackgrounds['light'],
    color: string,
  ) => {
    if (!isValidColor(color)) return;

    setSettings((prev: DisplaySettings) => ({
      ...prev,
      frameTableCycleBackgrounds: {
        ...prev.frameTableCycleBackgrounds,
        [theme]: {
          ...prev.frameTableCycleBackgrounds[theme],
          [cycle]: color,
        },
      },
    }));
  };

  const handleFrameTableGroupHeaderToggle = (frameTableGroupHeaderEnabled: boolean) => {
    setSettings((prev: DisplaySettings) => ({
      ...prev,
      frameTableGroupHeaderEnabled,
    }));
  };

  // 重置为默认设置
  const handleReset = () => {
    const defaultSettings = getDefaultDisplayNotificationSettings();
    setSettings(defaultSettings);
  };

  const renderColorPickerControls = (
    currentColor: string,
    onColorChange: (color: string) => void,
    options: { showPresets?: boolean } = {},
  ) => {
    const showPresets = options.showPresets ?? true;

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div
            className="h-8 w-8 shrink-0 rounded-medium border border-divider"
            style={{ backgroundColor: currentColor }}
          />
          <Input
            size="sm"
            value={currentColor}
            onChange={(e) => onColorChange(e.target.value)}
            className="flex-1"
            placeholder="#000000"
            startContent={<FontAwesomeIcon icon={faPalette} className="text-default-400" />}
          />
          <InteractiveColorPicker
            value={currentColor}
            onChange={onColorChange}
          />
        </div>

        {showPresets && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-default-500">{t('settings:display.presetColors')}</span>
            {PRESET_COLORS.map((color) => (
              <Tooltip key={color} content={color}>
                <button
                  type="button"
                  aria-label={color}
                  className={`h-5 w-5 rounded border-2 transition-transform hover:scale-110 ${
                    currentColor === color ? 'border-default-500' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: color }}
                  onClick={() => onColorChange(color)}
                />
              </Tooltip>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderHighlightRow = (type: HighlightType) => {
    const config = settings.highlights[type];
    const isEnabled = settings.enabled && config.enabled;

    return (
      <SettingsRow
        key={type}
        label={(
          <span className="flex items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: isEnabled ? config.color : '#d4d4d8', opacity: isEnabled ? 1 : 0.5 }}
            />
            {highlightTypeLabels[type]}
          </span>
        )}
        description={highlightTypeDescriptions[type]}
        control={(
          <Switch
            size="sm"
            isSelected={config.enabled}
            onValueChange={(enabled) => handleHighlightToggle(type, enabled)}
            isDisabled={!settings.enabled}
            aria-label={highlightTypeLabels[type]}
          />
        )}
      >
        {isEnabled
          ? renderColorPickerControls(config.color, (color) => handleColorChange(type, color))
          : undefined}
      </SettingsRow>
    );
  };

  const renderFrameTablePreview = (theme: keyof FrameTableCycleBackgrounds) => {
    const colors = settings.frameTableCycleBackgrounds[theme];
    const previewRows = [
      { cycle: 'even' as const, time: '00:00', message: 'CQ TEST PM95', color: colors.even },
      { cycle: 'odd' as const, time: '00:15', message: 'TEST K1ABC -10', color: colors.odd },
    ];

    return (
      <div
        className={`flex flex-col gap-1 rounded-medium border p-2 ${theme === 'dark' ? 'border-zinc-700 bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'}`}
      >
        {previewRows.map((row) => (
          <div
            key={row.cycle}
            className="grid grid-cols-[56px_44px_1fr] items-center gap-2 rounded px-3 py-1.5 font-mono text-xs"
            style={{ backgroundColor: row.color }}
          >
            <span>{row.time}</span>
            <span className="text-right">{row.cycle === 'even' ? '0' : '1'}</span>
            <span>{row.message}</span>
          </div>
        ))}
      </div>
    );
  };

  const renderFrameTableThemeRow = (theme: keyof FrameTableCycleBackgrounds) => (
    <SettingsRow
      label={theme === 'light' ? t('settings:display.frameTable.lightTheme') : t('settings:display.frameTable.darkTheme')}
      description={t('settings:display.frameTable.themeDescription')}
    >
      <div className="flex flex-col gap-3">
        {renderFrameTablePreview(theme)}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(['even', 'odd'] as const).map((cycle) => (
            <div key={cycle} className="flex flex-col gap-1.5">
              <span className="text-xs text-default-500">
                {cycle === 'even' ? t('settings:display.frameTable.evenCycle') : t('settings:display.frameTable.oddCycle')}
              </span>
              {renderColorPickerControls(
                settings.frameTableCycleBackgrounds[theme][cycle],
                (color) => handleFrameTableCycleBackgroundChange(theme, cycle, color),
                { showPresets: false },
              )}
            </div>
          ))}
        </div>
      </div>
    </SettingsRow>
  );

  const enabledHighlightTypes = orderedHighlightTypes.filter((type) => settings.highlights[type].enabled);

  return (
    <SettingsPage
      title={t('settings:display.title')}
      description={t('settings:display.pageDescription')}
    >
      <SettingsSection title={t('settings:display.sectionGeneral')}>
        <SettingsRow
          label={t('settings:language.label')}
          control={(
            <Select
              size="sm"
              className="w-40"
              aria-label={t('settings:language.label')}
              selectedKeys={new Set([languageMode])}
              onSelectionChange={(keys) => {
                const arr = Array.from(keys);
                if (arr.length > 0) setLanguageMode(arr[0] as LanguageMode);
              }}
            >
              <SelectItem key="system">{t('settings:language.system')}</SelectItem>
              <SelectItem key="zh">{t('settings:language.zh')}</SelectItem>
              <SelectItem key="en">{t('settings:language.en')}</SelectItem>
              <SelectItem key="ja">{t('settings:language.ja')}</SelectItem>
            </Select>
          )}
        />
      </SettingsSection>

      <SettingsSection title={t('settings:clientNotifications.title')}>
        <SettingsBlock>
          <ClientNotificationSettings />
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection
        title={t('settings:display.highlightSection')}
        description={t('settings:display.description')}
      >
        <SettingsRow
          label={t('settings:display.enableHighlight')}
          description={t('settings:display.enableHighlightDesc')}
          control={(
            <Switch
              size="sm"
              isSelected={settings.enabled}
              onValueChange={handleGlobalToggle}
              aria-label={t('settings:display.enableHighlight')}
            />
          )}
        />
        {orderedHighlightTypes.map((type) => renderHighlightRow(type))}
        {settings.enabled && enabledHighlightTypes.length > 0 && (
          <SettingsRow label={t('settings:display.preview')}>
            <div className="flex flex-col gap-2">
              {enabledHighlightTypes.map((type) => {
                const config = settings.highlights[type];
                return (
                  <div key={type} className="flex items-center gap-3">
                    <div className="h-5 w-1 rounded" style={{ backgroundColor: config.color }} />
                    <span className="text-sm">
                      {t('settings:highlight.exampleFT8')} - {highlightTypeLabels[type]}
                    </span>
                    <Chip
                      size="sm"
                      variant="bordered"
                      style={{ backgroundColor: `${config.color}20`, color: config.color, borderColor: config.color }}
                    >
                      {highlightTypeLabels[type]}
                    </Chip>
                  </div>
                );
              })}
            </div>
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings:display.frameTable.title')}
        description={t('settings:display.frameTable.description')}
      >
        <SettingsRow
          label={t('settings:display.frameTable.groupHeader')}
          description={t('settings:display.frameTable.groupHeaderDesc')}
          control={(
            <Switch
              size="sm"
              isSelected={settings.frameTableGroupHeaderEnabled}
              onValueChange={handleFrameTableGroupHeaderToggle}
              aria-label={t('settings:display.frameTable.groupHeader')}
            />
          )}
        />
        {renderFrameTableThemeRow('light')}
        {renderFrameTableThemeRow('dark')}
      </SettingsSection>

      <div className="flex items-center justify-between gap-4">
        <Button
          size="sm"
          variant="flat"
          startContent={<FontAwesomeIcon icon={faRotateLeft} />}
          onPress={handleReset}
          isDisabled={isDefaultSettings(settings)}
        >
          {t('settings:display.resetToDefault')}
        </Button>
        <span className="text-xs text-default-500">
          {hasUnsavedChanges() && t('settings:unsavedChanges')}
        </span>
      </div>
    </SettingsPage>
  );
});

DisplayNotificationSettings.displayName = 'DisplayNotificationSettings'; 
