import React, { useCallback, useEffect, useRef } from 'react';
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
  /**
   * Invoked after the modal closes (either by user action or by the
   * plugin iframe requesting close via `tx5dr.requestClose()`). Use this
   * to refresh any "configured" state derived from plugin storage.
   */
  onAfterClose?: () => void;
}

export function SyncConfigModal({ isOpen, onClose, callsign, initialTab, onAfterClose }: SyncConfigModalProps) {
  const { t } = useTranslation(['settings', 'logbook']);
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    onClose();
    onAfterClose?.();
  }, [onClose, onAfterClose]);

  // Iframe plugins bubble a custom DOM `plugin-request-close` event from
  // PluginIframeHost when they want the host modal to close (e.g. after a
  // successful save). React does not support custom-event props directly,
  // so attach a native listener to the body wrapper.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node || !isOpen) return;
    const listener = () => handleClose();
    node.addEventListener('plugin-request-close', listener);
    return () => node.removeEventListener('plugin-request-close', listener);
  }, [isOpen, handleClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
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
          {/* `plugin-request-close` is a custom DOM event bubbled from
              PluginIframeHost when the iframe calls `tx5dr.requestClose()`. */}
          <div ref={bodyRef}>
            <LogbookSyncSettings
              key={`${callsign}:${initialTab || ''}:${isOpen ? 'open' : 'closed'}`}
              callsign={callsign}
              initialTab={initialTab}
            />
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
