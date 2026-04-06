import { describe, expect, it } from 'vitest';

import type { FrameDisplayMessage, FrameGroup } from '../FramesTable';
import { getBottomGroupSignature } from '../framesTableAutoScroll';

const createMessage = (overrides: Partial<FrameDisplayMessage> = {}): FrameDisplayMessage => ({
  utc: '12:00:00',
  db: -10,
  dt: 0.1,
  freq: 1000,
  message: 'CQ TEST',
  ...overrides,
});

const createGroup = (startMs: number, messages: FrameDisplayMessage[]): FrameGroup => ({
  time: '120000',
  startMs,
  messages,
  type: 'receive',
  cycle: 'even',
});

describe('framesTableAutoScroll', () => {
  it('changes signature when a new message is appended to the bottom group', () => {
    const previousGroups = [
      createGroup(1000, [createMessage({ message: 'CQ A' })]),
    ];
    const nextGroups = [
      createGroup(1000, [
        createMessage({ message: 'CQ A' }),
        createMessage({ message: 'CQ B', utc: '12:00:15', freq: 1100 }),
      ]),
    ];

    expect(getBottomGroupSignature(nextGroups)).not.toBe(getBottomGroupSignature(previousGroups));
  });

  it('changes signature when the bottom group updates an existing message without changing count', () => {
    const previousGroups = [
      createGroup(1000, [createMessage({ message: 'CQ A', db: -20, dt: 0.5 })]),
    ];
    const nextGroups = [
      createGroup(1000, [createMessage({ message: 'CQ A', db: -8, dt: 0.1 })]),
    ];

    expect(getBottomGroupSignature(nextGroups)).not.toBe(getBottomGroupSignature(previousGroups));
  });

  it('keeps signature stable when only non-bottom groups change', () => {
    const bottomGroup = createGroup(2000, [createMessage({ message: 'CQ B', utc: '12:00:15' })]);
    const previousGroups = [
      createGroup(1000, [createMessage({ message: 'CQ A', db: -20 })]),
      bottomGroup,
    ];
    const nextGroups = [
      createGroup(1000, [createMessage({ message: 'CQ A', db: -5 })]),
      bottomGroup,
    ];

    expect(getBottomGroupSignature(nextGroups)).toBe(getBottomGroupSignature(previousGroups));
  });
});
