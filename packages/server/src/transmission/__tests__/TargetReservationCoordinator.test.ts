import { describe, expect, it } from 'vitest';
import { TargetReservationCoordinator } from '../TargetReservationCoordinator.js';

describe('TargetReservationCoordinator', () => {
  it('atomically assigns one same-station operator per target', () => {
    const coordinator = new TargetReservationCoordinator();
    expect(coordinator.tryTransition({
      stationCallsign: 'BI7ALG', targetCallsign: 'BG4JLJ', operatorId: 'op-a', epoch: 1,
    })).toBe(true);
    expect(coordinator.tryTransition({
      stationCallsign: 'BI7ALG', targetCallsign: 'BG4JLJ', operatorId: 'op-b', epoch: 1,
    })).toBe(false);
    expect(coordinator.isReservedByOther('BI7ALG', 'BG4JLJ', 'op-b')).toBe(true);
  });

  it('does not let an old epoch release a newer reservation', () => {
    const coordinator = new TargetReservationCoordinator();
    coordinator.tryTransition({
      stationCallsign: 'BI7ALG', targetCallsign: 'BG4JLJ', operatorId: 'op-a', epoch: 2,
    });
    coordinator.releaseOperator('op-a', 1);
    expect(coordinator.isReservedByOther('BI7ALG', 'BG4JLJ', 'op-b')).toBe(true);
  });
});
