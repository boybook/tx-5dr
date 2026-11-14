import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ModeRightTopTabs } from '../keyboard-mode/ModeRightTopTabs';

interface RttyRightTopTabsProps {
  operatorId: string | null | undefined;
  nativeContent: React.ReactNode;
  toolbarRight?: React.ReactNode;
}

export const RttyRightTopTabs: React.FC<RttyRightTopTabsProps> = (props) => {
  const { t } = useTranslation('radio');
  return (
    <ModeRightTopTabs
      {...props}
      slotId="rtty-right-top"
      nativeTabLabel={t('rtty.qsoTab', 'QSOs')}
    />
  );
};
