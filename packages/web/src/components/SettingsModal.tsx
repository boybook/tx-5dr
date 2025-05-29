import React from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
} from '@heroui/react';
import { AudioDeviceSettings } from './AudioDeviceSettings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  return (
    <Modal 
      isOpen={isOpen} 
      onClose={onClose}
      size="3xl"
      scrollBehavior="inside"
      placement="center"
      backdrop="blur"
      classNames={{
        base: "max-h-[90vh]",
        body: "py-6",
        header: "border-b border-divider",
      }}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <h2 className="text-xl font-bold">🎤 音频设备设置</h2>
          <p className="text-sm text-default-500 font-normal">
            配置TX5DR的音频输入输出设备
          </p>
        </ModalHeader>
        <ModalBody>
          <AudioDeviceSettings onClose={onClose} />
        </ModalBody>
      </ModalContent>
    </Modal>
  );
} 