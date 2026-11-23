import React from 'react';
import {
  Button,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Spinner,
  Tooltip,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faEllipsisVertical, faLock, faPen, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';

export interface StationRowProps {
  icon: IconDefinition;
  title: string;
  subtitle: string;
  monospaceSubtitle?: boolean;
  isOpen: boolean;
  isLastUsed: boolean;
  status?: { label: string; color: 'success' | 'warning' | 'danger' | 'default'; loading?: boolean } | null;
  pinned?: boolean;
  onOpen: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
  busy?: boolean;
  children?: React.ReactNode;
}

/** One station in the station manager list. */
export const StationRow: React.FC<StationRowProps> = ({
  icon,
  title,
  subtitle,
  monospaceSubtitle = false,
  isOpen,
  isLastUsed,
  status,
  pinned = false,
  onOpen,
  onEdit,
  onRemove,
  busy = false,
  children,
}) => {
  const { t } = useTranslation('stations');
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-medium transition-colors duration-200 ${
            isOpen ? 'bg-primary text-primary-foreground' : 'bg-default-100 text-default-500'
          }`}
        >
          <FontAwesomeIcon icon={icon} className="text-small" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-small font-semibold text-foreground">{title}</span>
            {isOpen && (
              <Chip size="sm" variant="dot" color="success" classNames={{ base: 'h-5 border-1', content: 'text-tiny' }}>
                {t('badge.open')}
              </Chip>
            )}
            {!isOpen && isLastUsed && (
              <Chip size="sm" variant="flat" classNames={{ base: 'h-5', content: 'text-tiny' }}>
                {t('badge.lastUsed')}
              </Chip>
            )}
            {status && (
              <Chip
                size="sm"
                variant="flat"
                color={status.color}
                startContent={status.loading ? <Spinner size="sm" color="current" classNames={{ wrapper: 'h-3 w-3' }} /> : undefined}
                classNames={{ base: 'h-5 gap-1', content: 'text-tiny' }}
              >
                {status.label}
              </Chip>
            )}
            {pinned && (
              <Tooltip content={t('badge.pinned')} size="sm" delay={300}>
                <span className="text-tiny text-default-400" aria-label={t('badge.pinned')}>
                  <FontAwesomeIcon icon={faLock} />
                </span>
              </Tooltip>
            )}
          </div>
          <p className={`mt-0.5 truncate text-tiny text-default-500 ${monospaceSubtitle ? 'font-mono' : ''}`} title={subtitle}>
            {subtitle}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <Button
            size="sm"
            color="primary"
            variant={isOpen ? 'flat' : 'solid'}
            isLoading={busy}
            onPress={onOpen}
          >
            {isOpen ? t('actions.focus') : t('actions.open')}
          </Button>
          {(onEdit || onRemove) && (
            <Dropdown placement="bottom-end">
              <DropdownTrigger>
                <Button isIconOnly size="sm" variant="light" aria-label={t('actions.more')}>
                  <FontAwesomeIcon icon={faEllipsisVertical} className="text-default-500" />
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label={t('actions.more')}
                items={[
                  ...(onEdit ? [{ key: 'edit', label: t('actions.edit'), icon: faPen, danger: false }] : []),
                  ...(onRemove ? [{ key: 'remove', label: t('actions.remove'), icon: faTrashCan, danger: true }] : []),
                ]}
                onAction={(key) => {
                  if (key === 'edit') onEdit?.();
                  if (key === 'remove') onRemove?.();
                }}
              >
                {(item) => (
                  <DropdownItem
                    key={item.key}
                    className={item.danger ? 'text-danger' : undefined}
                    color={item.danger ? 'danger' : 'default'}
                    startContent={<FontAwesomeIcon icon={item.icon} className={item.danger ? 'w-4' : 'w-4 text-default-500'} />}
                  >
                    {item.label}
                  </DropdownItem>
                )}
              </DropdownMenu>
            </Dropdown>
          )}
        </div>
      </div>
      {children}
    </div>
  );
};
