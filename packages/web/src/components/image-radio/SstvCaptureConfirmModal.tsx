import React from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { useTranslation } from 'react-i18next';

export function SstvCaptureConfirmModal({
  isOpen,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('image');
  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="sm" placement="center">
      <ModalContent>
        <ModalHeader>{t('interruptReceiveTitle')}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-600">{t('interruptReceiveConfirm')}</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onCancel}>{t('common:button.cancel')}</Button>
          <Button color="danger" onPress={onConfirm}>{t('interruptAndSend')}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
