import React from 'react';
import type { LastFrequencyResponse } from '@tx5dr/contracts';
import { ModeFrequencyControl } from '../keyboard-mode/ModeFrequencyControl';

const DEFAULT_RTTY_FREQUENCY = 14_080_000;

const pickLastRttyFrequency = (response: LastFrequencyResponse) => response.lastRTTYFrequency?.frequency;

export const RttyFrequencyControl: React.FC = () => (
  <ModeFrequencyControl
    mode="RTTY"
    defaultFrequency={DEFAULT_RTTY_FREQUENCY}
    pickLastFrequency={pickLastRttyFrequency}
  />
);
