import React from 'react';
import type { QSORecord } from '@tx5dr/contracts';
import { ModeRecentQSOList } from '../keyboard-mode/ModeRecentQSOList';

interface RttyRecentQSOListProps {
  selectedQSOId?: string | null;
  onSelectQSO?: (qso: QSORecord) => void;
  onDeselectQSO?: () => void;
  lastUpdatedQSO?: QSORecord | null;
  lastDeletedId?: string | null;
}

/** The operator's recent keyboard and voice QSOs, filtered like the CW list. */
export const RttyRecentQSOList: React.FC<RttyRecentQSOListProps> = (props) => (
  <ModeRecentQSOList {...props} i18nPrefix="rtty.recentQSO" />
);
