import React, { useState, useCallback, useRef } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSave } from '@fortawesome/free-solid-svg-icons';
import { LogbookSyncSettings, type LogbookSyncSettingsRef } from './LogbookSyncSettings';

interface SyncConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  callsign: string;
  initialTab?: 'wavelog' | 'qrz' | 'lotw';
  onSaved?: () => void;
}

export function SyncConfigModal({ isOpen, onClose, callsign, initialTab, onSaved }: SyncConfigModalProps) {
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);
  const logbookSyncSettingsRef = useRef<LogbookSyncSettingsRef | null>(null);

  const handleClose = useCallback(() => {
    if (logbookSyncSettingsRef.current?.hasUnsavedChanges()) {
      setIsConfirmDialogOpen(true);
    } else {
      onClose();
      setHasUnsavedChanges(false);
    }
  }, [onClose]);

  const handleSave = useCallback(async () => {
    try {
      if (logbookSyncSettingsRef.current) {
        await logbookSyncSettingsRef.current.save();
      }
      setHasUnsavedChanges(false);
      onSaved?.();
    } catch (error) {
      console.error('保存同步配置失败:', error);
    }
  }, [onSaved]);

  const handleConfirmDiscard = useCallback(() => {
    setIsConfirmDialogOpen(false);
    setHasUnsavedChanges(false);
    onClose();
  }, [onClose]);

  const handleConfirmSave = useCallback(async () => {
    try {
      await handleSave();
      setIsConfirmDialogOpen(false);
      onClose();
    } catch (error) {
      console.error('保存同步配置失败:', error);
      setIsConfirmDialogOpen(false);
    }
  }, [handleSave, onClose]);

  const handleConfirmCancel = useCallback(() => {
    setIsConfirmDialogOpen(false);
  }, []);

  return (
    <>
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
          footer: "border-t border-divider px-6 py-4",
        }}
      >
        <ModalContent>
          <ModalHeader>
            <h2 className="text-xl font-bold">{callsign} 同步配置</h2>
          </ModalHeader>

          <ModalBody>
            <LogbookSyncSettings
              ref={logbookSyncSettingsRef}
              callsign={callsign}
              initialTab={initialTab}
              onUnsavedChanges={setHasUnsavedChanges}
            />
          </ModalBody>

          <ModalFooter>
            <div className="flex justify-between items-center w-full">
              <div className="text-sm text-default-400">
                {hasUnsavedChanges && (
                  <span className="text-warning-600">● 有未保存的更改</span>
                )}
              </div>
              <div className="flex gap-3">
                <Button
                  variant="flat"
                  onPress={handleClose}
                >
                  取消
                </Button>
                <Button
                  color="primary"
                  onPress={handleSave}
                  isDisabled={!hasUnsavedChanges}
                  startContent={<FontAwesomeIcon icon={faSave} />}
                >
                  保存
                </Button>
              </div>
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 未保存更改确认对话框 */}
      <Modal
        isOpen={isConfirmDialogOpen}
        onClose={handleConfirmCancel}
        size="sm"
        placement="center"
        backdrop="blur"
      >
        <ModalContent>
          <ModalHeader>
            <h3 className="text-lg font-semibold">未保存的更改</h3>
          </ModalHeader>
          <ModalBody>
            <p className="text-default-600">
              您有未保存的设置更改。您希望保存这些更改吗？
            </p>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={handleConfirmCancel}
            >
              取消
            </Button>
            <Button
              color="danger"
              variant="flat"
              onPress={handleConfirmDiscard}
            >
              不保存
            </Button>
            <Button
              color="primary"
              onPress={handleConfirmSave}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
