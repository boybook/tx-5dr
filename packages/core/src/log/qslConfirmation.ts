import type { QSORecord } from '@tx5dr/contracts';

type QslReceivedFields = Pick<QSORecord, 'lotwQslReceived' | 'qrzQslReceived'>;

/**
 * Whether a QSO counts as confirmed for award tracking: a LoTW match
 * (received or verified) or a QRZ confirmation.
 */
export function isQsoConfirmed(qso: QslReceivedFields): boolean {
  return qso.lotwQslReceived === 'Y'
    || qso.lotwQslReceived === 'V'
    || qso.qrzQslReceived === 'Y';
}
