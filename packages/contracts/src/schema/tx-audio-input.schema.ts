import { z } from 'zod';

/** Normalized TX audio input routes used by the capability/profile layers. */
export const TxAudioInputSourceSchema = z.enum([
  'mic',
  'usb',
  'network',
  'accessory',
  'line',
  'spdif',
  'mic+usb',
  'mic+accessory',
]);
export type TxAudioInputSource = z.infer<typeof TxAudioInputSourceSchema>;

/** Profile policy. `auto` is resolved by the connection/provider. */
export const TxAudioInputSourcePolicySchema = z.enum([
  'auto',
  'unchanged',
  ...TxAudioInputSourceSchema.options,
]);
export type TxAudioInputSourcePolicy = z.infer<typeof TxAudioInputSourcePolicySchema>;
