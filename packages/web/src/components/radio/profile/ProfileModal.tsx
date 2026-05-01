import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Card,
  CardBody,
  Divider,
  Chip,
  Textarea
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faTrash, faPen, faArrowLeft, faCheck, faGripVertical } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import { Reorder } from 'framer-motion';
import { api } from '@tx5dr/core';
import type { RadioProfile, HamlibConfig, AudioDeviceSettings as AudioDeviceSettingsType } from '@tx5dr/contracts';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { useProfiles, useRadioConnectionState } from '../../../store/radioStore';
import { RadioDeviceSettings, type RadioDeviceSettingsRef } from './RadioDeviceSettings';
import { AudioDeviceSettings, type AudioDeviceSettingsRef } from './AudioDeviceSettings';
import { PowerControlButton } from './PowerControlButton';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ModalMode = 'list' | 'create' | 'edit';

export function ProfileModal({ isOpen, onClose }: ProfileModalProps) {
  const { t } = useTranslation('radio');
  const { profiles, activeProfileId } = useProfiles();
  const radioConnection = useRadioConnectionState();
  const [mode, setMode] = useState<ModalMode>('list');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [isActivating, setIsActivating] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);

  // 编辑模式状态
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRadioConfig, setEditRadioConfig] = useState<HamlibConfig>({ type: 'none' });
  const [editAudioConfig, setEditAudioConfig] = useState<AudioDeviceSettingsType>({});
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // 本地排序状态（用于即时 UI 反馈）
  const [localProfiles, setLocalProfiles] = useState<RadioProfile[]>(profiles);
  const reorderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const radioSettingsRef = useRef<RadioDeviceSettingsRef | null>(null);
  const audioSettingsRef = useRef<AudioDeviceSettingsRef | null>(null);

  // 同步 profiles 到本地状态
  useEffect(() => {
    setLocalProfiles(profiles);
  }, [profiles]);

  // 重置到列表模式
  useEffect(() => {
    if (isOpen) {
      setMode('list');
      setSelectedProfileId(activeProfileId);
    }
  }, [isOpen, activeProfileId]);

  // 拖拽排序处理：即时更新 UI，debounce 保存到后端
  const handleReorder = useCallback((newOrder: RadioProfile[]) => {
    setLocalProfiles(newOrder);

    if (reorderTimeoutRef.current) {
      clearTimeout(reorderTimeoutRef.current);
    }

    reorderTimeoutRef.current = setTimeout(async () => {
      try {
        await api.reorderProfiles(newOrder.map(p => p.id));
      } catch (error) {
        addToast({
          title: t('profileModal.reorderFailed'),
          description: error instanceof Error ? error.message : t('profileModal.retry'),
          color: 'danger',
          timeout: 3000,
        });
      }
    }, 500);
  }, []);

  // 清理 timeout
  useEffect(() => {
    return () => {
      if (reorderTimeoutRef.current) {
        clearTimeout(reorderTimeoutRef.current);
      }
    };
  }, []);

  // 获取电台类型显示文本
  const getRadioTypeLabel = (config: HamlibConfig) => {
    switch (config.type) {
      case 'none': return t('connection.none');
      case 'network': return `${t('profileModal.network')} | ${config.network?.host || ''}:${config.network?.port || ''}`;
      case 'serial': return `${t('profileModal.serial')} | ${config.serial?.path || ''}`;
      case 'icom-wlan': return `ICOM WLAN | ${config.icomWlan?.ip || ''}`;
      default: return t('profileModal.unknownType');
    }
  };

  // 获取指示器颜色：绿色=激活已连接，蓝色=激活未连接，灰色=非激活
  const getIndicatorColor = (profileId: string) => {
    if (profileId !== activeProfileId) return 'bg-default-200';
    if (radioConnection.radioConnectionStatus === RadioConnectionStatus.CONNECTED) return 'bg-success';
    return 'bg-primary';
  };

  // 进入创建模式
  const handleStartCreate = () => {
    setEditName('');
    setEditDescription('');
    setEditRadioConfig({ type: 'none' });
    setEditAudioConfig({});
    setEditingProfileId(null);
    setMode('create');
  };

  // 进入编辑模式
  const handleStartEdit = (profile: RadioProfile) => {
    setEditName(profile.name);
    setEditDescription(profile.description || '');
    setEditRadioConfig(profile.radio);
    setEditAudioConfig(profile.audio);
    setEditingProfileId(profile.id);
    setMode('edit');
  };

  // 返回列表
  const handleBackToList = () => {
    setMode('list');
    setEditingProfileId(null);
  };

  // 保存 Profile（创建或更新）
  const handleSave = async () => {
    if (!editName.trim()) {
      addToast({ title: t('profileModal.nameRequired'), color: 'warning', timeout: 3000 });
      return;
    }

    setIsSaving(true);
    try {
      if (mode === 'create') {
        const result = await api.createProfile({
          name: editName.trim(),
          radio: editRadioConfig,
          audio: editAudioConfig,
          description: editDescription.trim() || undefined,
        });
        addToast({ title: t('profileModal.created', { name: result.profile?.name ?? editName.trim() }), color: 'success', timeout: 3000 });
      } else if (mode === 'edit' && editingProfileId) {
        const result = await api.updateProfile(editingProfileId, {
          name: editName.trim(),
          radio: editRadioConfig,
          audio: editAudioConfig,
          description: editDescription.trim() || undefined,
        });
        addToast({ title: t('profileModal.updated', { name: result.profile?.name ?? editName.trim() }), color: 'success', timeout: 3000 });
      }
      setMode('list');
      setEditingProfileId(null);
    } catch (error) {
      addToast({
        title: mode === 'create' ? t('settings.createFailed') : t('profileModal.updateFailed'),
        description: error instanceof Error ? error.message : t('profileModal.retry'),
        color: 'danger',
        timeout: 5000
      });
    } finally {
      setIsSaving(false);
    }
  };

  // 删除 Profile
  const handleDelete = async (profileId: string) => {
    if (profileId === activeProfileId) {
      addToast({ title: t('profileModal.cannotDeleteActive'), color: 'warning', timeout: 3000 });
      return;
    }

    setIsDeleting(profileId);
    try {
      await api.deleteProfile(profileId);
      const profile = profiles.find(p => p.id === profileId);
      addToast({ title: t('profileModal.deleted', { name: profile?.name || '' }), color: 'success', timeout: 3000 });
    } catch (error) {
      addToast({
        title: t('settings.deleteFailed'),
        description: error instanceof Error ? error.message : t('profileModal.retry'),
        color: 'danger',
        timeout: 5000
      });
    } finally {
      setIsDeleting(null);
    }
  };

  // 应用选中的 Profile（始终可用，后端会自动启动引擎并连接）
  const handleApply = async () => {
    if (!selectedProfileId) return;

    setIsActivating(true);
    try {
      const result = await api.activateProfile(selectedProfileId);
      const profileName = result.profile?.name || '';
      const isSameProfile = selectedProfileId === activeProfileId;
      addToast({
        title: isSameProfile ? t('profile.reconnecting', { name: profileName }) : t('profile.switched', { name: profileName }),
        color: 'success',
        timeout: 3000
      });
      onClose();
    } catch (error) {
      addToast({
        title: selectedProfileId !== activeProfileId ? t('profile.switchFailed', { name: '' }) : t('connection.failed'),
        description: error instanceof Error ? error.message : t('error.unknown'),
        color: 'danger',
        timeout: 5000
      });
    } finally {
      setIsActivating(false);
    }
  };

  // ICOM WLAN 检测：音频锁定提示
  const isIcomWlan = editRadioConfig.type === 'icom-wlan';

  // 渲染列表模式
  const renderListMode = () => (
    <>
      <ModalBody>
        <div className="space-y-3">
          {profiles.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-default-500 mb-4">{t('profileModal.noProfiles')}</p>
              <Button color="primary" onPress={handleStartCreate} startContent={<FontAwesomeIcon icon={faPlus} />}>
                {t('profileModal.newProfile')}
              </Button>
            </div>
          ) : (
            <>
              <Reorder.Group axis="y" values={localProfiles} onReorder={handleReorder} className="space-y-2" as="div">
                {localProfiles.map(profile => (
                  <Reorder.Item key={profile.id} value={profile} as="div" className="w-full">
                    <Card
                      isPressable
                      onPress={() => setSelectedProfileId(profile.id)}
                      shadow="none"
                      radius="lg"
                      classNames={{
                        base: `border overflow-hidden w-full ${selectedProfileId === profile.id ? 'border-primary bg-primary-50/50' : 'border-divider bg-content1'} transition-colors`
                      }}
                    >
                      <div className="flex">
                        <div className={`w-1 flex-shrink-0 ${getIndicatorColor(profile.id)}`} />
                        <div className="flex items-center pl-2 cursor-grab active:cursor-grabbing text-default-300 hover:text-default-500 transition-colors">
                          <FontAwesomeIcon icon={faGripVertical} className="text-xs" />
                        </div>
                        <CardBody className="p-3 flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-default-900 truncate">{profile.name}</span>
                                {profile.id === activeProfileId && (
                                  <Chip size="sm" color="success" variant="flat">{t('profileModal.current')}</Chip>
                                )}
                              </div>
                              <p className="text-xs text-default-500 truncate mt-0.5">
                                {getRadioTypeLabel(profile.radio)}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <PowerControlButton profileId={profile.id} compact onPowerOnSuccess={onClose} />
                              <Button
                                size="sm"
                                variant="light"
                                isIconOnly
                                onPress={() => handleStartEdit(profile)}
                                title={t('profileModal.edit')}
                              >
                                <FontAwesomeIcon icon={faPen} className="text-default-400 text-xs" />
                              </Button>
                              <Button
                                size="sm"
                                variant="light"
                                isIconOnly
                                color="danger"
                                isDisabled={profile.id === activeProfileId}
                                isLoading={isDeleting === profile.id}
                                onPress={() => handleDelete(profile.id)}
                                title={profile.id === activeProfileId ? t('profileModal.cannotDeleteActive') : t('common:button.delete')}
                              >
                                <FontAwesomeIcon icon={faTrash} className="text-xs" />
                              </Button>
                            </div>
                          </div>
                        </CardBody>
                      </div>
                    </Card>
                  </Reorder.Item>
                ))}
              </Reorder.Group>

              <Button
                fullWidth
                variant="flat"
                onPress={handleStartCreate}
                startContent={<FontAwesomeIcon icon={faPlus} />}
                className="mt-2"
              >
                {t('profileModal.createNew')}
              </Button>
            </>
          )}
        </div>
      </ModalBody>

      <ModalFooter>
        <div className="flex justify-between items-center w-full">
          <div className="text-sm text-default-400">
            {selectedProfileId && selectedProfileId !== activeProfileId && t('profileModal.switchAndConnect')}
            {selectedProfileId && selectedProfileId === activeProfileId && t('profileModal.reconnect')}
          </div>
          <div className="flex gap-2">
            <Button variant="flat" onPress={onClose}>{t('common:button.close')}</Button>
            <Button
              color="primary"
              onPress={handleApply}
              isLoading={isActivating}
              isDisabled={!selectedProfileId}
              startContent={!isActivating ? <FontAwesomeIcon icon={faCheck} /> : undefined}
            >
              {selectedProfileId && selectedProfileId === activeProfileId ? t('profileModal.reconnect') : t('profileModal.apply')}
            </Button>
          </div>
        </div>
      </ModalFooter>
    </>
  );

  // 渲染编辑/创建模式
  const renderEditMode = () => (
    <>
      <ModalBody>
        <div className="space-y-6 pb-4">
          {/* Profile 基本信息 */}
          <div className="space-y-3">
            <Input
              label={t('profileModal.nameLabel')}
              placeholder={t('profileModal.namePlaceholder')}
              value={editName}
              onChange={e => setEditName(e.target.value)}
              isRequired
            />
            <Textarea
              label={t('profileModal.descLabel')}
              placeholder={t('profileModal.descPlaceholder')}
              value={editDescription}
              onChange={e => setEditDescription(e.target.value)}
              minRows={1}
              maxRows={3}
            />
          </div>

          <Divider />

          {/* 电台设置 */}
          <RadioDeviceSettings
            ref={radioSettingsRef}
            initialConfig={editRadioConfig}
            onChange={setEditRadioConfig}
          />

          {/* 电源控制（仅编辑现有 Profile 时显示） */}
          {mode === 'edit' && editingProfileId && (
            <PowerControlButton profileId={editingProfileId} onPowerOnSuccess={onClose} />
          )}

          <Divider />

          {/* 音频设置 */}
          <div>
            {isIcomWlan && (
              <Card shadow="none" radius="lg" classNames={{ base: 'border border-divider bg-content1 mb-3' }}>
                <CardBody className="p-3">
                  <div className="flex items-center gap-2 text-primary">
                    <Chip size="sm" color="primary" variant="flat">{t('profileModal.icomDefault')}</Chip>
                    <span className="text-sm">{t('profileModal.icomDefaultDesc')}</span>
                  </div>
                </CardBody>
              </Card>
            )}
            <AudioDeviceSettings
              ref={audioSettingsRef}
              initialConfig={editAudioConfig}
              onChange={setEditAudioConfig}
              radioType={editRadioConfig.type}
            />
          </div>
        </div>
      </ModalBody>

      <ModalFooter>
        <div className="flex justify-between items-center w-full">
          <Button
            variant="light"
            onPress={handleBackToList}
            startContent={<FontAwesomeIcon icon={faArrowLeft} />}
          >
            {t('profileModal.backToList')}
          </Button>
          <div className="flex gap-2">
            <Button variant="flat" onPress={handleBackToList}>{t('common:button.cancel')}</Button>
            <Button
              color="primary"
              onPress={handleSave}
              isLoading={isSaving}
              isDisabled={!editName.trim()}
            >
              {mode === 'create' ? t('profileModal.create') : t('profileModal.save')}
            </Button>
          </div>
        </div>
      </ModalFooter>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={mode === 'list' ? onClose : handleBackToList}
      size="4xl"
      scrollBehavior="inside"
      placement="center"
      backdrop="opaque"
      disableAnimation
      classNames={{
        body: "px-4 sm:px-6 py-4 sm:py-5",
        header: "border-b border-divider px-4 sm:px-6 py-3 sm:py-4",
        footer: "border-t border-divider px-4 sm:px-6 py-3 sm:py-4",
      }}
    >
      <ModalContent>
        <ModalHeader>
          <div>
            <h2 className="text-xl font-bold">
              {mode === 'list' ? t('profileModal.titleList') : mode === 'create' ? t('profileModal.titleCreate') : t('profileModal.titleEdit')}
            </h2>
            <p className="text-sm text-default-500 font-normal mt-1">
              {mode === 'list'
                ? t('profileModal.subtitleList')
                : mode === 'create'
                  ? t('profileModal.subtitleCreate')
                  : t('profileModal.subtitleEdit', { name: editName })
              }
            </p>
          </div>
        </ModalHeader>

        {mode === 'list' ? renderListMode() : renderEditMode()}
      </ModalContent>
    </Modal>
  );
}
