import React, { useState, useRef, useMemo } from 'react';
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
  Progress
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRight, faArrowLeft, faCheck, faWifi, faPlug, faBan, faSatelliteDish } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import { api } from '@tx5dr/core';
import type { HamlibConfig, AudioDeviceSettings as AudioDeviceSettingsType } from '@tx5dr/contracts';
import { RadioDeviceSettings, type RadioDeviceSettingsRef } from './RadioDeviceSettings';
import { AudioDeviceSettings, type AudioDeviceSettingsRef } from './AudioDeviceSettings';

interface ProfileSetupOverlayProps {
  isOpen: boolean;
}

type RadioType = 'none' | 'network' | 'serial' | 'icom-wlan';

export function ProfileSetupOverlay({ isOpen }: ProfileSetupOverlayProps) {
  const { t } = useTranslation();
  const RADIO_TYPE_OPTIONS = useMemo(() => [
    { type: 'none' as RadioType, icon: faBan, title: t('settings:radioType.none'), description: t('settings:radioType.noneDesc') },
    { type: 'serial' as RadioType, icon: faPlug, title: t('settings:radioType.serial'), description: t('settings:radioType.serialDesc') },
    { type: 'network' as RadioType, icon: faSatelliteDish, title: t('settings:radioType.network'), description: t('settings:radioType.networkDesc') },
    { type: 'icom-wlan' as RadioType, icon: faWifi, title: t('settings:radioType.icomWlan'), description: t('settings:radioType.icomWlanDesc') },
  ], [t]);
  const [step, setStep] = useState(0); // 0=选类型, 1=填配置, 2=选音频, 3=命名
  const [selectedType, setSelectedType] = useState<RadioType | null>(null);
  const [radioConfig, setRadioConfig] = useState<HamlibConfig>({ type: 'none' });
  const [audioConfig, setAudioConfig] = useState<AudioDeviceSettingsType>({});
  const [profileName, setProfileName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const radioSettingsRef = useRef<RadioDeviceSettingsRef | null>(null);
  const audioSettingsRef = useRef<AudioDeviceSettingsRef | null>(null);

  const totalSteps = 4;
  const progressValue = ((step + 1) / totalSteps) * 100;

  // 步骤1：选择类型后
  const handleSelectType = (type: RadioType) => {
    setSelectedType(type);
    setRadioConfig({ type } as HamlibConfig);
    // ICOM WLAN 默认使用电台音频设备
    if (type === 'icom-wlan') {
      setAudioConfig({ inputDeviceName: 'ICOM WLAN', outputDeviceName: 'ICOM WLAN' });
    } else {
      setAudioConfig({});
    }
    if (type === 'none') {
      // 无电台模式直接跳到音频
      setStep(2);
    } else {
      setStep(1);
    }
  };

  // 下一步
  const handleNext = () => {
    if (step === 1) {
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    }
  };

  // 上一步
  const handleBack = () => {
    if (step === 3) {
      setStep(2);
    } else if (step === 2) {
      if (selectedType === 'none') {
        setStep(0);
      } else {
        setStep(1);
      }
    } else if (step === 1) {
      setStep(0);
    }
  };

  // 完成创建
  const handleFinish = async () => {
    const name = profileName.trim() || getDefaultName();
    setIsCreating(true);
    try {
      const result = await api.createProfile({
        name,
        radio: radioConfig,
        audio: audioConfig,
      });
      // 创建后立即激活
      if (!result.profile) throw new Error('Profile creation returned no data');
      await api.activateProfile(result.profile.id);
      addToast({
        title: t('settings:profileSetup.created', { name }),
        description: t('settings:profileSetup.readyToUse'),
        color: 'success',
        timeout: 4000
      });
    } catch (error) {
      addToast({
        title: t('settings:profileSetup.createFailed'),
        description: error instanceof Error ? error.message : t('common:action.retry'),
        color: 'danger',
        timeout: 5000
      });
    } finally {
      setIsCreating(false);
    }
  };

  const getDefaultName = () => {
    switch (selectedType) {
      case 'icom-wlan': return 'ICOM WLAN';
      case 'network': return t('settings:radioType.network');
      case 'serial': return t('settings:radioType.serial');
      case 'none': return t('settings:radioType.none');
      default: return t('settings:profileSetup.myProfile');
    }
  };

  // 渲染步骤0：选择类型
  const renderStep0 = () => (
    <div className="space-y-4">
      <p className="text-default-600">{t('settings:profileSetup.selectTypePrompt')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {RADIO_TYPE_OPTIONS.map(option => (
          <Card
            key={option.type}
            isPressable
            onPress={() => handleSelectType(option.type)}
            shadow="none"
            radius="lg"
            classNames={{
              base: 'border border-divider bg-content1 hover:border-primary transition-colors'
            }}
          >
            <CardBody className="p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
                  <FontAwesomeIcon icon={option.icon} className="text-primary text-lg" />
                </div>
                <div>
                  <h4 className="font-semibold text-default-900">{option.title}</h4>
                  <p className="text-xs text-default-500 mt-0.5">{option.description}</p>
                </div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );

  // 渲染步骤1：电台配置
  const renderStep1 = () => (
    <div>
      <RadioDeviceSettings
        ref={radioSettingsRef}
        initialConfig={radioConfig}
        onChange={setRadioConfig}
      />
    </div>
  );

  // 渲染步骤2：音频配置
  const renderStep2 = () => (
    <div>
      <AudioDeviceSettings
        ref={audioSettingsRef}
        initialConfig={audioConfig}
        onChange={setAudioConfig}
      />
    </div>
  );

  // 渲染步骤3：命名
  const renderStep3 = () => (
    <div className="space-y-4 py-4">
      <p className="text-default-600">{t('settings:profileSetup.namePrompt')}</p>
      <Input
        label={t('settings:profileSetup.nameLabel')}
        placeholder={getDefaultName()}
        value={profileName}
        onChange={e => setProfileName(e.target.value)}
        size="lg"
      />
      <div className="text-xs text-default-400 bg-default-50 p-3 rounded-lg">
        <p>{t('settings:profileSetup.defaultNameHint', { name: getDefaultName() })}</p>
      </div>
    </div>
  );

  const stepTitles = [t('settings:profileSetup.step0'), t('settings:profileSetup.step1'), t('settings:profileSetup.step2'), t('settings:profileSetup.step3')];

  return (
    <Modal
      isOpen={isOpen}
      isDismissable={false}
      hideCloseButton
      size="3xl"
      scrollBehavior="inside"
      placement="center"
      backdrop="blur"
      classNames={{
        body: "px-4 sm:px-6 pt-3 sm:pt-4 pb-5 sm:pb-6",
        header: "px-4 sm:px-6 pt-5 sm:pt-6 pb-3 sm:pb-4",
        footer: "border-t border-divider px-4 sm:px-6 py-3 sm:py-4",
      }}
    >
      <ModalContent>
        <ModalHeader>
          <div className="w-full">
            <h2 className="text-xl font-bold">{t('settings:profileSetup.welcome')}</h2>
            <p className="text-sm text-default-500 font-normal mt-1">
              {step === 0 ? t('settings:profileSetup.welcomeDesc') : stepTitles[step]}
            </p>
            <Progress
              value={progressValue}
              color="primary"
              size="sm"
              className="mt-3"
            />
          </div>
        </ModalHeader>

        <ModalBody>
          {step === 0 && renderStep0()}
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
        </ModalBody>

        {step > 0 && (
          <ModalFooter>
            <div className="flex justify-between items-center w-full">
              <Button
                variant="light"
                onPress={handleBack}
                startContent={<FontAwesomeIcon icon={faArrowLeft} />}
              >
                {t('settings:profileSetup.back')}
              </Button>
              <div className="flex gap-2">
                {step < 3 ? (
                  <Button
                    color="primary"
                    onPress={handleNext}
                    endContent={<FontAwesomeIcon icon={faArrowRight} />}
                  >
                    {t('settings:profileSetup.next')}
                  </Button>
                ) : (
                  <Button
                    color="primary"
                    onPress={handleFinish}
                    isLoading={isCreating}
                    startContent={!isCreating ? <FontAwesomeIcon icon={faCheck} /> : undefined}
                  >
                    {t('settings:profileSetup.finish')}
                  </Button>
                )}
              </div>
            </div>
          </ModalFooter>
        )}
      </ModalContent>
    </Modal>
  );
}
