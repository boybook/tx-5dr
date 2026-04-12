import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
} from '@heroui/react';
import { LogbookSyncSettings } from './LogbookSyncSettings';

interface SyncConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  callsign: string;
  initialTab?: string;
  onSaved?: () => void;
}

export function SyncConfigModal({ isOpen, onClose, callsign, initialTab, onSaved }: SyncConfigModalProps) {
  const { t } = useTranslation(['settings', 'logbook']);

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { onClose(); onSaved?.(); }}
      size="3xl"
      scrollBehavior="inside"
      placement="center"
      backdrop="blur"
      classNames={{
        body: "p-4",
        header: "border-b border-divider px-6 py-4",
      }}
    >
      <ModalContent>
        <ModalHeader>
          <h2 className="text-xl font-bold">{t('logbook:logbookSyncSettings.title')}</h2>
        </ModalHeader>

        <ModalBody>
          <LogbookSyncSettings
            key={`${callsign}:${initialTab || ''}:${isOpen ? 'open' : 'closed'}`}
            callsign={callsign}
            initialTab={initialTab}
          />
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
