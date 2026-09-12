import { Suspense, type ReactNode } from 'react';
import { Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { EngineMode } from '@tx5dr/contracts';

/** Unmount the outgoing mode even when the next mode's view is still loading. */
export function ModePane({ mode, children }: { mode: EngineMode; children: ReactNode }) {
  const { t } = useTranslation('common');
  return <Suspense key={mode} fallback={
    <div className="flex h-full items-center justify-center" role="status">
      <Spinner aria-label={t('status.loading')} />
    </div>
  }>{children}</Suspense>;
}
