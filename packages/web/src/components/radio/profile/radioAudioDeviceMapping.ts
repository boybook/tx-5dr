import type { AudioDevice, SupportedRig } from '@tx5dr/contracts';
import { FALLBACK_SAMPLE_RATE_OPTIONS } from './audioDeviceOptions';

/**
 * Recommended hardware sample rate by manufacturer.
 * Yaesu radios with built-in USB audio (TI PCM2902/PCM2904) only support 44.1kHz
 * on Linux/macOS. ICOM radios default to 48kHz.
 */
export const RIG_SAMPLE_RATE_MAP: Record<string, number> = {
  yaesu: 44100,
  icom: 48000,
};

/** USB audio device name patterns shared by Yaesu and ICOM */
export const USB_AUDIO_DEVICE_PATTERNS = ['USB Audio CODEC', 'PCM2902', 'PCM2904'];

/**
 * Resolve manufacturer and model info from the Hamlib rigs list.
 */
export function resolveRigInfo(
  rigModel: number,
  rigs: SupportedRig[],
): { mfgName: string; modelName: string } | null {
  const rig = rigs.find((r) => r.rigModel === rigModel);
  return rig ? { mfgName: rig.mfgName, modelName: rig.modelName } : null;
}

/**
 * Find a USB audio device from the device list by matching known patterns.
 * Returns the first match (user can manually switch if multiple exist).
 */
export function matchUsbAudioDevice(
  devices: AudioDevice[],
): AudioDevice | null {
  return (
    devices.find((device) =>
      USB_AUDIO_DEVICE_PATTERNS.some((pattern) =>
        device.name.includes(pattern),
      ),
    ) ?? null
  );
}

/**
 * Get the recommended sample rate for a given manufacturer name.
 * Returns null for unknown manufacturers (Kenwood, etc.) — user configures manually.
 */
export function getRecommendedSampleRate(mfgName: string): number | null {
  const key = mfgName.toLowerCase();
  return RIG_SAMPLE_RATE_MAP[key] ?? null;
}

/**
 * Select the best sample rate from the device's supported list.
 * If the recommended rate is available, use it; otherwise pick the closest.
 */
export function selectBestSampleRate(
  recommendedRate: number,
  supportedRates: number[],
): number {
  const rates =
    supportedRates.length > 0
      ? supportedRates
      : FALLBACK_SAMPLE_RATE_OPTIONS;

  if (rates.includes(recommendedRate)) {
    return recommendedRate;
  }

  // Pick the closest rate
  let closest = rates[0];
  let minDiff = Math.abs(recommendedRate - closest);
  for (let i = 1; i < rates.length; i++) {
    const diff = Math.abs(recommendedRate - rates[i]);
    if (diff < minDiff) {
      minDiff = diff;
      closest = rates[i];
    }
  }
  return closest;
}

/**
 * Result of the auto-match logic.
 */
export interface AudioMatchResult {
  deviceName: string;
  sampleRate: number;
}

/**
 * Full auto-match: given a rigModel, rigs list, and audio devices,
 * determine the recommended audio device + sample rate.
 * Returns null if no match is possible.
 */
export async function matchAudioDeviceForRig(
  rigModel: number,
  rigs: SupportedRig[],
  getDevices: () => Promise<{ inputDevices: AudioDevice[]; outputDevices: AudioDevice[] }>,
): Promise<AudioMatchResult | null> {
  const rigInfo = resolveRigInfo(rigModel, rigs);
  if (!rigInfo) return null;

  const recommendedRate = getRecommendedSampleRate(rigInfo.mfgName);
  if (recommendedRate === null) return null;

  const { inputDevices, outputDevices } = await getDevices();
  const allDevices = [...inputDevices, ...outputDevices];
  const matchedDevice = matchUsbAudioDevice(allDevices);
  if (!matchedDevice) return null;

  const rate = selectBestSampleRate(
    recommendedRate,
    matchedDevice.sampleRates ?? [],
  );

  return {
    deviceName: matchedDevice.name,
    sampleRate: rate,
  };
}
