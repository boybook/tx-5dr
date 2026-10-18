import type { QSORecord } from '@tx5dr/contracts';
import { normalizeCallsign } from '@tx5dr/plugin-api';
import { getBandFromFrequency, toAdifMode } from '@tx5dr/core';

export function qsoIdentity(record: QSORecord, ownCallsign: string): string {
  return confirmationIdentity(record, ownCallsign, getBandFromFrequency(record.frequency));
}

/** ADIF spells FT8 as plain FT8 or as MFSK with an FT8 submode; both are one contact. */
function canonicalAdifMode(record: Pick<QSORecord, 'mode' | 'submode'>): { mode?: string; submode: string } {
  const projected = toAdifMode(record);
  const mode = projected.mode?.toUpperCase();
  const submode = projected.submode?.toUpperCase() || '';
  // Only the FT8 spelling is asymmetric today: FT4 already maps through MFSK/FT4 on
  // both sides, so rewriting it would invalidate existing checkpoint identities.
  if (mode === 'MFSK' && submode === 'FT8') return { mode: 'FT8', submode: '' };
  return { mode, submode: submode === mode ? '' : submode };
}

export function confirmationIdentity(record: Pick<QSORecord, 'myCallsign' | 'callsign' | 'startTime' | 'mode' | 'submode'>, ownCallsign: string, band: string): string {
  const mode = canonicalAdifMode(record);
  return JSON.stringify([normalizeCallsign(record.myCallsign || ownCallsign), record.callsign.trim().toUpperCase(),
    Math.floor(record.startTime / 1000), mode.mode, mode.submode, band.toUpperCase()]);
}

const LOTW_SENT_PRIORITY: Record<string, number> = {
  I: 1,
  N: 2,
  R: 3,
  Q: 4,
  Y: 5,
};

const LOTW_RECEIVED_PRIORITY: Record<string, number> = {
  I: 1,
  N: 2,
  R: 3,
  Y: 4,
  V: 5,
};

const QRZ_PRIORITY: Record<string, number> = {
  N: 1,
  Y: 2,
};

function mergeStatusValue<T extends string | undefined>(
  current: T,
  incoming: T,
  priority: Record<string, number>,
): T {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  return (priority[incoming] || 0) > (priority[current] || 0) ? incoming : current;
}

function mergeTimestampValue(current?: number, incoming?: number): number | undefined {
  if (!Number.isFinite(incoming)) {
    return current;
  }
  if (!Number.isFinite(current)) {
    return incoming;
  }
  return Math.max(current!, incoming!);
}

/**
 * Build a partial update that merges remote WaveLog QSL status into a local QSO.
 * Returns null when nothing would change.
 */
export function buildWavelogQslStatusUpdates(
  local: QSORecord,
  remote: QSORecord,
): Partial<QSORecord> | null {
  const updates: Partial<QSORecord> = {};

  // A date may be filled or advanced for the same status, never for a downgrade.
  const nextLotwSent = mergeStatusValue(local.lotwQslSent, remote.lotwQslSent, LOTW_SENT_PRIORITY);
  if (nextLotwSent && nextLotwSent === remote.lotwQslSent) {
    if (nextLotwSent !== local.lotwQslSent) updates.lotwQslSent = nextLotwSent;
    const nextLotwSentDate = mergeTimestampValue(local.lotwQslSentDate, remote.lotwQslSentDate);
    if (nextLotwSentDate !== local.lotwQslSentDate) {
      updates.lotwQslSentDate = nextLotwSentDate;
    }
  }

  const nextLotwReceived = mergeStatusValue(
    local.lotwQslReceived,
    remote.lotwQslReceived,
    LOTW_RECEIVED_PRIORITY,
  );
  if (nextLotwReceived && nextLotwReceived === remote.lotwQslReceived) {
    if (nextLotwReceived !== local.lotwQslReceived) updates.lotwQslReceived = nextLotwReceived;
    const nextLotwReceivedDate = mergeTimestampValue(
      local.lotwQslReceivedDate,
      remote.lotwQslReceivedDate,
    );
    if (nextLotwReceivedDate !== local.lotwQslReceivedDate) {
      updates.lotwQslReceivedDate = nextLotwReceivedDate;
    }
  }

  const nextQrzSent = mergeStatusValue(local.qrzQslSent, remote.qrzQslSent, QRZ_PRIORITY);
  if (nextQrzSent && nextQrzSent === remote.qrzQslSent) {
    if (nextQrzSent !== local.qrzQslSent) updates.qrzQslSent = nextQrzSent;
    const nextQrzSentDate = mergeTimestampValue(local.qrzQslSentDate, remote.qrzQslSentDate);
    if (nextQrzSentDate !== local.qrzQslSentDate) {
      updates.qrzQslSentDate = nextQrzSentDate;
    }
  }

  const nextQrzReceived = mergeStatusValue(local.qrzQslReceived, remote.qrzQslReceived, QRZ_PRIORITY);
  if (nextQrzReceived && nextQrzReceived === remote.qrzQslReceived) {
    if (nextQrzReceived !== local.qrzQslReceived) updates.qrzQslReceived = nextQrzReceived;
    const nextQrzReceivedDate = mergeTimestampValue(
      local.qrzQslReceivedDate,
      remote.qrzQslReceivedDate,
    );
    if (nextQrzReceivedDate !== local.qrzQslReceivedDate) {
      updates.qrzQslReceivedDate = nextQrzReceivedDate;
    }
  }

  return Object.keys(updates).length > 0 ? updates : null;
}
