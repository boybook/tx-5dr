import React, { useState, useRef } from 'react';
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

const RADIO_TYPE_OPTIONS: { type: RadioType; icon: typeof faWifi; title: string; description: string }[] = [
  { type: 'none', icon: faBan, title: '纯监听', description: '不连接电台，仅进行 FT8 解码' },
  { type: 'icom-wlan', icon: faWifi, title: 'ICOM WLAN', description: '通过 Wi-Fi 连接 ICOM 电台' },
  { type: 'network', icon: faSatelliteDish, title: '网络 RigCtrl', description: '通过网络连接 rigctld' },
  { type: 'serial', icon: faPlug, title: '串口直连', description: '通过串口线连接电台' },
];

export function ProfileSetupOverlay({ isOpen }: ProfileSetupOverlayProps) {
  const [step, setStep] = useState(0); // 0=选类型, 1=填配置, 2=选音频, 3=命名
  const [selectedType, setSelectedType] = useState<RadioType | null>(null);
  const [radioConfig, setRadioConfig] = useState<HamlibConfig>({ type: 'none' });
  const [audioConfig, setAudioConfig] = useState<AudioDeviceSettingsType>({});
  const [profileName, setProfileName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const radioSettingsRef = useRef<RadioDeviceSettingsRef | null>(null);
  const audioSettingsRef = useRef<AudioDeviceSettingsRef | null>(null);

  const totalSteps = selectedType === 'icom-wlan' ? 3 : 4; // ICOM WLAN 跳过音频步骤
  const progressValue = ((step + 1) / totalSteps) * 100;

  // 步骤1：选择类型后
  const handleSelectType = (type: RadioType) => {
    setSelectedType(type);
    setRadioConfig({ type } as HamlibConfig);
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
      // 电台配置 → 音频 or 命名
      if (selectedType === 'icom-wlan') {
        setStep(3); // 跳过音频
      } else {
        setStep(2);
      }
    } else if (step === 2) {
      setStep(3);
    }
  };

  // 上一步
  const handleBack = () => {
    if (step === 3) {
      if (selectedType === 'icom-wlan') {
        setStep(1);
      } else {
        setStep(2);
      }
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
      if (!result.profile) throw new Error('创建 Profile 返回数据异常');
      await api.activateProfile(result.profile.id);
      addToast({
        title: `Profile「${name}」已创建并激活`,
        description: '现在可以开始使用了',
        color: 'success',
        timeout: 4000
      });
    } catch (error) {
      addToast({
        title: '创建失败',
        description: error instanceof Error ? error.message : '请重试',
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
      case 'network': return '网络 RigCtrl';
      case 'serial': return '串口电台';
      case 'none': return '纯监听';
      default: return '我的 Profile';
    }
  };

  // 渲染步骤0：选择类型
  const renderStep0 = () => (
    <div className="space-y-4">
      <p className="text-default-600">请选择您的电台连接方式：</p>
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
      <p className="text-default-600">为这个配置起一个名称，方便日后识别和切换：</p>
      <Input
        label="Profile 名称"
        placeholder={getDefaultName()}
        value={profileName}
        onChange={e => setProfileName(e.target.value)}
        size="lg"
      />
      <div className="text-xs text-default-400 bg-default-50 p-3 rounded-lg">
        <p>留空将使用默认名称：{getDefaultName()}</p>
      </div>
    </div>
  );

  const stepTitles = ['选择电台类型', '配置电台', '配置音频设备', '命名 Profile'];

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
        body: "px-4 sm:px-6",
        header: "px-4 sm:px-6 py-3 sm:py-4",
        footer: "border-t border-divider px-4 sm:px-6 py-3 sm:py-4",
      }}
    >
      <ModalContent>
        <ModalHeader>
          <div className="w-full">
            <h2 className="text-xl font-bold">欢迎使用 TX-5DR</h2>
            <p className="text-sm text-default-500 font-normal mt-1">
              {step === 0 ? '首先，让我们配置您的电台' : stepTitles[step]}
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
                上一步
              </Button>
              <div className="flex gap-2">
                {step < 3 ? (
                  <Button
                    color="primary"
                    onPress={handleNext}
                    endContent={<FontAwesomeIcon icon={faArrowRight} />}
                  >
                    下一步
                  </Button>
                ) : (
                  <Button
                    color="primary"
                    onPress={handleFinish}
                    isLoading={isCreating}
                    startContent={!isCreating ? <FontAwesomeIcon icon={faCheck} /> : undefined}
                  >
                    完成
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
