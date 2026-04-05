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
import {
  type DisplayNotificationSettings as DisplaySettings,
  HighlightType,
  getHighlightTypeLabels,
  getHighlightTypeDescriptions,
  PRESET_COLORS,
  getDisplayNotificationSettings,
  saveDisplayNotificationSettings,
  resetDisplayNotificationSettings,
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

  // 重置为默认设置
  const handleReset = () => {
    const defaultSettings = resetDisplayNotificationSettings();
    setSettings(defaultSettings);
    setOriginalSettings(defaultSettings);
  };

  // 渲染颜色选择器
  const renderColorPicker = (type: HighlightType) => {
    const currentColor = settings.highlights[type].color;
    
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
            onChange={(e) => handleColorChange(type, e.target.value)}
            className="flex-1"
            placeholder="#000000"
            startContent={<FontAwesomeIcon icon={faPalette} className="text-default-400" />}
          />
          <InteractiveColorPicker
            value={currentColor}
            onChange={(color) => handleColorChange(type, color)}
          />
        </div>
        
        {/* 预设颜色 */}
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
                  onClick={() => handleColorChange(type, color)}
                />
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
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

  return (
    <div className="space-y-6">
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
          {Object.values(HighlightType).map(type => renderHighlightCard(type))}
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
              {Object.values(HighlightType).map(type => {
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