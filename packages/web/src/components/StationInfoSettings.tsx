import React, { useState, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Input, Textarea } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { api } from '@tx5dr/core';
import type { StationInfo } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';
import { useRadioState } from '../store/radioStore';

const logger = createLogger('StationInfoSettings');

export interface StationInfoSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface StationInfoSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const StationInfoSettings = forwardRef<StationInfoSettingsRef, StationInfoSettingsProps>(({ onUnsavedChanges }, ref) => {
  const { t } = useTranslation('settings');
  const { dispatch } = useRadioState();
  const [localInfo, setLocalInfo] = useState<StationInfo>({});
  const [savedInfo, setSavedInfo] = useState<StationInfo>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    api.getStationInfo().then(resp => {
      setLocalInfo(resp.data);
      setSavedInfo(resp.data);
    }).catch(err => {
      logger.error('Failed to load station info', err);
    });
  }, []);

  const hasUnsavedChanges = useCallback(
    () => JSON.stringify(localInfo) !== JSON.stringify(savedInfo),
    [localInfo, savedInfo]
  );

  useEffect(() => {
    onUnsavedChanges?.(hasUnsavedChanges());
  }, [localInfo, savedInfo, hasUnsavedChanges, onUnsavedChanges]);

  const save = useCallback(async () => {
    setIsSaving(true);
    try {
      const resp = await api.updateStationInfo(localInfo);
      setSavedInfo(resp.data);
      setLocalInfo(resp.data);
      dispatch({ type: 'setStationInfo', payload: resp.data });
      logger.info('Station info saved');
    } catch (err) {
      logger.error('Failed to save station info', err);
      throw err;
    } finally {
      setIsSaving(false);
    }
  }, [localInfo, dispatch]);

  useImperativeHandle(ref, () => ({ hasUnsavedChanges, save }));

  const updateQth = (field: 'grid' | 'location' | 'latitude' | 'longitude', value: string) => {
    if (field === 'latitude' || field === 'longitude') {
      const num = value === '' ? undefined : parseFloat(value);
      setLocalInfo(prev => ({ ...prev, qth: { ...prev.qth, [field]: isNaN(num as number) ? undefined : num } }));
    } else {
      setLocalInfo(prev => ({ ...prev, qth: { ...prev.qth, [field]: value } }));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        label={t('stationInfo.callsign')}
        placeholder={t('stationInfo.callsignPlaceholder')}
        value={localInfo.callsign ?? ''}
        onValueChange={v => setLocalInfo(prev => ({ ...prev, callsign: v }))}
        isDisabled={isSaving}
      />
      <Input
        label={t('stationInfo.name')}
        placeholder={t('stationInfo.namePlaceholder')}
        value={localInfo.name ?? ''}
        onValueChange={v => setLocalInfo(prev => ({ ...prev, name: v }))}
        isDisabled={isSaving}
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('stationInfo.qthGrid')}
          placeholder="PM01"
          value={localInfo.qth?.grid ?? ''}
          onValueChange={v => updateQth('grid', v)}
          isDisabled={isSaving}
          description={t('stationInfo.qthGridDesc')}
        />
        <Input
          label={t('stationInfo.qthLocation')}
          placeholder={t('stationInfo.qthLocationPlaceholder')}
          value={localInfo.qth?.location ?? ''}
          onValueChange={v => updateQth('location', v)}
          isDisabled={isSaving}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('stationInfo.qthLatitude')}
          placeholder="39.9042"
          type="number"
          value={localInfo.qth?.latitude != null ? String(localInfo.qth.latitude) : ''}
          onValueChange={v => updateQth('latitude', v)}
          isDisabled={isSaving}
          description={t('stationInfo.qthLatitudeDesc')}
        />
        <Input
          label={t('stationInfo.qthLongitude')}
          placeholder="116.4074"
          type="number"
          value={localInfo.qth?.longitude != null ? String(localInfo.qth.longitude) : ''}
          onValueChange={v => updateQth('longitude', v)}
          isDisabled={isSaving}
          description={t('stationInfo.qthLongitudeDesc')}
        />
      </div>
      <Textarea
        label={t('stationInfo.description')}
        placeholder={t('stationInfo.descriptionPlaceholder')}
        value={localInfo.description ?? ''}
        onValueChange={v => setLocalInfo(prev => ({ ...prev, description: v }))}
        isDisabled={isSaving}
        minRows={4}
        maxRows={10}
        description={t('stationInfo.descriptionDesc')}
      />
    </div>
  );
});

StationInfoSettings.displayName = 'StationInfoSettings';
