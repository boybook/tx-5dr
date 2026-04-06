import type { FrameGroup } from './FramesTable';

export const BOTTOM_TOLERANCE_PX = 50;

export const getBottomGroupSignature = (groups: FrameGroup[]): string => {
  const lastGroup = groups[groups.length - 1];
  if (!lastGroup) {
    return '';
  }

  return JSON.stringify({
    startMs: lastGroup.startMs,
    type: lastGroup.type,
    cycle: lastGroup.cycle,
    messages: lastGroup.messages.map(message => ({
      utc: message.utc,
      db: message.db,
      dt: message.dt,
      freq: message.freq,
      message: message.message,
    })),
  });
};
