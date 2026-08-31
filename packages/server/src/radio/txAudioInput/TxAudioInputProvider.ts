import type { TxAudioInputSource } from '@tx5dr/contracts';

/**
 * Model-neutral route vocabulary. Protocol adapters translate these values to
 * vendor commands; callers never need to know CI-V/CAT details.
 */
export const TX_AUDIO_INPUT_SOURCE_OPTIONS: TxAudioInputSource[] = [
  'mic', 'usb', 'network', 'accessory', 'line', 'spdif',
];

export const ICOM_CONNECTOR_SOURCE_MAP: Partial<Record<TxAudioInputSource, 'MIC' | 'ACC' | 'USB' | 'WLAN'>> = {
  mic: 'MIC',
  accessory: 'ACC',
  usb: 'USB',
  network: 'WLAN',
};

export function isIcomConnectorSourceSupported(source: TxAudioInputSource): source is 'mic' | 'accessory' | 'usb' | 'network' {
  return ICOM_CONNECTOR_SOURCE_MAP[source] !== undefined;
}
