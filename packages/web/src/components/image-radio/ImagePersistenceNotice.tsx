import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ImagePersistenceStatus } from '@tx5dr/contracts';

export function ImagePersistenceNotice({ persistence }: { persistence?: ImagePersistenceStatus }) {
  const { t } = useTranslation('image');
  if (!persistence) return null;
  const recovered = persistence.stores.filter(store => store.state === 'recovered');
  if (persistence.available && recovered.length === 0) return null;
  const key = !persistence.available ? (persistence.stores.some(store => store.reason === 'future_version') ? 'futureVersion' : 'unavailable')
    : recovered.some(store => store.reason === 'rebuilt') ? 'rebuilt'
      : recovered.some(store => store.reason === 'salvaged') ? 'salvaged' : 'restored';
  return (
    <div role="status" className="m-2 rounded-lg bg-warning-50 p-3 text-sm text-warning-800 dark:text-warning-200">
      {t(`persistence.${key}`)}
      <p className="mt-1">{t(persistence.available ? 'persistence.originalsPreserved' : 'persistence.restartAfterRepair')}</p>
    </div>
  );
}
