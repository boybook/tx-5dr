import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { FramesTable, FrameGroup, FrameDisplayMessage } from './FramesTable';
import { resolveFrameCallsign } from './frameCallsign';
import { createSlotPackFrameProjector } from './slotPackFrameProjection';
import { getBandFromFrequency } from '@tx5dr/core';
import { useConnection, useCurrentOperatorId, useRadioActions, useRadioModeState, useOperators, useStationInfo, useSlotPacks } from '../../../store/radioStore';
import type { WSSelectedFrame } from '@tx5dr/contracts';
import { useSplitLayoutActions } from '../../common/SplitLayout';
import { useTranslation } from 'react-i18next';
import { useCallsignFilterRules } from '../../../hooks/useCallsignFilterRules';
import { usePluginSnapshot } from '../../../hooks/usePluginSnapshot';
import { resolveOperatorTargetCallsigns } from '../../../utils/operatorTargets';
import {
  buildQueueCallsignOrder,
  isQueueTargetAction,
  resolveOperatorTargetAction,
  submitOperatorTarget,
} from '../operators/operatorQueuePresentation';

interface SlotPacksMessageDisplayProps {
  className?: string;
  onMessageHover?: (freq: number | null) => void;
}

export const SlotPacksMessageDisplay: React.FC<SlotPacksMessageDisplayProps> = React.memo(({ className = '', onMessageHover }) => {
  const { t } = useTranslation('common');
  const connection = useConnection();
  const radio = useRadioModeState();
  const { operators } = useOperators();
  const stationInfo = useStationInfo();
  const slotPacks = useSlotPacks();
  const { seedSelectedRx } = useRadioActions();
  const {currentOperatorId} = useCurrentOperatorId();
  const splitLayoutActions = useSplitLayoutActions();
  const [scrollToBottomTrigger, setScrollToBottomTrigger] = useState(0);
  const callsignFilter = useCallsignFilterRules(currentOperatorId ?? undefined);
  const pluginSnapshot = usePluginSnapshot();
  const selectedOperator = useMemo(
    () => operators.find((operator) => operator.id === currentOperatorId),
    [currentOperatorId, operators],
  );
  const distanceOriginGrid = useMemo(
    () => selectedOperator?.context?.myGrid?.trim() || stationInfo?.qth?.grid?.trim() || undefined,
    [stationInfo?.qth?.grid, selectedOperator?.context?.myGrid],
  );
  const targetAction = useMemo(
    () => resolveOperatorTargetAction(selectedOperator, pluginSnapshot.plugins),
    [pluginSnapshot.plugins, selectedOperator],
  );
  const queueCallsignOrder = useMemo(
    () => isQueueTargetAction(targetAction)
      ? buildQueueCallsignOrder(selectedOperator?.runtime?.queue)
      : {},
    [selectedOperator?.runtime?.queue, targetAction],
  );
  const displayFilterRules = useMemo(
    () => callsignFilter.filterScope === 'auto-reply-and-display' ? callsignFilter.rules : [],
    [callsignFilter.rules, callsignFilter.filterScope],
  );
  const displayDxccBlockEnabled = callsignFilter.filterScope === 'auto-reply-and-display'
    && callsignFilter.dxccBlockEnabled;
  const groupHeaderBand = useMemo(() => {
    const frequency = radio.currentRadioFrequency;
    if (!frequency || frequency <= 0) {
      return null;
    }

    const band = getBandFromFrequency(frequency);
    return band && band !== 'Unknown' ? band : null;
  }, [radio.currentRadioFrequency]);

  // 切换回"解码" tab 时触发滚动到底部
  useEffect(() => {
    if (splitLayoutActions?.selectedTab === 'left') {
      setScrollToBottomTrigger(prev => prev + 1);
    }
  }, [splitLayoutActions?.selectedTab]);

  const myCallsigns = useMemo(() => operators
    .filter(operator => operator.isActive)
    .map(operator => operator.context?.myCall || '')
    .filter(callsign => callsign.trim() !== ''), [operators]);

  const targetCallsigns = useMemo(
    () => resolveOperatorTargetCallsigns(selectedOperator),
    [selectedOperator],
  );

  const projectFrames = useMemo(() => createSlotPackFrameProjector({
    slotMs: radio.currentMode?.slotMs ?? 0,
    filterRules: displayFilterRules,
    dxccBlockEnabled: displayDxccBlockEnabled,
    blockedDxccEntityCodes: callsignFilter.blockedDxccEntityCodes,
  }), [radio.currentMode?.slotMs, displayFilterRules, displayDxccBlockEnabled, callsignFilter.blockedDxccEntityCodes]);
  const frameGroups = useMemo(() => projectFrames(slotPacks.state.slotPacks), [projectFrames, slotPacks.state.slotPacks]);

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

  const handleRowDoubleClick = useCallback((message: FrameDisplayMessage, _group: FrameGroup) => {
    const callsign = resolveFrameCallsign(message);
    const ownCallsigns = new Set(myCallsigns.map((call) => call.toUpperCase()));
    if (currentOperatorId && callsign && !ownCallsigns.has(callsign.toUpperCase())) {
      seedSelectedRx({
        message,
        group: _group,
      });
      if (connection.state.radioService) {
        submitOperatorTarget(
          connection.state.radioService,
          targetAction,
          currentOperatorId,
          callsign,
          buildSelectedFrame(message, _group),
        );
        // 在移动端双击后自动切换到"呼叫"tab
        splitLayoutActions?.switchToRight();
      }
    }
  }, [connection.state.radioService, currentOperatorId, myCallsigns, seedSelectedRx, splitLayoutActions, targetAction]);

  if (frameGroups.length === 0) {
    return (
      <div className="text-center py-12 cursor-default select-none">
        <div className="text-default-400 mb-2 text-4xl">📡</div>
        <p className="text-default-500 mb-1">{t('slotPacks.noMessages')}</p>
        <p className="text-default-400 text-sm">
          {!connection.state.isConnected
            ? t('slotPacks.connectFirst')
            : !radio.isDecoding
              ? t('slotPacks.startEngine')
              : t('slotPacks.waitingSignal')}
        </p>
      </div>
    );
  }

  return (
    <FramesTable
      groups={frameGroups}
      className={className}
      myCallsigns={myCallsigns}
      targetCallsigns={targetCallsigns}
      queueCallsignOrder={queueCallsignOrder}
      strategyName={selectedOperator?.strategy.name}
      strategyMessagePresentation={selectedOperator?.runtime?.messagePresentation}
      onRowDoubleClick={handleRowDoubleClick}
      onMessageHover={onMessageHover}
      enableCallsignPopover
      scrollToBottomTrigger={scrollToBottomTrigger}
      showGroupHeader
      groupHeaderBand={groupHeaderBand}
      groupHeaderMode={radio.currentMode?.name ?? null}
      enableSorting
      distanceOriginGrid={distanceOriginGrid}
    />
  );
});
