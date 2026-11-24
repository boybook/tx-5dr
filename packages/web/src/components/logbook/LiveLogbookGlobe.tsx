import React, { useMemo, useSyncExternalStore } from 'react';
import RecentQSOGlobeCard, { type RecentQSOGlobeCardProps } from './RecentQSOGlobeCard';
import type { LiveTargeting } from './LiveTargetCard';
import type { LogbookGlobeFeed } from '../../utils/logbookGlobeFeed';
import { resolveTargetOperators } from '../../utils/liveTargeting';

type LiveLogbookGlobeProps = Omit<RecentQSOGlobeCardProps, 'operators' | 'reception' | 'liveDecodes' | 'liveTargeting'> & {
  feed: LogbookGlobeFeed;
  /** The page's own operator, offered first when calling a station. */
  operatorId?: string;
  selectLiveTarget: LiveTargeting['select'];
};

/**
 * The logbook globe fed by the logbook socket. It subscribes to the feed
 * itself, so live updates re-render the globe and leave the page alone.
 */
const LiveLogbookGlobe: React.FC<LiveLogbookGlobeProps> = ({ feed, operatorId, selectLiveTarget, ...props }) => {
  const { operators, reception, liveDecodes, targetingSupported } = useSyncExternalStore(feed.subscribe, feed.getState);
  const targetOperators = useMemo(() => resolveTargetOperators(operators, operatorId), [operators, operatorId]);
  const liveTargeting = useMemo<LiveTargeting>(() => ({
    supported: targetingSupported,
    operators: targetOperators.options,
    defaultOperatorId: targetOperators.defaultId,
    select: selectLiveTarget,
  }), [targetingSupported, targetOperators, selectLiveTarget]);

  return (
    <RecentQSOGlobeCard
      {...props}
      operators={operators}
      reception={reception}
      liveDecodes={liveDecodes}
      liveTargeting={liveTargeting}
    />
  );
};

export default LiveLogbookGlobe;
