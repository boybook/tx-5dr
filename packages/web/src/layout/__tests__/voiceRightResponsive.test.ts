import { describe, expect, it } from 'vitest';

import {
  createInitialVoiceRightCollapseState,
  enforceVoiceRightHeightLimit,
  isVoiceRightMutualExclusionActive,
  updateVoiceRightCardCollapse,
  type VoiceRightCollapseState,
} from '../voiceRightResponsive';

describe('voice right responsive collapse logic', () => {
  it('keeps both cards expandable when height is sufficient', () => {
    const initial = createInitialVoiceRightCollapseState();
    const withKeyerOpen = updateVoiceRightCardCollapse(initial, 'keyer', false, false);

    expect(withKeyerOpen).toEqual({
      qsoCollapsed: false,
      keyerCollapsed: false,
      lastExpandedCard: 'keyer',
    });
  });

  it('collapses QSO log when keyer expands under height pressure', () => {
    const initial = createInitialVoiceRightCollapseState();
    const withKeyerOpen = updateVoiceRightCardCollapse(initial, 'keyer', false, true);

    expect(withKeyerOpen).toEqual({
      qsoCollapsed: true,
      keyerCollapsed: false,
      lastExpandedCard: 'keyer',
    });
  });

  it('collapses keyer when QSO log expands under height pressure', () => {
    const initial: VoiceRightCollapseState = {
      qsoCollapsed: true,
      keyerCollapsed: false,
      lastExpandedCard: 'keyer',
    };
    const withQsoOpen = updateVoiceRightCardCollapse(initial, 'qso', false, true);

    expect(withQsoOpen).toEqual({
      qsoCollapsed: false,
      keyerCollapsed: true,
      lastExpandedCard: 'qso',
    });
  });

  it('keeps the most recently expanded card when height becomes limited', () => {
    const bothOpen: VoiceRightCollapseState = {
      qsoCollapsed: false,
      keyerCollapsed: false,
      lastExpandedCard: 'keyer',
    };

    expect(enforceVoiceRightHeightLimit(bothOpen)).toEqual({
      qsoCollapsed: true,
      keyerCollapsed: false,
      lastExpandedCard: 'keyer',
    });
  });

  it('does not auto-expand the other card when the current card collapses', () => {
    const initial: VoiceRightCollapseState = {
      qsoCollapsed: true,
      keyerCollapsed: false,
      lastExpandedCard: 'keyer',
    };
    const withKeyerClosed = updateVoiceRightCardCollapse(initial, 'keyer', true, true);

    expect(withKeyerClosed).toEqual({
      qsoCollapsed: true,
      keyerCollapsed: true,
      lastExpandedCard: 'keyer',
    });
  });

  it('keeps mutual exclusion active at a previously limited viewport height', () => {
    expect(isVoiceRightMutualExclusionActive(false, 760, 760)).toBe(true);
    expect(isVoiceRightMutualExclusionActive(false, 760, 900)).toBe(false);
  });
});
