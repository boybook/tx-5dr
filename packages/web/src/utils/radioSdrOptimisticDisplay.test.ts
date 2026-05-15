import { describe, expect, it } from 'vitest';
import {
  RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE,
  chooseRadioSdrOptimisticBaselineFrequencyHz,
  confirmRadioSdrOptimisticDisplayStateWithFrame,
  createRadioSdrOptimisticDisplayPendingState,
  reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency,
  resolveRadioSdrOptimisticDisplayFrequencyHz,
} from './radioSdrOptimisticDisplay';

describe('radio SDR optimistic display state', () => {
  it('uses the target frequency immediately while an intent is pending', () => {
    const state = createRadioSdrOptimisticDisplayPendingState({
      targetFrequencyHz: 1_010_000,
      baselineFrequencyHz: 1_000_000,
      baselineFrameCenterHz: 1_000_000,
      sentAt: 100,
    });

    expect(resolveRadioSdrOptimisticDisplayFrequencyHz(state, 1_000_000)).toBe(1_010_000);
  });

  it('uses frame center as baseline when session frequency is stale', () => {
    const baseline = chooseRadioSdrOptimisticBaselineFrequencyHz({
      frameRange: { min: 999_000, max: 1_001_000 },
      currentRadioFrequencyHz: 900_000,
    });

    expect(baseline).toBe(1_000_000);
  });

  it('keeps pending target when stale session echoes arrive', () => {
    const state = createRadioSdrOptimisticDisplayPendingState({
      targetFrequencyHz: 1_020_000,
      baselineFrequencyHz: 1_000_000,
      baselineFrameCenterHz: 1_000_000,
      sentAt: 100,
    });

    const next = reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency(state, 1_000_000, 500);

    expect(next).toBe(state);
    expect(resolveRadioSdrOptimisticDisplayFrequencyHz(next, 1_000_000)).toBe(1_020_000);
  });

  it('lets the latest pending intent replace an older one', () => {
    const older = createRadioSdrOptimisticDisplayPendingState({
      targetFrequencyHz: 1_010_000,
      baselineFrequencyHz: 1_000_000,
      baselineFrameCenterHz: 1_000_000,
      sentAt: 100,
    });
    const latest = createRadioSdrOptimisticDisplayPendingState({
      targetFrequencyHz: 1_020_000,
      baselineFrequencyHz: 1_000_000,
      baselineFrameCenterHz: 1_000_000,
      sentAt: 150,
    });

    expect(resolveRadioSdrOptimisticDisplayFrequencyHz(older, 1_000_000)).toBe(1_010_000);
    expect(resolveRadioSdrOptimisticDisplayFrequencyHz(latest, 1_000_000)).toBe(1_020_000);
  });

  it('enters confirmed hold when a matching SDR frame arrives', () => {
    const state = createRadioSdrOptimisticDisplayPendingState({
      targetFrequencyHz: 1_020_000,
      baselineFrequencyHz: 1_000_000,
      baselineFrameCenterHz: 1_000_000,
      sentAt: 100,
    });

    const next = confirmRadioSdrOptimisticDisplayStateWithFrame(
      state,
      { min: 1_019_000, max: 1_021_000 },
      300,
      1000,
    );

    expect(next.status).toBe('confirmedHold');
    expect(resolveRadioSdrOptimisticDisplayFrequencyHz(next, 1_000_000)).toBe(1_020_000);
  });

  it('releases confirmed hold when session catches up', () => {
    const state = confirmRadioSdrOptimisticDisplayStateWithFrame(
      createRadioSdrOptimisticDisplayPendingState({
        targetFrequencyHz: 1_020_000,
        baselineFrequencyHz: 1_000_000,
        baselineFrameCenterHz: 1_000_000,
        sentAt: 100,
      }),
      { min: 1_019_000, max: 1_021_000 },
      300,
      1000,
    );

    const next = reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency(state, 1_020_010, 400);

    expect(next).toBe(RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE);
    expect(resolveRadioSdrOptimisticDisplayFrequencyHz(next, 1_020_010)).toBe(1_020_010);
  });

  it('falls back after pending or hold timeout', () => {
    const pending = createRadioSdrOptimisticDisplayPendingState({
      targetFrequencyHz: 1_020_000,
      baselineFrequencyHz: 1_000_000,
      baselineFrameCenterHz: 1_000_000,
      sentAt: 100,
      timeoutMs: 10,
    });
    const held = confirmRadioSdrOptimisticDisplayStateWithFrame(
      createRadioSdrOptimisticDisplayPendingState({
        targetFrequencyHz: 1_020_000,
        baselineFrequencyHz: 1_000_000,
        baselineFrameCenterHz: 1_000_000,
        sentAt: 100,
      }),
      { min: 1_019_000, max: 1_021_000 },
      300,
      10,
    );

    expect(reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency(pending, 1_000_000, 111)).toBe(RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE);
    expect(reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency(held, 1_000_000, 311)).toBe(RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE);
  });
});
