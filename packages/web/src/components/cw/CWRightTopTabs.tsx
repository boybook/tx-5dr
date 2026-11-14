import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ModeRightTopTabs } from '../keyboard-mode/ModeRightTopTabs';

interface CWRightTopTabsProps {
  operatorId: string | null | undefined;
  nativeContent: React.ReactNode;
  toolbarRight?: React.ReactNode;
}

export const CWRightTopTabs: React.FC<CWRightTopTabsProps> = (props) => {
  const { t } = useTranslation('radio');
  return (
    <ModeRightTopTabs
      {...props}
      slotId="cw-right-top"
      nativeTabLabel={t('cw.qsoTab', 'QSOs')}
    />
  );
};
