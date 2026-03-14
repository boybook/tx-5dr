import React from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Chip,
  Accordion,
  AccordionItem,
} from '@heroui/react';
import { useRadioErrors, type RadioErrorRecord } from '../store/radioStore';

interface RadioErrorHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const severityColorMap: Record<string, 'danger' | 'warning' | 'primary' | 'default'> = {
  critical: 'danger',
  error: 'danger',
  warning: 'warning',
  info: 'primary',
};

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN');
}

function ErrorItemTitle({ error }: { error: RadioErrorRecord }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Chip size="sm" color={severityColorMap[error.severity] || 'default'} variant="flat">
        {error.severity}
      </Chip>
      {error.profileName && (
        <Chip size="sm" variant="bordered" className="shrink-0">
          {error.profileName}
        </Chip>
      )}
      <span className="text-sm truncate flex-1">{error.userMessage}</span>
      <span className="text-xs text-default-400 shrink-0">
        {formatTime(error.timestamp)}
      </span>
    </div>
  );
}

function ErrorItemDetail({ error }: { error: RadioErrorRecord }) {
  return (
    <div className="space-y-2 text-sm">
      <p><span className="text-default-500">时间：</span>{formatDateTime(error.timestamp)}</p>
      <p><span className="text-default-500">技术信息：</span>{error.message}</p>
      {error.code && (
        <p><span className="text-default-500">错误代码：</span><code className="text-xs">{error.code}</code></p>
      )}
      {error.suggestions.length > 0 && (
        <div>
          <span className="text-default-500">建议：</span>
          <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
            {error.suggestions.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
      {error.stack && (
        <details>
          <summary className="text-default-400 cursor-pointer text-xs">堆栈信息</summary>
          <pre className="text-xs bg-default-100 p-2 rounded overflow-auto max-h-32 mt-1">
            {error.stack}
          </pre>
        </details>
      )}
    </div>
  );
}

export const RadioErrorHistoryModal: React.FC<RadioErrorHistoryModalProps> = ({ isOpen, onClose }) => {
  const { errors, clearErrors } = useRadioErrors();

  const handleClear = () => {
    clearErrors();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          电台错误历史
          {errors.length > 0 && (
            <span className="text-xs text-default-400 font-normal">
              共 {errors.length} 条记录
            </span>
          )}
        </ModalHeader>
        <ModalBody>
          {errors.length === 0 ? (
            <p className="text-default-500 text-center py-8">暂无错误记录</p>
          ) : (
            <Accordion variant="splitted" selectionMode="multiple">
              {errors.map((error) => (
                <AccordionItem
                  key={error.id}
                  aria-label={error.userMessage}
                  title={<ErrorItemTitle error={error} />}
                >
                  <ErrorItemDetail error={error} />
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </ModalBody>
        <ModalFooter>
          {errors.length > 0 && (
            <Button color="danger" variant="flat" size="sm" onPress={handleClear}>
              清空记录
            </Button>
          )}
          <Button onPress={onClose} size="sm">关闭</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
