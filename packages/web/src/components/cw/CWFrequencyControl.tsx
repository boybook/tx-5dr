import React from 'react';
import type { LastFrequencyResponse } from '@tx5dr/contracts';
import { ModeFrequencyControl } from '../keyboard-mode/ModeFrequencyControl';

const DEFAULT_CW_FREQUENCY = 14_000_000;

const pickLastCWFrequency = (response: LastFrequencyResponse) => response.lastCWFrequency?.frequency;

export const CWFrequencyControl: React.FC = () => (
  <ModeFrequencyControl
    mode="CW"
    defaultFrequency={DEFAULT_CW_FREQUENCY}
    pickLastFrequency={pickLastCWFrequency}
  />
);
