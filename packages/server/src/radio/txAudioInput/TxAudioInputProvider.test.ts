import { describe, expect, it } from 'vitest';
import {
  ICOM_CONNECTOR_SOURCE_MAP,
  TX_AUDIO_INPUT_SOURCE_OPTIONS,
  isIcomConnectorSourceSupported,
} from './TxAudioInputProvider.js';

describe('TX audio input provider vocabulary', () => {
  it('keeps the normalized options stable', () => {
    expect(TX_AUDIO_INPUT_SOURCE_OPTIONS).toEqual([
      'mic', 'usb', 'network', 'accessory', 'line', 'spdif',
    ]);
  });

  it('maps ICOM connector routes without conflating DATA mode', () => {
    expect(ICOM_CONNECTOR_SOURCE_MAP).toMatchObject({
      mic: 'MIC', accessory: 'ACC', usb: 'USB', network: 'WLAN',
    });
    expect(isIcomConnectorSourceSupported('usb')).toBe(true);
    expect(isIcomConnectorSourceSupported('line')).toBe(false);
  });
});
