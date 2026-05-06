import React, { useMemo } from 'react';
import type { WSSelectedFrame } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { FramesTable, type FrameDisplayMessage, type FrameGroup } from './FramesTable';
import {
  useConnection,
  useCurrentOperatorId,
  useMyRelatedTimeline,
  useOperators,
} from '../../../store/radioStore';

interface MyRelatedFT8TableProps {
  className?: string;
}

function getFrequencySegmentKey(group: FrameGroup): string {
  if (group.headerContextKey) {
    return group.headerContextKey;
  }

  const context = group.frequencyContext;
  return [
    context?.band ?? context?.frequency ?? '',
    context?.mode ?? '',
    context?.radioMode ?? '',
  ].join(':');
}

function shouldShowFrequencySegmentHeader(group: FrameGroup, index: number, groups: FrameGroup[]): boolean {
  if (index <= 0) {
    return true;
  }
  return getFrequencySegmentKey(group) !== getFrequencySegmentKey(groups[index - 1]!);
}

export const MyRelatedFramesTable: React.FC<MyRelatedFT8TableProps> = ({ className = '' }) => {
  const { t } = useTranslation('common');
  const connection = useConnection();
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const timeline = useMyRelatedTimeline();
  const groups = timeline.groups;

  const myCallsigns = useMemo(
    () => operators
      .filter(operator => operator.isActive)
      .map(operator => operator.context?.myCall || '')
      .filter(callsign => callsign.trim() !== ''),
    [operators],
  );

  const targetCallsign = useMemo(() => {
    if (!currentOperatorId) {
      return '';
    }
    const operator = operators.find(item => item.id === currentOperatorId);
    return operator?.context?.targetCall || '';
  }, [currentOperatorId, operators]);

  const buildSelectedFrame = (message: FrameDisplayMessage, group: FrameGroup): WSSelectedFrame | undefined => {
    if (typeof message.db !== 'number' || typeof message.dt !== 'number') {
      return undefined;
    }
    return {
      message: message.message,
      snr: message.db,
      dt: message.dt,
      freq: message.freq,
      slotStartMs: group.startMs,
    };
  };

  const handleRowDoubleClick = (message: FrameDisplayMessage, group: FrameGroup) => {
    const callsign = message.logbookAnalysis?.callsign;
    if (!currentOperatorId || !callsign || myCallsigns.includes(callsign)) {
      return;
    }

    timeline.seedSelectedRx({
      targetCallsign: callsign,
      message,
      group,
    });

    connection.state.radioService?.sendRequestCall(
      currentOperatorId,
      callsign,
      buildSelectedFrame(message, group),
    );
  };

  return (
    <div className={className}>
      {groups.length === 0 ? (
        <div className="text-center py-12 cursor-default select-none">
          <div className="text-default-400 mb-2 text-4xl">📞</div>
          <p className="text-default-500 mb-1">{t('myFrames.noRecords')}</p>
          <p className="text-default-400 text-sm">{t('myFrames.hint')}</p>
        </div>
      ) : (
        <FramesTable
          groups={groups}
          className="h-full"
          myCallsigns={myCallsigns}
          targetCallsign={targetCallsign}
          showLogbookAnalysisVisuals={false}
          onRowDoubleClick={handleRowDoubleClick}
          showGroupHeader
          shouldShowGroupHeader={shouldShowFrequencySegmentHeader}
        />
      )}
    </div>
  );
};
