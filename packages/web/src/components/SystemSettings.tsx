import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  Card,
  CardBody,
  Switch,
} from '@heroui/react';

export interface SystemSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface SystemSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const SystemSettings = forwardRef<
  SystemSettingsRef,
  SystemSettingsProps
>(({ onUnsavedChanges }, ref) => {
  const [decodeWhileTransmitting, setDecodeWhileTransmitting] = useState(false);
  const [originalDecodeValue, setOriginalDecodeValue] = useState(false);
  const [spectrumWhileTransmitting, setSpectrumWhileTransmitting] = useState(true);
  const [originalSpectrumValue, setOriginalSpectrumValue] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>('');

  // 加载配置
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const response = await fetch('/api/settings/ft8');
      if (!response.ok) {
        throw new Error('加载配置失败');
      }
      const result = await response.json();
      const decodeValue = result.data?.decodeWhileTransmitting ?? false;
      const spectrumValue = result.data?.spectrumWhileTransmitting ?? true;

      setDecodeWhileTransmitting(decodeValue);
      setOriginalDecodeValue(decodeValue);
      setSpectrumWhileTransmitting(spectrumValue);
      setOriginalSpectrumValue(spectrumValue);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载配置失败');
      console.error('加载FT8配置失败:', err);
    }
  };

  // 检查是否有未保存的更改
  const hasUnsavedChanges = () => {
    return (
      decodeWhileTransmitting !== originalDecodeValue ||
      spectrumWhileTransmitting !== originalSpectrumValue
    );
  };

  // 保存配置
  const handleSave = async () => {
    setIsSaving(true);
    setError('');
    try {
      const response = await fetch('/api/settings/ft8', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decodeWhileTransmitting,
          spectrumWhileTransmitting,
        }),
      });

      if (!response.ok) {
        throw new Error('保存配置失败');
      }

      const result = await response.json();
      if (result.success) {
        setOriginalDecodeValue(decodeWhileTransmitting);
        setOriginalSpectrumValue(spectrumWhileTransmitting);
        onUnsavedChanges?.(false);
      } else {
        throw new Error(result.message || '保存配置失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存配置失败');
      throw err;
    } finally {
      setIsSaving(false);
    }
  };

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    save: handleSave,
  }));

  // 监听设置变化
  useEffect(() => {
    const hasChanges = hasUnsavedChanges();
    onUnsavedChanges?.(hasChanges);
  }, [decodeWhileTransmitting, spectrumWhileTransmitting, originalDecodeValue, originalSpectrumValue, onUnsavedChanges]);

  return (
    <div className="space-y-6">
      {/* 页面标题和描述 */}
      <div>
        <h3 className="text-xl font-bold text-default-900 mb-2">系统设置</h3>
        <p className="text-default-600">
          配置系统级别的功能选项。
        </p>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg">
          <p className="text-danger-700 text-sm">{error}</p>
        </div>
      )}

      {/* 发射时解码设置 */}
      <Card shadow="none" radius="lg" classNames={{
        base: "border border-divider bg-content1"
      }}>
        <CardBody className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h4 className="font-semibold text-default-900 mb-1">发射时允许解码</h4>
              <div className="text-sm text-default-600 space-y-1">
                <p>
                  <strong>关闭（推荐）</strong>：任何操作员发射时停止解码，避免误解码残留信号
                </p>
                <p>
                  <strong>开启（高级）</strong>：发射周期继续解码，支持双周期异地收发
                </p>
              </div>
            </div>
            <Switch
              isSelected={decodeWhileTransmitting}
              onValueChange={setDecodeWhileTransmitting}
              isDisabled={isSaving}
              size="lg"
              color={decodeWhileTransmitting ? 'warning' : 'success'}
            />
          </div>
        </CardBody>
      </Card>

      {/* 发射时频谱分析设置 */}
      <Card shadow="none" radius="lg" classNames={{
        base: "border border-divider bg-content1"
      }}>
        <CardBody className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h4 className="font-semibold text-default-900 mb-1">发射时允许频谱分析</h4>
              <div className="text-sm text-default-600 space-y-1">
                <p>
                  <strong>开启（推荐）</strong>：发射时继续显示频谱图，实时监控发射信号
                </p>
                <p>
                  <strong>关闭</strong>：发射时暂停频谱分析，降低CPU占用
                </p>
              </div>
            </div>
            <Switch
              isSelected={spectrumWhileTransmitting}
              onValueChange={setSpectrumWhileTransmitting}
              isDisabled={isSaving}
              size="lg"
              color={spectrumWhileTransmitting ? 'success' : 'warning'}
            />
          </div>
        </CardBody>
      </Card>

      {/* 提示信息 */}
      {hasUnsavedChanges() && (
        <div className="text-sm text-default-500">
          ● 设置已修改，请保存更改
        </div>
      )}
    </div>
  );
});

SystemSettings.displayName = 'SystemSettings';
