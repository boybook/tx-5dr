import * as React from 'react';
import { Slider } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { useConnection } from '../store/radioStore';
import { useCan } from '../store/authStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('TxVolumeGainControl');

interface TxVolumeGainControlProps {
  orientation?: 'horizontal' | 'vertical';
  onInteracted?: () => void;
  ariaLabel?: string;
  className?: string;
  sliderClassName?: string;
  sliderStyle?: React.CSSProperties;
  valueClassName?: string;
}

const MIN_DB = -60;
const MAX_DB = 20;

const dbToGain = (db: number): number => Math.pow(10, db / 20);

const gainToDb = (gain: number): number => 20 * Math.log10(Math.max(0.001, gain));

const formatDbDisplay = (db: number): string => {
  if (Number.isNaN(db)) {
    return '0.0dB';
  }

  return db >= 0 ? `+${db.toFixed(1)}dB` : `${db.toFixed(1)}dB`;
};

const parseVolumeGain = (data: unknown): number | null => {
  if (data && typeof data === 'object' && 'gain' in data) {
    const gainValue = (data as { gain?: unknown }).gain;
    if (typeof gainValue === 'number' && !Number.isNaN(gainValue) && gainValue >= 0) {
      return gainValue;
    }
    return null;
  }

  if (typeof data === 'number' && !Number.isNaN(data) && data >= 0) {
    return data;
  }

  return null;
};

export const TxVolumeGainControl: React.FC<TxVolumeGainControlProps> = ({
  orientation = 'vertical',
  onInteracted,
  ariaLabel,
  className = '',
  sliderClassName = '',
  sliderStyle,
  valueClassName = '',
}) => {
  const { t } = useTranslation('radio');
  const connection = useConnection();
  const canControl = useCan('execute', 'RadioControl');
  const [volumeGain, setVolumeGain] = React.useState(1.0);

  const handleVolumeChange = React.useCallback((value: number | number[]) => {
    const dbValue = Array.isArray(value) ? value[0] : value;
    if (Number.isNaN(dbValue) || dbValue < MIN_DB || dbValue > MAX_DB) {
      return;
    }

    onInteracted?.();
    setVolumeGain(dbToGain(dbValue));
    connection.state.radioService?.setVolumeGainDb(dbValue);
  }, [connection.state.radioService, onInteracted]);

  React.useEffect(() => {
    if (!connection.state.radioService) {
      return;
    }

    const wsClient = connection.state.radioService.wsClientInstance;

    const handleVolumeGainChanged = (data: unknown) => {
      const gain = parseVolumeGain(data);
      if (gain !== null) {
        setVolumeGain(gain);
        return;
      }

      logger.debug('Received invalid volume gain payload', data);
    };

    const handleSystemStatus = (status: unknown) => {
      if (!status || typeof status !== 'object') {
        return;
      }

      const systemStatus = status as { volumeGain?: unknown; volumeGainDb?: unknown };
      if (typeof systemStatus.volumeGain === 'number' && !Number.isNaN(systemStatus.volumeGain) && systemStatus.volumeGain >= 0) {
        setVolumeGain(systemStatus.volumeGain);
        return;
      }

      if (typeof systemStatus.volumeGainDb === 'number' && !Number.isNaN(systemStatus.volumeGainDb) && systemStatus.volumeGainDb >= MIN_DB && systemStatus.volumeGainDb <= MAX_DB) {
        setVolumeGain(dbToGain(systemStatus.volumeGainDb));
      }
    };

    wsClient.onWSEvent('volumeGainChanged', handleVolumeGainChanged);
    wsClient.onWSEvent('systemStatus', handleSystemStatus);

    return () => {
      wsClient.offWSEvent('volumeGainChanged', handleVolumeGainChanged);
      wsClient.offWSEvent('systemStatus', handleSystemStatus);
    };
  }, [connection.state.radioService]);

  React.useEffect(() => {
    if (connection.state.isConnected && connection.state.radioService) {
      connection.state.radioService.getSystemStatus();
    }
  }, [connection.state.isConnected, connection.state.radioService]);

  const currentDbValue = gainToDb(volumeGain);
  const wrapperClassName = orientation === 'horizontal'
    ? `w-full space-y-2 ${className}`.trim()
    : `flex flex-col items-center ${className}`.trim();

  return (
    <div className={wrapperClassName}>
      <Slider
        orientation={orientation}
        minValue={MIN_DB}
        maxValue={MAX_DB}
        step={0.1}
        value={[currentDbValue]}
        onChange={handleVolumeChange}
        isDisabled={!canControl}
        className={sliderClassName}
        style={sliderStyle}
        aria-label={ariaLabel || t('control.txVolumeGain')}
      />
      <div
        className={[
          'text-sm text-default-400 font-mono',
          orientation === 'horizontal' ? 'text-right' : 'text-center',
          valueClassName,
        ].filter(Boolean).join(' ')}
      >
        {formatDbDisplay(currentDbValue)}
      </div>
    </div>
  );
};
