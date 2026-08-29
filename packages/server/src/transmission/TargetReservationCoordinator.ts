import { normalizeCallsign } from '../utils/callsign.js';

interface TargetReservation {
  stationCallsign: string;
  targetCallsign: string;
  operatorId: string;
  epoch: number;
  streamId: string;
}

function normalize(value: string): string {
  const upper = value.trim().toUpperCase();
  return normalizeCallsign(upper) || upper;
}

/** Atomic in-process ownership for targets shared by same-callsign operators. */
export class TargetReservationCoordinator {
  private readonly reservations = new Map<string, TargetReservation>();

  isReservedByOther(stationCallsign: string, targetCallsign: string, operatorId: string): boolean {
    const reservation = this.reservations.get(this.key(stationCallsign, targetCallsign));
    return Boolean(reservation && reservation.operatorId !== operatorId);
  }

  tryTransition(input: {
    stationCallsign: string;
    targetCallsign?: string;
    operatorId: string;
    epoch: number;
  }): boolean {
    return this.tryReplaceOperatorTargets({
      stationCallsign: input.stationCallsign,
      targets: input.targetCallsign ? [{ streamId: 'default', targetCallsign: input.targetCallsign }] : [],
      operatorId: input.operatorId,
      epoch: input.epoch,
    });
  }

  tryReplaceOperatorTargets(input: {
    stationCallsign: string;
    targets: Array<{ streamId: string; targetCallsign: string }>;
    operatorId: string;
    epoch: number;
  }): boolean {
    const stationCallsign = normalize(input.stationCallsign);
    if (!stationCallsign) return false;
    const targets = input.targets.map((target) => ({
      streamId: target.streamId.trim(),
      targetCallsign: normalize(target.targetCallsign),
    }));
    if (targets.some((target) => !target.streamId || !target.targetCallsign)) return false;
    const targetKeys = new Set(targets.map((target) => this.key(stationCallsign, target.targetCallsign)));
    if (targetKeys.size !== targets.length) return false;

    for (const reservation of this.reservations.values()) {
      if (reservation.stationCallsign === stationCallsign
          && reservation.operatorId === input.operatorId
          && reservation.epoch > input.epoch) {
        return false;
      }
    }

    for (const targetKey of targetKeys) {
      const current = this.reservations.get(targetKey);
      if (current && current.operatorId !== input.operatorId) return false;
    }

    for (const [key, reservation] of this.reservations) {
      if (reservation.stationCallsign !== stationCallsign
          || reservation.operatorId !== input.operatorId
          || reservation.epoch > input.epoch) {
        continue;
      }
      if (!targetKeys.has(key)) {
        this.reservations.delete(key);
      }
    }

    for (const target of targets) {
      this.reservations.set(this.key(stationCallsign, target.targetCallsign), {
        stationCallsign,
        targetCallsign: target.targetCallsign,
        operatorId: input.operatorId,
        epoch: input.epoch,
        streamId: target.streamId,
      });
    }
    return true;
  }

  releaseOperator(operatorId: string, epoch = Number.MAX_SAFE_INTEGER): void {
    for (const [key, reservation] of this.reservations) {
      if (reservation.operatorId === operatorId && reservation.epoch <= epoch) {
        this.reservations.delete(key);
      }
    }
  }

  clear(): void {
    this.reservations.clear();
  }

  private key(stationCallsign: string, targetCallsign: string): string {
    return `${normalize(stationCallsign)}\0${normalize(targetCallsign)}`;
  }
}
