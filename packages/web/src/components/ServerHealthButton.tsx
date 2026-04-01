import React, { useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeartPulse } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useConnection, useRadioConnectionState } from '../store/radioStore';
import { useServerHealth } from '../hooks/useServerHealth';
import { ServerHealthModal } from './ServerHealthModal';

export const ServerHealthButton: React.FC = () => {
  const { t } = useTranslation('settings');
  const connection = useConnection();
  const radioConnection = useRadioConnectionState();
  const { snapshots, health } = useServerHealth(connection.state.radioService);
  const [isOpen, setIsOpen] = useState(false);

  const colorClass =
    health === 'critical' ? 'text-danger' :
    health === 'warn' ? 'text-warning' :
    'text-default-400';

  return (
    <>
      <Tooltip content={t('serverHealth.tooltip')} placement="bottom">
        <Button
          isIconOnly
          variant="light"
          size="sm"
          onPress={() => setIsOpen(true)}
          aria-label={t('serverHealth.tooltip')}
          className="relative"
        >
          <FontAwesomeIcon
            icon={faHeartPulse}
            className={`text-sm transition-colors ${colorClass}`}
          />
          {(health === 'warn' || health === 'critical') && (
            <span
              className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${health === 'critical' ? 'bg-danger' : 'bg-warning'}`}
            />
          )}
        </Button>
      </Tooltip>

      <ServerHealthModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        snapshots={snapshots}
        health={health}
        coreCapabilities={radioConnection.coreCapabilities}
        coreCapabilityDiagnostics={radioConnection.coreCapabilityDiagnostics}
      />
    </>
  );
};
