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

  it('rejects a stale target-set replacement without adding ghost reservations', () => {
    const coordinator = new TargetReservationCoordinator();
    expect(coordinator.tryReplaceOperatorTargets({
      stationCallsign: 'BI7ALG',
      operatorId: 'op-a',
      epoch: 3,
      targets: [{ streamId: 'stream-1', targetCallsign: 'JA1AAA' }],
    })).toBe(true);

    expect(coordinator.tryReplaceOperatorTargets({
      stationCallsign: 'BI7ALG',
      operatorId: 'op-a',
      epoch: 2,
      targets: [{ streamId: 'stream-2', targetCallsign: 'K1BBB' }],
    })).toBe(false);

    expect(coordinator.isReservedByOther('BI7ALG', 'JA1AAA', 'op-b')).toBe(true);
    expect(coordinator.isReservedByOther('BI7ALG', 'K1BBB', 'op-b')).toBe(false);
    coordinator.releaseOperator('op-a', 2);
    expect(coordinator.isReservedByOther('BI7ALG', 'JA1AAA', 'op-b')).toBe(true);
  });

  it('rejects a conflicting target set atomically without dropping or partially acquiring targets', () => {
    const coordinator = new TargetReservationCoordinator();
    expect(coordinator.tryReplaceOperatorTargets({
      stationCallsign: 'BI7ALG',
      operatorId: 'op-a',
      epoch: 1,
      targets: [
        { streamId: 'lane-1', targetCallsign: 'JA1AAA' },
        { streamId: 'lane-2', targetCallsign: 'K1BBB' },
        { streamId: 'lane-3', targetCallsign: 'VK2CCC' },
      ],
    })).toBe(true);
    expect(coordinator.tryReplaceOperatorTargets({
      stationCallsign: 'BI7ALG',
      operatorId: 'op-b',
      epoch: 1,
      targets: [{ streamId: 'default', targetCallsign: 'DL1DDD' }],
    })).toBe(true);

    expect(coordinator.tryReplaceOperatorTargets({
      stationCallsign: 'BI7ALG',
      operatorId: 'op-b',
      epoch: 2,
      targets: [
        { streamId: 'lane-1', targetCallsign: 'F1EEE' },
        { streamId: 'lane-2', targetCallsign: 'K1BBB' },
      ],
    })).toBe(false);

    expect(coordinator.isReservedByOther('BI7ALG', 'DL1DDD', 'op-c')).toBe(true);
    expect(coordinator.isReservedByOther('BI7ALG', 'F1EEE', 'op-c')).toBe(false);
    expect(coordinator.isReservedByOther('BI7ALG', 'JA1AAA', 'op-c')).toBe(true);
    expect(coordinator.isReservedByOther('BI7ALG', 'K1BBB', 'op-b')).toBe(true);
    expect(coordinator.isReservedByOther('BI7ALG', 'VK2CCC', 'op-c')).toBe(true);
  });
});
