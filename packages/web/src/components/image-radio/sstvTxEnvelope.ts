import { estimateCWMessageDurationMs, type ImageSstvModeInfo, type SstvTxEnvelopeSelection } from '@tx5dr/contracts';

export function isSstvStationIdCallsignSupported(callsign: string): boolean {
  return /^[A-Z0-9/]{1,16}$/.test(callsign.trim().toUpperCase());
}

export function estimateSstvTxDurationSeconds(
  mode: ImageSstvModeInfo | undefined,
  callsign: string,
  envelope: SstvTxEnvelopeSelection,
): number {
  if (!mode) return 0;
  const normalizedCallsign = callsign.trim().toUpperCase();
  const rasterSeconds = mode.lineSeconds * mode.height / mode.rowsPerLine
    + (mode.scanLayout === 'scottie' ? 0.009 : 0);
  const stationIdSeconds = envelope.stationIdMode === 'none'
    ? 0
    : 0.5 + (envelope.stationIdMode === 'fsk'
      ? 0.522 + (normalizedCallsign.length + 3) * 0.132
      : estimateCWMessageDurationMs(normalizedCallsign, 20) / 1000);
  return Math.ceil(
    0.91
      + (envelope.enhancedPreamble ? 0.8 : 0)
      + rasterSeconds
      + stationIdSeconds
      + 0.3,
  );
}
