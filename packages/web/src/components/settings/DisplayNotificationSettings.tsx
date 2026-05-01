import React, { useState, useEffect, forwardRef, useImperativeHandle, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardBody,
  Switch,
  Button,
  Divider,
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
import { QSONotificationSettingsCard } from './QSONotificationSettingsCard';
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
      <div className="space-y-3">
        {/* 当前颜色显示和交互式选择器 */}
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-md border-2 border-default-200 shadow-sm"
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
          <div>
            <p className="text-sm text-default-600 mb-2">{t('settings:display.presetColors')}</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((color) => (
                <Tooltip key={color} content={color}>
                  <button
                    className={`w-6 h-6 rounded border-2 hover:scale-110 transition-transform ${
                      currentColor === color ? 'border-default-400' : 'border-default-200'
                    }`}
                    style={{ backgroundColor: color }}
                    onClick={() => onColorChange(color)}
                  />
                </Tooltip>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // 渲染颜色选择器
  const renderColorPicker = (type: HighlightType) => {
    const currentColor = settings.highlights[type].color;

    return renderColorPickerControls(currentColor, (color) => handleColorChange(type, color));
  };

  const renderFrameTableCycleColorPicker = (
    theme: keyof FrameTableCycleBackgrounds,
    cycle: keyof FrameTableCycleBackgrounds['light'],
  ) => {
    const currentColor = settings.frameTableCycleBackgrounds[theme][cycle];

    return renderColorPickerControls(
      currentColor,
      (color) => handleFrameTableCycleBackgroundChange(theme, cycle, color),
      { showPresets: false },
    );
  };

  // 渲染高亮设置卡片
  const renderHighlightCard = (type: HighlightType) => {
    const config = settings.highlights[type];
    const isEnabled = settings.enabled && config.enabled;
    
    return (
      <Card key={type} className="mb-4" shadow="none" radius="lg" classNames={{
        base: "border border-divider bg-content1"
      }}>
        <CardBody className="space-y-4 p-4">
          {/* 标题和开关 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-4 h-4 rounded"
                style={{ 
                  backgroundColor: isEnabled ? config.color : '#d4d4d8',
                  opacity: isEnabled ? 1 : 0.5 
                }}
              />
              <div>
                <h4 className="font-semibold text-default-900">
                  {highlightTypeLabels[type]}
                </h4>
                <p className="text-sm text-default-600">
                  {highlightTypeDescriptions[type]}
                </p>
              </div>
            </div>
            <Switch
              isSelected={config.enabled}
              onValueChange={(enabled) => handleHighlightToggle(type, enabled)}
              isDisabled={!settings.enabled}
            />
          </div>
          
          {/* 颜色选择器 */}
          {config.enabled && settings.enabled && (
            <>
              <Divider />
              {renderColorPicker(type)}
            </>
          )}
        </CardBody>
      </Card>
    );
  };

  const renderFrameTablePreview = (theme: keyof FrameTableCycleBackgrounds) => {
    const colors = settings.frameTableCycleBackgrounds[theme];
    const previewRows = [
      {
        cycle: 'even' as const,
        time: '00:00',
        message: 'CQ TEST PM95',
        color: colors.even,
      },
      {
        cycle: 'odd' as const,
        time: '00:15',
        message: 'TEST K1ABC -10',
        color: colors.odd,
      },
    ];

    return (
      <div
        className={`rounded-lg border p-3 ${theme === 'dark' ? 'border-zinc-700 bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'}`}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">
            {theme === 'light' ? t('settings:display.frameTable.lightTheme') : t('settings:display.frameTable.darkTheme')}
          </span>
          <span className={theme === 'dark' ? 'text-xs text-zinc-400' : 'text-xs text-zinc-500'}>
            {t('settings:display.frameTable.preview')}
          </span>
        </div>
        <div className="space-y-2">
          {previewRows.map((row) => (
            <div
              key={row.cycle}
              className="grid grid-cols-[56px_44px_1fr] items-center gap-2 rounded-md px-3 py-2 font-mono text-xs"
              style={{ backgroundColor: row.color }}
            >
              <span>{row.time}</span>
              <span className="text-right">{row.cycle === 'even' ? '0' : '1'}</span>
              <span>{row.message}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderFrameTableCycleBackgroundCard = (
    theme: keyof FrameTableCycleBackgrounds,
  ) => (
    <Card shadow="none" radius="lg" classNames={{ base: "border border-divider bg-content1" }}>
      <CardBody className="space-y-4 p-4">
        <div>
          <h5 className="font-semibold text-default-900">
            {theme === 'light' ? t('settings:display.frameTable.lightTheme') : t('settings:display.frameTable.darkTheme')}
          </h5>
          <p className="text-sm text-default-600">
            {t('settings:display.frameTable.themeDescription')}
          </p>
        </div>
        {renderFrameTablePreview(theme)}
        <Divider />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <h6 className="text-sm font-medium text-default-800">
              {t('settings:display.frameTable.evenCycle')}
            </h6>
            {renderFrameTableCycleColorPicker(theme, 'even')}
          </div>
          <div className="space-y-3">
            <h6 className="text-sm font-medium text-default-800">
              {t('settings:display.frameTable.oddCycle')}
            </h6>
            {renderFrameTableCycleColorPicker(theme, 'odd')}
          </div>
        </div>
      </CardBody>
    </Card>
  );

  return (
    <div className="space-y-6">
      <QSONotificationSettingsCard />

      {/* 语言设置 */}
      <Card shadow="none" radius="lg" classNames={{ base: "border border-divider bg-content1" }}>
        <CardBody className="p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h4 className="font-semibold text-default-900">{t('settings:language.label')}</h4>
            </div>
            <Select
              size="sm"
              className="max-w-[160px]"
              selectedKeys={new Set([languageMode])}
              onSelectionChange={(keys) => {
                const arr = Array.from(keys);
                if (arr.length > 0) setLanguageMode(arr[0] as LanguageMode);
              }}
            >
              <SelectItem key="system">{t('settings:language.system')}</SelectItem>
              <SelectItem key="zh">{t('settings:language.zh')}</SelectItem>
              <SelectItem key="en">{t('settings:language.en')}</SelectItem>
            </Select>
          </div>
        </CardBody>
      </Card>

      {/* 页面标题和描述 */}
      <div>
        <h3 className="text-xl font-bold text-default-900 mb-2">{t('settings:display.title')}</h3>
        <p className="text-default-600">
          {t('settings:display.description')}
        </p>
      </div>

      {/* 全局开关 */}
      <Card shadow="none" radius="lg" classNames={{
        base: "border border-divider bg-content1"
      }}>
        <CardBody className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-semibold text-default-900">{t('settings:display.enableHighlight')}</h4>
              <p className="text-sm text-default-600">
                {t('settings:display.enableHighlightDesc')}
              </p>
            </div>
            <Switch
              isSelected={settings.enabled}
              onValueChange={handleGlobalToggle}
              size="lg"
            />
          </div>
        </CardBody>
      </Card>

      {/* 高亮类型设置 */}
      <div>
        <h4 className="font-semibold text-default-900 mb-4">{t('settings:display.highlightTypeConfig')}</h4>
        <div className="space-y-4">
          {orderedHighlightTypes.map(type => renderHighlightCard(type))}
        </div>
      </div>

      {/* FrameTable 周期背景色设置 */}
      <div>
        <h4 className="font-semibold text-default-900 mb-2">{t('settings:display.frameTable.title')}</h4>
        <p className="text-sm text-default-600 mb-4">
          {t('settings:display.frameTable.description')}
        </p>
        <div className="space-y-4">
          <Card shadow="none" radius="lg" classNames={{ base: "border border-divider bg-content1" }}>
            <CardBody className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h5 className="font-semibold text-default-900">
                    {t('settings:display.frameTable.groupHeader')}
                  </h5>
                  <p className="text-sm text-default-600">
                    {t('settings:display.frameTable.groupHeaderDesc')}
                  </p>
                </div>
                <Switch
                  isSelected={settings.frameTableGroupHeaderEnabled}
                  onValueChange={handleFrameTableGroupHeaderToggle}
                />
              </div>
            </CardBody>
          </Card>
          {renderFrameTableCycleBackgroundCard('light')}
          {renderFrameTableCycleBackgroundCard('dark')}
        </div>
      </div>

      {/* 预览区域 */}
      {settings.enabled && (
        <Card shadow="none" radius="lg" classNames={{
          base: "border border-divider bg-content1"
        }}>
          <CardBody className="p-4">
            <h4 className="font-semibold text-default-900 mb-4">{t('settings:display.preview')}</h4>
            <div className="space-y-2">
              {orderedHighlightTypes.map(type => {
                const config = settings.highlights[type];
                if (!config.enabled) return null;
                
                return (
                  <div key={type} className="flex items-center gap-3">
                    <div
                      className="w-1 h-6 rounded"
                      style={{ backgroundColor: config.color }}
                    />
                    <span className="text-sm">
                      {t('settings:highlight.exampleFT8')} - {highlightTypeLabels[type]}
                    </span>
                    <Chip
                      size="sm"
                      style={{ 
                        backgroundColor: `${config.color}20`,
                        color: config.color,
                        borderColor: config.color 
                      }}
                      variant="bordered"
                    >
                      {highlightTypeLabels[type]}
                    </Chip>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {/* 操作按钮 */}
      <div className="flex justify-between items-center pt-4">
        <Button
          variant="flat"
          startContent={<FontAwesomeIcon icon={faRotateLeft} />}
          onPress={handleReset}
          isDisabled={isDefaultSettings(settings)}
        >
          {t('settings:display.resetToDefault')}
        </Button>
        
        <div className="text-sm text-default-500">
          {hasUnsavedChanges() && t('settings:unsavedChanges')}
        </div>
      </div>
    </div>
  );
});

DisplayNotificationSettings.displayName = 'DisplayNotificationSettings'; 
