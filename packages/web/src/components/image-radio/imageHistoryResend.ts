import type { ImageHistoryEntry, SstvTxEnvelopeSelection } from '@tx5dr/contracts';

export function canResendImageHistoryEntry(entry: ImageHistoryEntry, operatorId?: string): boolean {
  return Boolean(
    operatorId
    && entry.record.direction === 'tx'
    && entry.record.operatorId === operatorId
    && entry.record.outcome !== 'transmitting'
    && entry.artifact.family === 'sstv',
  );
}

export function historyEnvelopeSelection(
  entry: ImageHistoryEntry,
  fallback: SstvTxEnvelopeSelection,
): SstvTxEnvelopeSelection {
  const envelope = entry.record.direction === 'tx' ? entry.record.envelope : undefined;
  return {
    enhancedPreamble: envelope?.enhancedPreamble ?? fallback.enhancedPreamble,
    stationIdMode: envelope?.stationIdMode ?? fallback.stationIdMode,
  };
}
