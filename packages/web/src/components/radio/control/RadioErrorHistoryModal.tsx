import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatTime, formatDateTime } from '../../../utils/dateFormatting';
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
import { useRadioErrors, type RadioErrorRecord } from '../../../store/radioStore';

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


/**
 * 优先使用后端提供的 i18n key 本地化，否则回退 userMessage。
 */
function useLocalizedUserMessage(error: RadioErrorRecord): string {
  const { t, i18n } = useTranslation();
  if (error.userMessageKey && i18n.exists(error.userMessageKey)) {
    return t(error.userMessageKey, error.userMessageParams ?? {});
  }
  return error.userMessage;
}

function ErrorItemTitle({ error }: { error: RadioErrorRecord }) {
  const userMessage = useLocalizedUserMessage(error);
  return (
    <div className="flex items-center gap-2 min-w-0 w-full py-0.5">
      <Chip
        size="sm"
        color={severityColorMap[error.severity] || 'default'}
        variant="flat"
        className="shrink-0"
      >
        {error.severity}
      </Chip>
      {error.profileName && (
        <Chip size="sm" variant="bordered" className="shrink-0">
          {error.profileName}
        </Chip>
      )}
      <span className="text-sm text-left whitespace-normal break-words leading-snug flex-1 min-w-0">
        {userMessage}
      </span>
      <span className="text-xs text-default-400 shrink-0">
        {formatTime(error.timestamp)}
      </span>
    </div>
  );
}

function ErrorItemDetail({ error }: { error: RadioErrorRecord }) {
  const { t, i18n } = useTranslation('radio');
  const userMessage = useLocalizedUserMessage(error);
  const localizeSuggestion = (s: string): string =>
    i18n.exists(s) ? t(s) : s;
  const rawHamlibTrace =
    typeof error.context?.rawHamlibTrace === 'string'
      ? (error.context.rawHamlibTrace as string)
      : null;
  const showTechnicalSection = error.message && error.message !== userMessage;

  return (
    <div className="space-y-2 text-sm">
      <p><span className="text-default-500">{t('errorHistory.time')}：</span>{formatDateTime(error.timestamp)}</p>
      <p className="whitespace-pre-wrap break-words">{userMessage}</p>
      {error.code && (
        <p><span className="text-default-500">{t('errorHistory.code')}：</span><code className="text-xs">{error.code}</code></p>
      )}
      {error.suggestions.length > 0 && (
        <div>
          <span className="text-default-500">{t('errorHistory.suggestions')}：</span>
          <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
            {error.suggestions.map((s, i) => (
              <li key={i}>{localizeSuggestion(s)}</li>
            ))}
          </ul>
        </div>
      )}
      {(showTechnicalSection || rawHamlibTrace) && (
        <details>
          <summary className="text-default-400 cursor-pointer text-xs">
            {t('error.technicalDetails')}
          </summary>
          <pre className="text-xs bg-default-100 p-2 rounded overflow-auto max-h-48 mt-1 whitespace-pre-wrap break-words">
            {rawHamlibTrace || error.message}
          </pre>
        </details>
      )}
      {error.stack && (
        <details>
          <summary className="text-default-400 cursor-pointer text-xs">{t('errorHistory.stack')}</summary>
          <pre className="text-xs bg-default-100 p-2 rounded overflow-auto max-h-32 mt-1 whitespace-pre-wrap break-words">
            {error.stack}
          </pre>
        </details>
      )}
    </div>
  );
}

export const RadioErrorHistoryModal: React.FC<RadioErrorHistoryModalProps> = ({ isOpen, onClose }) => {
  const { errors, clearErrors } = useRadioErrors();
  const { t } = useTranslation('radio');

  const handleClear = () => {
    clearErrors();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          {t('errorHistory.title')}
          {errors.length > 0 && (
            <span className="text-xs text-default-400 font-normal">
              {t('errorHistory.count', { count: errors.length })}
            </span>
          )}
        </ModalHeader>
        <ModalBody>
          {errors.length === 0 ? (
            <p className="text-default-500 text-center py-8">{t('errorHistory.empty')}</p>
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
              {t('errorHistory.clear')}
            </Button>
          )}
          <Button onPress={onClose} size="sm">{t('common:button.close')}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
