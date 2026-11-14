import React from 'react';
import type { QSORecord } from '@tx5dr/contracts';
import { ModeRecentQSOList } from '../keyboard-mode/ModeRecentQSOList';

interface CWRecentQSOListProps {
  selectedQSOId?: string | null;
  onSelectQSO?: (qso: QSORecord) => void;
  onDeselectQSO?: () => void;
  lastUpdatedQSO?: QSORecord | null;
  lastDeletedId?: string | null;
}

/**
 * CW Recent QSO List: the operator's recent non-digital (voice + CW) QSOs.
 */
export const CWRecentQSOList: React.FC<CWRecentQSOListProps> = (props) => (
  <ModeRecentQSOList {...props} i18nPrefix="cw.recentQSO" />
);
