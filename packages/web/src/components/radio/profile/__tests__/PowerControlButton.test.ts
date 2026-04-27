import { describe, expect, it } from 'vitest';
import type { RadioPowerSupportInfo } from '@tx5dr/contracts';
import { getRenderablePowerTargets } from '../PowerControlButton';

function createSupport(supportedStates: RadioPowerSupportInfo['supportedStates']): RadioPowerSupportInfo {
  return {
    profileId: 'profile-ft710',
    canPowerOn: true,
    canPowerOff: supportedStates.length > 0,
    supportedStates,
    rigInfo: { mfgName: 'Yaesu', modelName: 'FT-710' },
  };
}

describe('PowerControlButton', () => {
  it('renders only physical power targets returned by the support endpoint', () => {
    expect(getRenderablePowerTargets(createSupport(['off']))).toEqual(['off']);
    expect(getRenderablePowerTargets(createSupport(['standby', 'off']))).toEqual(['standby', 'off']);
  });

  it('does not add a fallback off target when support returns no connected-state targets', () => {
    expect(getRenderablePowerTargets(createSupport([]))).toEqual([]);
  });
});
