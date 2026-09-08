import { useState } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBell, faBellSlash } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useClientNotifications } from '../../notifications/ClientNotificationProvider';
import { ClientNotificationSettings } from '../settings/ClientNotificationSettings';

export function ClientNotificationButton() {
  const { t } = useTranslation('settings');
  const { preferences, qso, soundStatus } = useClientNotifications();
  const [open, setOpen] = useState(false);
  const enabled = preferences.qsoEnabled || preferences.replyEnabled;
  const warning = (preferences.qsoEnabled && !qso.state.isEffectivelyEnabled)
    || (preferences.replyEnabled && soundStatus !== 'ready');
  const active = qso.state.isEffectivelyEnabled || (preferences.replyEnabled && soundStatus === 'ready');
  const color = warning ? 'text-warning-600' : active ? 'text-success-600' : 'text-default-400';
  const title = t('clientNotifications.title');

  return (
    <Popover placement="bottom-end" isOpen={open} onOpenChange={setOpen} aria-label={title}>
      <Tooltip content={title} isDisabled={open}>
        <div className="inline-flex">
          <PopoverTrigger>
            <Button isIconOnly variant="light" size="sm" aria-label={title} className={color}>
              <FontAwesomeIcon icon={enabled ? faBell : faBellSlash} className="text-sm" />
            </Button>
          </PopoverTrigger>
        </div>
      </Tooltip>
      <PopoverContent className="w-80 max-w-[calc(100vw-24px)] rounded-lg p-4"
        onKeyDownCapture={event => {
          if (event.key === 'Escape' && !event.currentTarget.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}>
        <div className="flex w-full min-w-0 flex-col gap-4">
          <h3 className="text-sm font-semibold">{title}</h3>
          {open && <ClientNotificationSettings />}
        </div>
      </PopoverContent>
    </Popover>
  );
}
