import { normalizeCallsign } from '../utils/callsign.js';

interface TargetReservation {
  stationCallsign: string;
  targetCallsign: string;
  operatorId: string;
  epoch: number;
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
    const stationCallsign = normalize(input.stationCallsign);
    const targetCallsign = input.targetCallsign ? normalize(input.targetCallsign) : '';
    if (!stationCallsign) return false;

    if (targetCallsign) {
      const targetKey = this.key(stationCallsign, targetCallsign);
      const current = this.reservations.get(targetKey);
      if (current && current.operatorId !== input.operatorId) return false;
    }

    for (const [key, reservation] of this.reservations) {
      if (reservation.stationCallsign !== stationCallsign
          || reservation.operatorId !== input.operatorId
          || reservation.epoch > input.epoch) {
        continue;
      }
      if (!targetCallsign || reservation.targetCallsign !== targetCallsign) {
        this.reservations.delete(key);
      }
    }

    if (targetCallsign) {
      this.reservations.set(this.key(stationCallsign, targetCallsign), {
        stationCallsign,
        targetCallsign,
        operatorId: input.operatorId,
        epoch: input.epoch,
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
