import React from 'react';
import type { QSORecord } from '@tx5dr/contracts';
import { useCWKeyer } from '../../hooks/useCWKeyer';
import { cwQsoDraftStore } from '../../store/cwQsoDraftStore';
import { ModeQSOLogCard } from '../keyboard-mode/ModeQSOLogCard';

interface CWQSOLogCardProps {
  editingQSO?: QSORecord | null;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onEditComplete?: (updated: QSORecord) => void;
  onDeleteComplete?: (deletedId: string) => void;
  onCancelEdit?: () => void;
}

/**
 * CW QSO Log Card: mode CW, 599 reports, start/end time from CW keyer activity.
 */
export const CWQSOLogCard: React.FC<CWQSOLogCardProps> = (props) => {
  const { cwKeyerStatus } = useCWKeyer();
  return (
    <ModeQSOLogCard
      {...props}
      mode="CW"
      defaultReport="599"
      rstMaxLength={3}
      txActive={cwKeyerStatus?.active ?? false}
      draftStore={cwQsoDraftStore}
      i18nPrefix="radio:cw.qso"
    />
  );
};
