import { describe, expect, it } from 'vitest';
import { isTargetRelated, type FrameDisplayMessage } from './FramesTable';

function rx(callsign: string): FrameDisplayMessage {
  return {
    utc: '09:49:15',
    db: 20,
    dt: 0,
    freq: 1_840,
    message: `${callsign} BG0VRT R OL74`,
    logbookAnalysis: { callsign },
  };
}

describe('FramesTable active target highlighting', () => {
  it('matches every active stream target instead of only the primary target', () => {
    const targets = ['VR2VAC', 'YV5VAB'];
    expect(isTargetRelated(rx('VR2VAC'), targets)).toBe(true);
    expect(isTargetRelated(rx('YV5VAB'), targets)).toBe(true);
    expect(isTargetRelated(rx('JA1AAA'), targets)).toBe(false);
  });

  it('matches target tokens in each transmitted stream row', () => {
    expect(isTargetRelated({
      ...rx('YV5VAB'),
      db: 'TX',
      dt: '-',
      message: 'YV5VAB BG0VRT NN00',
    }, ['VR2VAC', 'YV5VAB'])).toBe(true);
  });
});
