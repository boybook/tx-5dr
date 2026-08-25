export function sstvTxErrorTranslationKey(errorCode?: string): string {
  const keys: Record<string, string> = {
    PHYSICAL_TX_BUSY: 'txBusy',
    IMAGE_FREQUENCY_CHANGED: 'txFrequencyChanged',
    IMAGE_NOT_IN_SSTV_MODE: 'txNotReady',
    IMAGE_MODE_INVALID: 'txInvalidMode',
    IMAGE_ARTIFACT_INVALID: 'txInvalidImage',
  };
  return errorCode ? keys[errorCode] ?? 'txRejected' : 'txRejected';
}
