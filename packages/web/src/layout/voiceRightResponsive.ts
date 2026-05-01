export type VoiceRightExpandableCard = 'qso' | 'keyer';

export interface VoiceRightCollapseState {
  qsoCollapsed: boolean;
  keyerCollapsed: boolean;
  lastExpandedCard: VoiceRightExpandableCard;
}

export const createInitialVoiceRightCollapseState = (): VoiceRightCollapseState => ({
  qsoCollapsed: false,
  keyerCollapsed: true,
  lastExpandedCard: 'qso',
});

export function updateVoiceRightCardCollapse(
  state: VoiceRightCollapseState,
  card: VoiceRightExpandableCard,
  collapsed: boolean,
  mutualExclusionActive: boolean,
): VoiceRightCollapseState {
  if (card === 'qso') {
    return {
      qsoCollapsed: collapsed,
      keyerCollapsed: mutualExclusionActive && !collapsed ? true : state.keyerCollapsed,
      lastExpandedCard: collapsed ? state.lastExpandedCard : 'qso',
    };
  }

  return {
    qsoCollapsed: mutualExclusionActive && !collapsed ? true : state.qsoCollapsed,
    keyerCollapsed: collapsed,
    lastExpandedCard: collapsed ? state.lastExpandedCard : 'keyer',
  };
}

export function isVoiceRightMutualExclusionActive(
  heightLimited: boolean,
  lastLimitedHeight: number | null,
  currentHeight: number | null,
): boolean {
  if (heightLimited) {
    return true;
  }
  if (lastLimitedHeight === null || currentHeight === null) {
    return false;
  }
  return currentHeight <= lastLimitedHeight;
}

export function enforceVoiceRightHeightLimit(state: VoiceRightCollapseState): VoiceRightCollapseState {
  if (state.qsoCollapsed || state.keyerCollapsed) {
    return state;
  }

  if (state.lastExpandedCard === 'keyer') {
    return { ...state, qsoCollapsed: true };
  }

  return { ...state, keyerCollapsed: true };
}
