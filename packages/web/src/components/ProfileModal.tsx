import React, { useState, useEffect, useRef } from 'react';
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
import { faPlus, faTrash, faPen, faArrowLeft, faCheck } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import { api } from '@tx5dr/core';
import type { RadioProfile, HamlibConfig, AudioDeviceSettings as AudioDeviceSettingsType } from '@tx5dr/contracts';
import { useProfiles } from '../store/radioStore';
import { RadioDeviceSettings, type RadioDeviceSettingsRef } from './RadioDeviceSettings';
import { AudioDeviceSettings, type AudioDeviceSettingsRef } from './AudioDeviceSettings';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ModalMode = 'list' | 'create' | 'edit';

export function ProfileModal({ isOpen, onClose }: ProfileModalProps) {
  const { profiles, activeProfileId } = useProfiles();
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

  const radioSettingsRef = useRef<RadioDeviceSettingsRef | null>(null);
  const audioSettingsRef = useRef<AudioDeviceSettingsRef | null>(null);

  // 重置到列表模式
  useEffect(() => {
    if (isOpen) {
      setMode('list');
      setSelectedProfileId(activeProfileId);
    }
  }, [isOpen, activeProfileId]);

  // 获取电台类型显示文本
  const getRadioTypeLabel = (config: HamlibConfig) => {
    switch (config.type) {
      case 'none': return '无电台';
      case 'network': return `网络 RigCtrl | ${config.network?.host || ''}:${config.network?.port || ''}`;
      case 'serial': return `串口 | ${config.serial?.path || ''}`;
      case 'icom-wlan': return `ICOM WLAN | ${config.icomWlan?.ip || ''}`;
      default: return '未知类型';
    }
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
      addToast({ title: '请输入 Profile 名称', color: 'warning', timeout: 3000 });
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
        addToast({ title: `Profile「${result.profile?.name ?? editName.trim()}」已创建`, color: 'success', timeout: 3000 });
      } else if (mode === 'edit' && editingProfileId) {
        const result = await api.updateProfile(editingProfileId, {
          name: editName.trim(),
          radio: editRadioConfig,
          audio: editAudioConfig,
          description: editDescription.trim() || undefined,
        });
        addToast({ title: `Profile「${result.profile?.name ?? editName.trim()}」已更新`, color: 'success', timeout: 3000 });
      }
      setMode('list');
      setEditingProfileId(null);
    } catch (error) {
      addToast({
        title: mode === 'create' ? '创建失败' : '更新失败',
        description: error instanceof Error ? error.message : '请重试',
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
      addToast({ title: '无法删除当前激活的 Profile', color: 'warning', timeout: 3000 });
      return;
    }

    setIsDeleting(profileId);
    try {
      await api.deleteProfile(profileId);
      const profile = profiles.find(p => p.id === profileId);
      addToast({ title: `Profile「${profile?.name || ''}」已删除`, color: 'success', timeout: 3000 });
    } catch (error) {
      addToast({
        title: '删除失败',
        description: error instanceof Error ? error.message : '请重试',
        color: 'danger',
        timeout: 5000
      });
    } finally {
      setIsDeleting(null);
    }
  };

  // 应用选中的 Profile
  const handleApply = async () => {
    if (!selectedProfileId || selectedProfileId === activeProfileId) {
      onClose();
      return;
    }

    setIsActivating(true);
    try {
      const result = await api.activateProfile(selectedProfileId);
      const profileName = result.profile?.name || '';
      addToast({
        title: `已切换到「${profileName}」`,
        description: result.wasRunning ? '引擎已停止，请点击「启动」重新开始' : undefined,
        color: 'success',
        timeout: 4000
      });
      onClose();
    } catch (error) {
      addToast({
        title: 'Profile 切换失败',
        description: error instanceof Error ? error.message : '请重试',
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
              <p className="text-default-500 mb-4">还没有 Profile，请创建一个</p>
              <Button color="primary" onPress={handleStartCreate} startContent={<FontAwesomeIcon icon={faPlus} />}>
                新建 Profile
              </Button>
            </div>
          ) : (
            <>
              {profiles.map(profile => (
                <Card
                  key={profile.id}
                  isPressable
                  onPress={() => setSelectedProfileId(profile.id)}
                  shadow="none"
                  radius="lg"
                  classNames={{
                    base: `border ${selectedProfileId === profile.id ? 'border-primary bg-primary-50/50' : 'border-divider bg-content1'} transition-colors`
                  }}
                >
                  <CardBody className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
                          profile.id === activeProfileId ? 'bg-success' : 'bg-default-300'
                        }`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-default-900 truncate">{profile.name}</span>
                            {profile.id === activeProfileId && (
                              <Chip size="sm" color="success" variant="flat">当前</Chip>
                            )}
                          </div>
                          <p className="text-xs text-default-500 truncate mt-0.5">
                            {getRadioTypeLabel(profile.radio)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="light"
                          isIconOnly
                          onPress={() => handleStartEdit(profile)}
                          title="编辑"
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
                          title={profile.id === activeProfileId ? '无法删除当前激活的 Profile' : '删除'}
                        >
                          <FontAwesomeIcon icon={faTrash} className="text-xs" />
                        </Button>
                      </div>
                    </div>
                  </CardBody>
                </Card>
              ))}

              <Button
                fullWidth
                variant="flat"
                onPress={handleStartCreate}
                startContent={<FontAwesomeIcon icon={faPlus} />}
                className="mt-2"
              >
                新建 Profile
              </Button>
            </>
          )}
        </div>
      </ModalBody>

      <ModalFooter>
        <div className="flex justify-between items-center w-full">
          <div className="text-sm text-default-400">
            {selectedProfileId && selectedProfileId !== activeProfileId && '点击「应用」切换 Profile'}
          </div>
          <div className="flex gap-2">
            <Button variant="flat" onPress={onClose}>关闭</Button>
            <Button
              color="primary"
              onPress={handleApply}
              isLoading={isActivating}
              isDisabled={!selectedProfileId || selectedProfileId === activeProfileId}
              startContent={!isActivating ? <FontAwesomeIcon icon={faCheck} /> : undefined}
            >
              应用
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
              label="Profile 名称"
              placeholder="例如：IC-705 WiFi、FT-991A 串口"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              isRequired
            />
            <Textarea
              label="描述（可选）"
              placeholder="备注信息"
              value={editDescription}
              onChange={e => setEditDescription(e.target.value)}
              minRows={1}
              maxRows={3}
            />
          </div>

          <Divider />

          {/* 电台设置 */}
          <div>
            <h4 className="font-semibold text-default-900 mb-3">电台设置</h4>
            <RadioDeviceSettings
              ref={radioSettingsRef}
              initialConfig={editRadioConfig}
              onChange={setEditRadioConfig}
            />
          </div>

          <Divider />

          {/* 音频设置 */}
          <div>
            <h4 className="font-semibold text-default-900 mb-3">音频设置</h4>
            {isIcomWlan ? (
              <Card shadow="none" radius="lg" classNames={{ base: 'border border-divider bg-content1' }}>
                <CardBody className="p-4">
                  <div className="flex items-center gap-2 text-primary">
                    <Chip size="sm" color="primary" variant="flat">自动</Chip>
                    <span className="text-sm">ICOM WLAN 模式下音频由电台直接提供，无需手动配置</span>
                  </div>
                </CardBody>
              </Card>
            ) : (
              <AudioDeviceSettings
                ref={audioSettingsRef}
                initialConfig={editAudioConfig}
                onChange={setEditAudioConfig}
              />
            )}
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
            返回列表
          </Button>
          <div className="flex gap-2">
            <Button variant="flat" onPress={handleBackToList}>取消</Button>
            <Button
              color="primary"
              onPress={handleSave}
              isLoading={isSaving}
              isDisabled={!editName.trim()}
            >
              {mode === 'create' ? '创建 Profile' : '保存 Profile'}
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
      backdrop="blur"
      classNames={{
        body: "px-4 sm:px-6",
        header: "border-b border-divider px-4 sm:px-6 py-3 sm:py-4",
        footer: "border-t border-divider px-4 sm:px-6 py-3 sm:py-4",
      }}
    >
      <ModalContent>
        <ModalHeader>
          <div>
            <h2 className="text-xl font-bold">
              {mode === 'list' ? '电台配置 Profile' : mode === 'create' ? '新建 Profile' : '编辑 Profile'}
            </h2>
            <p className="text-sm text-default-500 font-normal mt-1">
              {mode === 'list'
                ? '管理电台和音频配置组合，快速切换不同的工作场景'
                : mode === 'create'
                  ? '创建新的电台配置组合'
                  : `编辑「${editName}」`
              }
            </p>
          </div>
        </ModalHeader>

        {mode === 'list' ? renderListMode() : renderEditMode()}
      </ModalContent>
    </Modal>
  );
}
