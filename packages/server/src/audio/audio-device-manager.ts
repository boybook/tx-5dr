/* eslint-disable @typescript-eslint/no-explicit-any */
// AudioDeviceManager - 设备枚举

import { AudioDevice, type AudioDeviceResolution, type AudioDeviceResolutionSet, type AudioDeviceSettings } from '@tx5dr/contracts';
import { createRtAudioInstance, describeConfiguredRtAudioBackend, type RtAudioInstance } from './rtaudio-api.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';
import {
  androidDescriptorToAudioDevice,
  getAndroidAudioDevices,
  isAndroidAudioDeviceId,
  isAndroidBridgeRuntime,
  isLegacyAndroidAudioDeviceName,
  resolveAndroidAudioDevice,
  type AndroidAudioDeviceDescriptor,
  type AndroidAudioDirection,
} from './android-audio-devices.js';
import {
  assignBusyIdentitiesToActiveDevices,
  attachLinuxUsbAudioIdentities,
  buildSupplementalUsbAudioDevices,
  dedupeAudioDevicesByHardwareId,
  discoverLinuxUsbAudioIdentities,
  identityToFields,
  looksLikeUsbAudioDeviceName,
} from './linux-usb-audio-identity.js';

const logger = createLogger('AudioDeviceManager');
type RadioType = 'none' | 'network' | 'serial' | 'icom-wlan' | 'tci';
type AudioDirection = 'input' | 'output';
type AudioDeviceAvailability = 'available' | 'cached' | 'active';

type RegisteredAudioDevice = AudioDevice & {
  availability: AudioDeviceAvailability;
  isActiveByTx5dr: boolean;
  lastSeenAt?: number;
  lastRtAudioId?: string;
};

type StreamDeviceResolution = {
  actualDeviceId: number;
  persistedDeviceId: string;
  deviceName: string;
  hardwareId?: string;
};

const RTAUDIO_BUFFER_SIZE_OPTIONS = [128, 256, 512, 768, 1024, 2048, 4096];
const FALLBACK_SAMPLE_RATES = [8000, 12000, 16000, 22050, 24000, 44100, 48000, 96000];

// 音频设备管理器
export class AudioDeviceManager {
  private static instance: AudioDeviceManager;
  private icomWlanConnectedCallback: (() => boolean) | null = null;
  private tciConnectedCallback: (() => boolean) | null = null;
  private readonly deviceRegistry: Record<AudioDirection, Map<string, RegisteredAudioDevice>> = {
    input: new Map(),
    output: new Map(),
  };
  private registryInitialized = false;
  private refreshInFlight: Promise<void> | null = null;

  private constructor() {
    logger.info('Audify (RtAudio) audio enumeration initialized', {
      api: describeConfiguredRtAudioBackend(),
    });
  }

  static getInstance(): AudioDeviceManager {
    if (!AudioDeviceManager.instance) {
      AudioDeviceManager.instance = new AudioDeviceManager();
    }
    return AudioDeviceManager.instance;
  }

  /**
   * 设置 ICOM WLAN 连接状态检查回调
   */
  setIcomWlanConnectedCallback(callback: () => boolean): void {
    this.icomWlanConnectedCallback = callback;
  }

  /**
   * 设置 TCI 连接状态检查回调
   */
  setTciConnectedCallback(callback: () => boolean): void {
    this.tciConnectedCallback = callback;
  }

  async initializeDeviceRegistry(): Promise<void> {
    if (this.registryInitialized) {
      return;
    }

    await this.refreshDeviceRegistry();
    this.registryInitialized = true;
  }

  private getDeviceKey(direction: AudioDirection, deviceId: string): string {
    return `${direction}:${deviceId}`;
  }

  private toPublicDevice(device: RegisteredAudioDevice): AudioDevice {
    const {
      lastRtAudioId: _lastRtAudioId,
      ...publicDevice
    } = device;
    return { ...publicDevice };
  }

  private parseNumericDeviceId(deviceId: string | undefined): number | null {
    if (!deviceId) return null;
    if (deviceId.includes('usb:')) return null;
    const normalized = deviceId.replace(/^(input|output)-/, '');
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private extractHardwareId(deviceId?: string, hardwareId?: string): string | undefined {
    if (hardwareId) return hardwareId;
    if (!deviceId) return undefined;
    const match = deviceId.match(/usb:[^/#]+/);
    return match?.[0];
  }

  private fallbackDevice(direction: AudioDirection): AudioDevice {
    return {
      id: `${direction}-fallback`,
      name: direction === 'input' ? 'Default input device (fallback)' : 'Default output device (fallback)',
      isDefault: true,
      channels: direction === 'input' ? 1 : 2,
      sampleRate: 48000,
      sampleRates: FALLBACK_SAMPLE_RATES,
      type: direction,
      availability: 'available',
      isActiveByTx5dr: false,
      lastSeenAt: Date.now(),
    };
  }

  private createRegisteredSnapshot(direction: AudioDirection): AudioDevice[] {
    const androidDevices = getAndroidAudioDevices(direction).map(androidDescriptorToAudioDevice);
    const devicesById = new Map(androidDevices.map((device) => [device.id, device]));
    const devices = [...androidDevices];

    for (const registered of this.deviceRegistry[direction].values()) {
      const publicDevice = this.toPublicDevice(registered);
      const manifestDevice = devicesById.get(publicDevice.id);
      if (isAndroidAudioDeviceId(publicDevice.id) && manifestDevice) {
        if (publicDevice.isActiveByTx5dr || publicDevice.availability === 'active') {
          Object.assign(manifestDevice, {
            availability: publicDevice.availability,
            isActiveByTx5dr: publicDevice.isActiveByTx5dr,
            lastSeenAt: publicDevice.lastSeenAt,
          });
        }
        continue;
      }
      devices.push(publicDevice);
    }

    const identities = discoverLinuxUsbAudioIdentities();
    // Re-label TX5DR-owned busy cards (RtAudio hides them while open).
    const reconciled = assignBusyIdentitiesToActiveDevices(devices, identities);
    for (let index = 0; index < devices.length; index++) {
      const enriched = reconciled[index];
      if (!enriched) continue;
      devices[index] = { ...devices[index], ...enriched };
      const registered = this.deviceRegistry[direction].get(this.getDeviceKey(direction, devices[index].id));
      if (registered && enriched.hardwareId) {
        Object.assign(registered, {
          hardwareId: enriched.hardwareId,
          detail: enriched.detail,
          vendorId: enriched.vendorId,
          productId: enriched.productId,
          serialNumber: enriched.serialNumber,
          usbPath: enriched.usbPath,
          alsaCard: enriched.alsaCard,
          alsaCardId: enriched.alsaCardId,
        });
      }
    }

    const existingHardwareIds = new Set(
      devices.map((device) => device.hardwareId).filter((id): id is string => Boolean(id)),
    );
    devices.push(...buildSupplementalUsbAudioDevices(direction, existingHardwareIds, identities));

    const deduped = dedupeAudioDevicesByHardwareId(devices);

    if (deduped.length === 0) {
      deduped.push(this.fallbackDevice(direction));
    }

    if (direction === 'input') {
      if (this.shouldShowIcomWlanDevice()) {
        deduped.unshift(this.createIcomWlanDevice('input'));
      }
      if (this.shouldShowTciDevice()) {
        deduped.unshift(this.createTciDevice('input'));
      }

      const openwebrxDevices = this.getOpenWebRXVirtualDevices();
      if (openwebrxDevices.length > 0) {
        deduped.push(...openwebrxDevices);
      }
    } else {
      if (this.shouldShowIcomWlanDevice()) {
        deduped.unshift(this.createIcomWlanDevice('output'));
      }
      if (this.shouldShowTciDevice()) {
        deduped.unshift(this.createTciDevice('output'));
      }
    }

    return deduped;
  }

  /**
   * RtAudio numeric ids are unstable: opening a USB codec often makes ALSA reuse
   * that index for an unrelated device (e.g. HDMI) or the other identical CODEC.
   * Only treat devices as the same physical endpoint when hardwareIds match.
   */
  private isCompatibleLiveDevice(
    existing: RegisteredAudioDevice,
    liveDevice: AudioDevice,
  ): boolean {
    if (existing.hardwareId && liveDevice.hardwareId) {
      return existing.hardwareId === liveDevice.hardwareId;
    }
    // Same product name (ICOM "USB Audio CODEC") must not imply same radio.
    if (
      looksLikeUsbAudioDeviceName(existing.name)
      || looksLikeUsbAudioDeviceName(liveDevice.name)
    ) {
      return false;
    }
    return existing.name === liveDevice.name;
  }

  private relocateActiveDevice(
    direction: AudioDirection,
    existing: RegisteredAudioDevice,
  ): void {
    const stableId = existing.hardwareId
      ? `${direction}-${existing.hardwareId}`
      : `${existing.id}__held`;
    if (stableId === existing.id) {
      return;
    }
    this.deviceRegistry[direction].delete(this.getDeviceKey(direction, existing.id));
    this.deviceRegistry[direction].set(this.getDeviceKey(direction, stableId), {
      ...existing,
      id: stableId,
      availability: 'active',
      isActiveByTx5dr: true,
    });
  }

  private mergeLiveDevices(inputDevices: AudioDevice[], outputDevices: AudioDevice[], observedAt: number): void {
    const liveDevices: Record<AudioDirection, AudioDevice[]> = {
      input: inputDevices,
      output: outputDevices,
    };

    for (const direction of ['input', 'output'] as const) {
      for (const registered of this.deviceRegistry[direction].values()) {
        if (!registered.isActiveByTx5dr) {
          registered.availability = 'cached';
          registered.isActiveByTx5dr = false;
        }
      }

      for (const liveDevice of liveDevices[direction]) {
        const key = this.getDeviceKey(direction, liveDevice.id);
        let existing = this.deviceRegistry[direction].get(key);
        if (existing && !this.isCompatibleLiveDevice(existing, liveDevice)) {
          if (existing.isActiveByTx5dr) {
            this.relocateActiveDevice(direction, existing);
          } else {
            this.deviceRegistry[direction].delete(key);
          }
          existing = undefined;
        }
        if (!existing && liveDevice.hardwareId) {
          const byHardware = this.findRegisteredDeviceByHardwareId(direction, liveDevice.hardwareId);
          if (byHardware && this.isCompatibleLiveDevice(byHardware, liveDevice)) {
            existing = byHardware;
          }
        }
        const isActive = existing?.isActiveByTx5dr === true;
        // Drop stale duplicates if an older registry entry moved IDs.
        if (existing && existing.id !== liveDevice.id) {
          this.deviceRegistry[direction].delete(this.getDeviceKey(direction, existing.id));
        }
        const keepUsbIdentity = Boolean(
          liveDevice.hardwareId
          || (isActive && existing?.hardwareId && looksLikeUsbAudioDeviceName(liveDevice.name)),
        );
        this.deviceRegistry[direction].set(key, {
          id: liveDevice.id,
          name: liveDevice.name,
          isDefault: liveDevice.isDefault,
          channels: liveDevice.channels,
          sampleRate: liveDevice.sampleRate,
          ...(liveDevice.sampleRates ? { sampleRates: liveDevice.sampleRates } : {}),
          type: liveDevice.type,
          ...(keepUsbIdentity
            ? {
                hardwareId: liveDevice.hardwareId ?? existing?.hardwareId,
                detail: liveDevice.detail ?? existing?.detail,
                vendorId: liveDevice.vendorId ?? existing?.vendorId,
                productId: liveDevice.productId ?? existing?.productId,
                serialNumber: liveDevice.serialNumber ?? existing?.serialNumber,
                usbPath: liveDevice.usbPath ?? existing?.usbPath,
                alsaCard: liveDevice.alsaCard ?? existing?.alsaCard,
                alsaCardId: liveDevice.alsaCardId ?? existing?.alsaCardId,
              }
            : {}),
          availability: isActive ? 'active' : 'available',
          isActiveByTx5dr: isActive,
          lastSeenAt: observedAt,
          lastRtAudioId: liveDevice.id,
        });
      }
    }
  }

  private enumeratePhysicalDevicesFromRaw(rawDevices: any[]): {
    inputDevices: AudioDevice[];
    outputDevices: AudioDevice[];
  } {
    const inputDevices = attachLinuxUsbAudioIdentities(
      rawDevices
        .filter((device: any) => device.inputChannels && device.inputChannels > 0)
        .map((device: any) => this.convertAudifyDevice(device, 'input', Boolean(device.isDefaultInput))),
    );
    const outputDevices = attachLinuxUsbAudioIdentities(
      rawDevices
        .filter((device: any) => device.outputChannels && device.outputChannels > 0)
        .map((device: any) => this.convertAudifyDevice(device, 'output', Boolean(device.isDefaultOutput))),
    );

    return { inputDevices, outputDevices };
  }

  private async refreshDeviceRegistry(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = Promise.resolve().then(() => {
      const observedAt = Date.now();
      logger.debug('Refreshing audio device registry');
      const rawDevices = this.getRtAudioDevices();
      logger.debug(`Audify returned ${rawDevices.length} devices`);
      rawDevices.forEach((device: any, index: number) => {
        logger.debug(`Device ${index}: id=${device.id}, name=${device.name}, inputCh=${device.inputChannels}, outputCh=${device.outputChannels}, sampleRate=${device.preferredSampleRate}`);
      });

      const { inputDevices, outputDevices } = this.enumeratePhysicalDevicesFromRaw(rawDevices);
      this.mergeLiveDevices(inputDevices, outputDevices, observedAt);
      logger.debug('Audio device registry refreshed', {
        inputDevices: this.deviceRegistry.input.size,
        outputDevices: this.deviceRegistry.output.size,
      });
    }).catch((error) => {
      logger.error('Failed to refresh audio device registry', error);
    }).finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  private async observeRtAudioInstance(rtAudio: RtAudioInstance): Promise<{
    inputDevices: AudioDevice[];
    outputDevices: AudioDevice[];
  }> {
    const observedAt = Date.now();
    const rawDevices = rtAudio.getDevices();
    const liveDevices = this.enumeratePhysicalDevicesFromRaw(rawDevices);
    this.mergeLiveDevices(liveDevices.inputDevices, liveDevices.outputDevices, observedAt);
    this.registryInitialized = true;
    return liveDevices;
  }

  private findRegisteredDeviceById(direction: AudioDirection, deviceId: string): RegisteredAudioDevice | null {
    return this.deviceRegistry[direction].get(this.getDeviceKey(direction, deviceId)) ?? null;
  }

  private findRegisteredDeviceByHardwareId(
    direction: AudioDirection,
    hardwareId: string | undefined,
  ): RegisteredAudioDevice | null {
    if (!hardwareId) return null;
    for (const device of this.deviceRegistry[direction].values()) {
      if (device.hardwareId === hardwareId) {
        return device;
      }
    }
    return null;
  }

  private findRegisteredDeviceByName(direction: AudioDirection, deviceName: string): RegisteredAudioDevice | null {
    for (const device of this.deviceRegistry[direction].values()) {
      if (device.name === deviceName) {
        return device;
      }
    }
    return null;
  }

  private findDevicesByName(devices: AudioDevice[], deviceName: string): AudioDevice[] {
    return devices.filter((device) => device.name === deviceName);
  }

  private findConfiguredDevice(
    devices: AudioDevice[],
    params: {
      configuredDeviceId?: string | null;
      configuredHardwareId?: string | null;
      configuredDeviceName?: string | null;
    },
  ): AudioDevice | null {
    const { configuredDeviceId, configuredHardwareId, configuredDeviceName } = params;

    if (configuredHardwareId) {
      const byHardwareId = devices.find((device) => device.hardwareId === configuredHardwareId);
      if (byHardwareId) return byHardwareId;
    }

    if (configuredDeviceId) {
      const byId = devices.find((device) => device.id === configuredDeviceId);
      if (byId) return byId;
    }

    if (!configuredDeviceName) {
      return null;
    }

    const byName = this.findDevicesByName(devices, configuredDeviceName);
    if (byName.length === 1) {
      return byName[0];
    }
    if (byName.length > 1) {
      // Legacy profiles only stored the name. Keep deterministic first-match
      // so existing setups keep working until the user re-saves with an id.
      return byName[0];
    }
    return null;
  }

  private findDefaultDevice(devices: AudioDevice[]): AudioDevice | null {
    return devices.find((device) => device.isDefault && device.availability !== 'cached')
      ?? devices.find((device) => device.availability !== 'cached')
      ?? null;
  }

  private createUnavailableConfiguredDeviceError(direction: AudioDirection, deviceName: string, availability?: AudioDeviceAvailability): RadioError {
    return this.createMissingConfiguredDeviceError(direction, deviceName, availability);
  }

  async resolveInputDeviceForStream(
    deviceName: string | undefined,
    rtAudio: RtAudioInstance,
    requestedDeviceId?: string,
    requestedHardwareId?: string,
  ): Promise<StreamDeviceResolution> {
    if (isAndroidAudioDeviceId(requestedDeviceId) || deviceName?.startsWith('[Android]') || (isAndroidBridgeRuntime() && isLegacyAndroidAudioDeviceName('input', deviceName))) {
      const device = this.resolveAndroidDeviceOrThrow(
        'input',
        isLegacyAndroidAudioDeviceName('input', deviceName) ? undefined : deviceName,
        requestedDeviceId,
      );
      return { actualDeviceId: -1, persistedDeviceId: device.id, deviceName: device.name };
    }
    return this.resolveDeviceForStream('input', deviceName, rtAudio, requestedDeviceId, requestedHardwareId);
  }

  async resolveOutputDeviceForStream(
    deviceName: string | undefined,
    rtAudio: RtAudioInstance,
    requestedDeviceId?: string,
    requestedHardwareId?: string,
  ): Promise<StreamDeviceResolution> {
    if (isAndroidAudioDeviceId(requestedDeviceId) || deviceName?.startsWith('[Android]') || (isAndroidBridgeRuntime() && isLegacyAndroidAudioDeviceName('output', deviceName))) {
      const device = this.resolveAndroidDeviceOrThrow(
        'output',
        isLegacyAndroidAudioDeviceName('output', deviceName) ? undefined : deviceName,
        requestedDeviceId,
      );
      return { actualDeviceId: -1, persistedDeviceId: device.id, deviceName: device.name };
    }
    return this.resolveDeviceForStream('output', deviceName, rtAudio, requestedDeviceId, requestedHardwareId);
  }

  resolveAndroidDeviceForStream(
    direction: AndroidAudioDirection,
    deviceName?: string,
    requestedDeviceId?: string,
  ): AndroidAudioDeviceDescriptor | null {
    return resolveAndroidAudioDevice(direction, deviceName, requestedDeviceId);
  }

  private resolveAndroidDeviceOrThrow(
    direction: AndroidAudioDirection,
    deviceName?: string,
    requestedDeviceId?: string,
  ): AndroidAudioDeviceDescriptor {
    const device = resolveAndroidAudioDevice(direction, deviceName, requestedDeviceId);
    if (!device) {
      throw this.createUnavailableConfiguredDeviceError(direction, deviceName ?? requestedDeviceId ?? `Android ${direction} device`);
    }
    return device;
  }

  private async resolveDeviceForStream(
    direction: AudioDirection,
    deviceName: string | undefined,
    rtAudio: RtAudioInstance,
    requestedDeviceId?: string,
    requestedHardwareId?: string,
  ): Promise<StreamDeviceResolution> {
    const liveDevices = await this.observeRtAudioInstance(rtAudio);
    const directionalLiveDevices = direction === 'input' ? liveDevices.inputDevices : liveDevices.outputDevices;
    const hardwareId = this.extractHardwareId(requestedDeviceId, requestedHardwareId);
    const requestedNumericId = this.parseNumericDeviceId(requestedDeviceId);

    if (hardwareId) {
      const byHardwareId = directionalLiveDevices.find((device) => device.hardwareId === hardwareId);
      if (byHardwareId) {
        const actualDeviceId = this.parseNumericDeviceId(byHardwareId.id);
        if (actualDeviceId !== null) {
          return {
            actualDeviceId,
            persistedDeviceId: byHardwareId.id,
            deviceName: byHardwareId.name,
            hardwareId,
          };
        }
      }

      // Opposite direction may already own this USB radio (e.g. capture open on
      // IC-7610 while playback starts). Live listing often drops or mis-orders the
      // busy card, so reuse the numeric RtAudio id we opened / registered earlier.
      const registeredSameDirection = this.findRegisteredDeviceByHardwareId(direction, hardwareId);
      const registeredOtherDirection = this.findRegisteredDeviceByHardwareId(
        direction === 'input' ? 'output' : 'input',
        hardwareId,
      );
      const registered = registeredSameDirection ?? registeredOtherDirection;
      const cachedNumericId = this.parseNumericDeviceId(
        registered?.lastRtAudioId ?? registered?.id,
      );
      if (cachedNumericId !== null) {
        const liveByCachedId = directionalLiveDevices.find(
          (device) => this.parseNumericDeviceId(device.id) === cachedNumericId,
        );
        if (liveByCachedId) {
          return {
            actualDeviceId: cachedNumericId,
            persistedDeviceId: liveByCachedId.id,
            deviceName: liveByCachedId.name || registered?.name || deviceName || hardwareId,
            hardwareId,
          };
        }

        const rawDevices = rtAudio.getDevices();
        const rawStillPresent = rawDevices.some((device: { id?: number }) => device.id === cachedNumericId);
        if (rawStillPresent || registeredOtherDirection?.isActiveByTx5dr) {
          logger.info('Resolving USB audio via registry cache for busy hardwareId', {
            direction,
            hardwareId,
            cachedNumericId,
            rawStillPresent,
            fromOtherDirection: Boolean(registeredOtherDirection?.isActiveByTx5dr),
          });
          return {
            actualDeviceId: cachedNumericId,
            persistedDeviceId: registered?.id ?? `${direction}-${cachedNumericId}`,
            deviceName: registered?.name || deviceName || hardwareId,
            hardwareId,
          };
        }
      }

      const identities = discoverLinuxUsbAudioIdentities();
      const identity = identities.find((item) => item.hardwareId === hardwareId);
      const label = identity?.relatedRadioLabel || identity?.detail || hardwareId;
      throw this.createUnavailableConfiguredDeviceError(
        direction,
        deviceName || label,
        identity?.pcmBusy ? 'cached' : undefined,
      );
    }

    if (requestedNumericId !== null) {
      const requestedLiveDevice = directionalLiveDevices.find((device) => this.parseNumericDeviceId(device.id) === requestedNumericId);
      if (requestedLiveDevice && (!deviceName || requestedLiveDevice.name === deviceName)) {
        return {
          actualDeviceId: requestedNumericId,
          persistedDeviceId: requestedLiveDevice.id,
          deviceName: requestedLiveDevice.name,
          hardwareId: requestedLiveDevice.hardwareId,
        };
      }
    }

    if (requestedDeviceId) {
      const byExactId = directionalLiveDevices.find((device) => device.id === requestedDeviceId);
      if (byExactId) {
        const actualDeviceId = this.parseNumericDeviceId(byExactId.id);
        if (actualDeviceId !== null) {
          return {
            actualDeviceId,
            persistedDeviceId: byExactId.id,
            deviceName: byExactId.name,
            hardwareId: byExactId.hardwareId,
          };
        }
      }
    }

    if (deviceName) {
      const namedDevices = this.findDevicesByName(directionalLiveDevices, deviceName);
      const liveDevice = namedDevices.length === 1
        ? namedDevices[0]
        : (namedDevices.find((device) => device.id === requestedDeviceId) ?? namedDevices[0]);
      if (liveDevice) {
        const actualDeviceId = this.parseNumericDeviceId(liveDevice.id);
        if (actualDeviceId !== null) {
          return {
            actualDeviceId,
            persistedDeviceId: liveDevice.id,
            deviceName: liveDevice.name,
            hardwareId: liveDevice.hardwareId,
          };
        }
      }

      const registeredDevice = this.findRegisteredDeviceByHardwareId(direction, hardwareId)
        ?? (requestedDeviceId ? this.findRegisteredDeviceById(direction, requestedDeviceId) : null)
        ?? this.findRegisteredDeviceByName(direction, deviceName);
      throw this.createUnavailableConfiguredDeviceError(direction, deviceName, registeredDevice?.availability);
    }

    const defaultDevice = this.findDefaultDevice(directionalLiveDevices);
    const defaultDeviceId = defaultDevice
      ? this.parseNumericDeviceId(defaultDevice.id)
      : (direction === 'input' ? rtAudio.getDefaultInputDevice() : rtAudio.getDefaultOutputDevice());

    if (defaultDeviceId === null || defaultDeviceId === undefined) {
      throw this.createUnavailableConfiguredDeviceError(direction, direction === 'input' ? 'default input device' : 'default output device');
    }

    return {
      actualDeviceId: defaultDeviceId,
      persistedDeviceId: defaultDevice?.id ?? `${direction}-${defaultDeviceId}`,
      deviceName: defaultDevice?.name ?? (direction === 'input' ? 'Default audio input device' : 'Default audio output device'),
      hardwareId: defaultDevice?.hardwareId,
    };
  }

  markDeviceActive(
    direction: AudioDirection,
    deviceName: string | undefined,
    deviceId: string | undefined,
    sampleRate: number,
    channels: number,
    hardwareId?: string,
  ): void {
    if (!deviceName || !deviceId) {
      return;
    }

    const key = this.getDeviceKey(direction, deviceId);
    const existing = this.deviceRegistry[direction].get(key)
      ?? this.findRegisteredDeviceByHardwareId(direction, hardwareId)
      ?? undefined;
    const resolvedHardwareId = hardwareId ?? existing?.hardwareId;
    const identityFields = resolvedHardwareId
      ? (() => {
          const identity = discoverLinuxUsbAudioIdentities().find((item) => item.hardwareId === resolvedHardwareId);
          return identity ? identityToFields(identity) : (resolvedHardwareId ? { hardwareId: resolvedHardwareId } : {});
        })()
      : {};
    this.deviceRegistry[direction].set(key, {
      ...(existing ?? {
        id: deviceId,
        name: deviceName,
        isDefault: false,
        channels: Math.max(1, channels || 1),
        sampleRate,
        type: direction,
      }),
      id: deviceId,
      name: deviceName,
      channels: existing?.channels ?? Math.max(1, channels || 1),
      sampleRate: existing?.sampleRate ?? sampleRate,
      availability: 'active',
      isActiveByTx5dr: true,
      lastSeenAt: existing?.lastSeenAt ?? Date.now(),
      lastRtAudioId: deviceId,
      ...identityFields,
    });
  }

  clearActiveDevice(direction: AudioDirection, deviceName?: string | null, deviceId?: string | null): void {
    const entries = deviceId
      ? [[this.getDeviceKey(direction, deviceId), this.findRegisteredDeviceById(direction, deviceId)] as const]
      : deviceName
        ? Array.from(this.deviceRegistry[direction].entries()).filter(([, device]) => device.name === deviceName)
        : Array.from(this.deviceRegistry[direction].entries());

    for (const [key, device] of entries) {
      if (!device?.isActiveByTx5dr) continue;
      this.deviceRegistry[direction].set(key, {
        ...device,
        availability: 'cached',
        isActiveByTx5dr: false,
      });
    }
  }

  /**
   * 检查是否应该显示 ICOM WLAN 虚拟设备
   */
  /**
   * Get OpenWebRX stations as virtual input devices
   */
  private getOpenWebRXVirtualDevices(): AudioDevice[] {
    try {
      const configManager = ConfigManager.getInstance();
      const stations = configManager.getOpenWebRXStations();
      return stations.map(station => ({
        id: `openwebrx-${station.id}`,
        name: `[SDR] ${station.name}`,
        isDefault: false,
        channels: 1,
        sampleRate: 12000,
        sampleRates: [12000],
        type: 'input' as const,
        availability: 'available' as const,
        isActiveByTx5dr: false,
      }));
    } catch {
      return [];
    }
  }

  private shouldShowIcomWlanDevice(): boolean {
    const configManager = ConfigManager.getInstance();
    const radioConfig = configManager.getRadioConfig();

    if (radioConfig.type !== 'icom-wlan') {
      return false;
    }

    if (this.icomWlanConnectedCallback) {
      return this.icomWlanConnectedCallback();
    }

    return true;
  }

  private createIcomWlanDevice(type: 'input' | 'output'): AudioDevice {
    return {
      id: `icom-wlan-${type}`,
      name: 'ICOM WLAN',
      isDefault: false,
      channels: 1,
      sampleRate: 12000,
      sampleRates: [12000],
      type,
      availability: 'available',
      isActiveByTx5dr: false,
    };
  }

  private shouldShowTciDevice(): boolean {
    const configManager = ConfigManager.getInstance();
    const radioConfig = configManager.getRadioConfig();

    if (radioConfig.type !== 'tci' || radioConfig.tci?.audioEnabled === false) {
      return false;
    }

    if (this.tciConnectedCallback) {
      return this.tciConnectedCallback();
    }

    return true;
  }

  private createTciDevice(type: 'input' | 'output'): AudioDevice {
    const sampleRate = ConfigManager.getInstance().getRadioConfig().tci?.audioSampleRate ?? 12000;
    return {
      id: `tci-${type}`,
      name: 'TCI Audio',
      isDefault: false,
      channels: 1,
      sampleRate,
      sampleRates: [sampleRate],
      type,
      availability: 'available',
      isActiveByTx5dr: false,
    };
  }

  private normalizeSampleRates(sampleRates: unknown): number[] {
    if (!Array.isArray(sampleRates)) {
      return [];
    }

    return Array.from(new Set(sampleRates
      .map((rate) => Math.round(Number(rate)))
      .filter((rate) => Number.isFinite(rate) && rate > 0))).sort((a, b) => a - b);
  }

  /**
   * 将 Audify 设备信息转换为 AudioDevice 格式
   */
  private convertAudifyDevice(device: any, type: 'input' | 'output', isSystemDefault: boolean = false): AudioDevice {
    const channels = type === 'input' ? device.inputChannels : device.outputChannels;
    const finalChannels = channels && channels > 0 ? channels : 0;

    logger.debug(`Converting device ${device.name} (${type}): rawChannels=${channels}, finalChannels=${finalChannels}`);

    const sampleRates = this.normalizeSampleRates(device.sampleRates);

    return {
      id: `${type}-${device.id}`,
      name: device.name || `${type === 'input' ? 'input' : 'output'} device ${device.id}`,
      isDefault: isSystemDefault,
      channels: finalChannels,
      sampleRate: device.preferredSampleRate || 48000,
      ...(sampleRates.length > 0 ? { sampleRates } : {}),
      type: type,
    };
  }

  private createRtAudioInstance(): RtAudioInstance {
    return createRtAudioInstance({ logger, purpose: 'audio-device-enumeration' });
  }

  private getRtAudioDevices(): any[] {
    const rtAudio = this.createRtAudioInstance();
    return rtAudio.getDevices();
  }

  /**
   * 获取所有音频输入设备
   */
  async getInputDevices(): Promise<AudioDevice[]> {
    try {
      await this.refreshDeviceRegistry();
      const devices = this.createRegisteredSnapshot('input');
      logger.debug(`Returning ${devices.length} input devices: ${devices.map((d: AudioDevice) => d.name).join(', ')}`);
      return devices;
    } catch (error) {
      logger.error('Failed to get input devices', error);
      return this.createRegisteredSnapshot('input');
    }
  }

  /**
   * 获取所有音频输出设备
   */
  async getOutputDevices(): Promise<AudioDevice[]> {
    try {
      await this.refreshDeviceRegistry();
      const devices = this.createRegisteredSnapshot('output');
      logger.debug(`Returning ${devices.length} output devices: ${devices.map((d: AudioDevice) => d.name).join(', ')}`);
      return devices;
    } catch (error) {
      logger.error('Failed to get output devices', error);
      return this.createRegisteredSnapshot('output');
    }
  }

  /**
   * 获取所有音频设备
   */
  async getAllDevices() {
    logger.debug('Getting all audio devices');
    await this.refreshDeviceRegistry();
    const inputDevices = this.createRegisteredSnapshot('input');
    const outputDevices = this.createRegisteredSnapshot('output');

    logger.debug(`Device summary: ${inputDevices.length} input, ${outputDevices.length} output`);

    return {
      inputDevices,
      outputDevices,
      inputBufferSizes: RTAUDIO_BUFFER_SIZE_OPTIONS,
      outputBufferSizes: RTAUDIO_BUFFER_SIZE_OPTIONS,
    };
  }

  async resolveAudioSettings(
    settings: AudioDeviceSettings,
    radioType?: RadioType,
  ): Promise<AudioDeviceResolutionSet> {
    const devices = await this.getAllDevices();
    const effectiveRadioType = radioType ?? ConfigManager.getInstance().getRadioConfig().type;

    return {
      input: this.resolveDeviceDirection({
        configuredDeviceName: settings.inputDeviceName ?? null,
        configuredDeviceId: settings.inputDeviceId ?? null,
        configuredHardwareId: settings.inputHardwareId ?? null,
        devices: devices.inputDevices,
        direction: 'input',
        radioType: effectiveRadioType,
      }),
      output: this.resolveDeviceDirection({
        configuredDeviceName: settings.outputDeviceName ?? null,
        configuredDeviceId: settings.outputDeviceId ?? null,
        configuredHardwareId: settings.outputHardwareId ?? null,
        devices: devices.outputDevices,
        direction: 'output',
        radioType: effectiveRadioType,
      }),
    };
  }

  private resolveDeviceDirection(params: {
    configuredDeviceName: string | null;
    configuredDeviceId?: string | null;
    configuredHardwareId?: string | null;
    devices: AudioDevice[];
    direction: 'input' | 'output';
    radioType: RadioType;
  }): AudioDeviceResolution {
    const {
      configuredDeviceName,
      configuredDeviceId = null,
      configuredHardwareId = null,
      devices,
      direction,
      radioType,
    } = params;
    const defaultDevice = devices.find((device) => device.isDefault) ?? devices[0] ?? null;

    if (!configuredDeviceName && !configuredDeviceId && !configuredHardwareId) {
      return {
        configuredDeviceName: null,
        configuredDeviceId: null,
        configuredHardwareId: null,
        configuredDevice: null,
        effectiveDevice: defaultDevice,
        status: 'default',
        reason: defaultDevice ? null : 'no-default-device',
      };
    }

    if (configuredDeviceName && isAndroidBridgeRuntime() && isLegacyAndroidAudioDeviceName(direction, configuredDeviceName)) {
      return {
        configuredDeviceName,
        configuredDeviceId,
        configuredHardwareId,
        configuredDevice: null,
        effectiveDevice: defaultDevice,
        status: 'default',
        reason: defaultDevice ? 'legacy-android-audio-device' : 'no-default-device',
      };
    }

    const configuredDevice = this.findConfiguredDevice(devices, {
      configuredDeviceId,
      configuredHardwareId,
      configuredDeviceName,
    });
    if (configuredDevice) {
      return {
        configuredDeviceName: configuredDeviceName ?? configuredDevice.name,
        configuredDeviceId: configuredDeviceId ?? configuredDevice.id,
        configuredHardwareId: configuredHardwareId ?? configuredDevice.hardwareId ?? null,
        configuredDevice,
        effectiveDevice: configuredDevice,
        status: configuredDevice.id.startsWith('openwebrx-') || configuredDevice.id.startsWith('icom-wlan-') || configuredDevice.id.startsWith('tci-')
          ? 'virtual-selected'
          : 'selected',
        reason: null,
      };
    }

    if (configuredDeviceName === 'ICOM WLAN' && radioType === 'icom-wlan') {
      const virtualDevice = this.createIcomWlanDevice(direction);
      return {
        configuredDeviceName,
        configuredDeviceId: configuredDeviceId ?? virtualDevice.id,
        configuredHardwareId,
        configuredDevice: virtualDevice,
        effectiveDevice: virtualDevice,
        status: 'virtual-selected',
        reason: 'icom-wlan-radio-audio',
      };
    }

    if (configuredDeviceName === 'TCI Audio' && radioType === 'tci') {
      const virtualDevice = this.createTciDevice(direction);
      return {
        configuredDeviceName,
        configuredDeviceId: configuredDeviceId ?? virtualDevice.id,
        configuredHardwareId,
        configuredDevice: virtualDevice,
        effectiveDevice: virtualDevice,
        status: 'virtual-selected',
        reason: 'tci-radio-audio',
      };
    }

    if (configuredDeviceName?.startsWith('[SDR]')) {
      return {
        configuredDeviceName,
        configuredDeviceId,
        configuredHardwareId,
        configuredDevice: null,
        effectiveDevice: null,
        status: 'missing',
        reason: direction === 'input' ? 'openwebrx-station-missing' : 'openwebrx-output-unsupported',
      };
    }

    return {
      configuredDeviceName: configuredDeviceName ?? null,
      configuredDeviceId,
      configuredHardwareId,
      configuredDevice: null,
      effectiveDevice: null,
      status: 'missing',
      reason: 'configured-device-missing',
    };
  }

  /**
   * 根据ID获取设备信息
   */
  async getDeviceById(deviceId: string): Promise<AudioDevice | null> {
    const allDevices = await this.getAllDevices();
    const allDevicesList = [...allDevices.inputDevices, ...allDevices.outputDevices];

    return allDevicesList.find(device => device.id === deviceId) || null;
  }

  /**
   * 根据设备名称查找输入设备
   */
  async getInputDeviceByName(deviceName: string): Promise<AudioDevice | null> {
    try {
      await this.refreshDeviceRegistry();
      const registeredDevice = this.findRegisteredDeviceByName('input', deviceName);
      if (registeredDevice) {
        return this.toPublicDevice(registeredDevice);
      }
      return this.createRegisteredSnapshot('input').find(device => device.name === deviceName) || null;
    } catch (error) {
      logger.error('Failed to find input device by name', error);
      return null;
    }
  }

  /**
   * 根据设备名称查找输出设备
   */
  async getOutputDeviceByName(deviceName: string): Promise<AudioDevice | null> {
    try {
      await this.refreshDeviceRegistry();
      const registeredDevice = this.findRegisteredDeviceByName('output', deviceName);
      if (registeredDevice) {
        return this.toPublicDevice(registeredDevice);
      }
      return this.createRegisteredSnapshot('output').find(device => device.name === deviceName) || null;
    } catch (error) {
      logger.error('Failed to find output device by name', error);
      return null;
    }
  }

  /**
   * 获取默认输入设备
   */
  async getDefaultInputDevice(): Promise<AudioDevice | null> {
    try {
      const inputDevices = await this.getInputDevices();
      return this.findDefaultDevice(inputDevices);
    } catch (error) {
      logger.error('Failed to get default input device', error);
      return null;
    }
  }

  /**
   * 获取默认输出设备
   */
  async getDefaultOutputDevice(): Promise<AudioDevice | null> {
    try {
      const outputDevices = await this.getOutputDevices();
      return this.findDefaultDevice(outputDevices);
    } catch (error) {
      logger.error('Failed to get default output device', error);
      return null;
    }
  }

  /**
   * 根据设备名称解析为输入设备ID；空设备名使用默认设备，已配置设备缺失时交给 sidecar 重试。
   */
  async resolveInputDeviceId(deviceName?: string): Promise<string | undefined> {
    if (!deviceName) {
      const defaultDevice = await this.getDefaultInputDevice();
      logger.debug(`Using default input device: ${defaultDevice?.name || 'none'}`);
      return defaultDevice?.id;
    }

    if (isAndroidBridgeRuntime() && isLegacyAndroidAudioDeviceName('input', deviceName)) {
      const defaultDevice = await this.getDefaultInputDevice();
      logger.debug(`Using default Android input device for legacy setting ${deviceName}: ${defaultDevice?.name || 'none'}`);
      return defaultDevice?.id;
    }

    if (deviceName === 'ICOM WLAN') {
      return 'icom-wlan-input';
    }

    if (deviceName === 'TCI Audio') {
      return 'tci-input';
    }

    const device = await this.getInputDeviceByName(deviceName);
    if (device) {
      if (device.availability === 'cached' && !device.isActiveByTx5dr) {
        throw this.createUnavailableConfiguredDeviceError('input', deviceName, 'cached');
      }
      logger.debug(`Found configured input device: ${device.name} -> ${device.id}`);
      return device.id;
    }

    logger.warn(`Input device "${deviceName}" not found, waiting for automatic retry`);
    throw this.createMissingConfiguredDeviceError('input', deviceName);
  }

  /**
   * 根据设备名称解析为输出设备ID；空设备名使用默认设备，已配置设备缺失时交给 sidecar 重试。
   */
  async resolveOutputDeviceId(deviceName?: string): Promise<string | undefined> {
    if (!deviceName) {
      const defaultDevice = await this.getDefaultOutputDevice();
      logger.debug(`Using default output device: ${defaultDevice?.name || 'none'}`);
      return defaultDevice?.id;
    }

    if (isAndroidBridgeRuntime() && isLegacyAndroidAudioDeviceName('output', deviceName)) {
      const defaultDevice = await this.getDefaultOutputDevice();
      logger.debug(`Using default Android output device for legacy setting ${deviceName}: ${defaultDevice?.name || 'none'}`);
      return defaultDevice?.id;
    }

    if (deviceName === 'ICOM WLAN') {
      return 'icom-wlan-output';
    }

    if (deviceName === 'TCI Audio') {
      return 'tci-output';
    }

    const device = await this.getOutputDeviceByName(deviceName);
    if (device) {
      if (device.availability === 'cached' && !device.isActiveByTx5dr) {
        throw this.createUnavailableConfiguredDeviceError('output', deviceName, 'cached');
      }
      logger.debug(`Found configured output device: ${device.name} -> ${device.id}`);
      return device.id;
    }

    logger.warn(`Output device "${deviceName}" not found, waiting for automatic retry`);
    throw this.createMissingConfiguredDeviceError('output', deviceName);
  }

  private createMissingConfiguredDeviceError(direction: 'input' | 'output', deviceName: string, availability?: AudioDeviceAvailability): RadioError {
    return new RadioError({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      message: `Configured audio ${direction} device "${deviceName}" is temporarily unavailable`,
      userMessage: availability === 'cached'
        ? `Configured audio ${direction} device "${deviceName}" is currently unavailable or busy.`
        : `Configured audio ${direction} device "${deviceName}" is temporarily unavailable. The system will keep retrying automatically.`,
      userMessageKey: direction === 'input'
        ? 'radio:audioSidecar.errorInputDeviceUnavailable'
        : 'radio:audioSidecar.errorOutputDeviceUnavailable',
      userMessageParams: { deviceName },
      severity: RadioErrorSeverity.ERROR,
      suggestions: [
        'Reconnect the audio device and wait for the operating system to finish enumerating it',
        'Check the audio device list to confirm the configured device name appears again',
        'Keep the current profile selected so automatic retry can recover the audio connection',
      ],
      context: {
        deviceName,
        direction,
        availability,
        temporaryUnavailable: true,
        recoverable: true,
      },
    });
  }

  /**
   * 验证设备是否存在
   */
  async validateDevice(deviceId: string): Promise<boolean> {
    try {
      const device = await this.getDeviceById(deviceId);
      const exists = device !== null;
      logger.debug(`Validate device ${deviceId}: ${exists ? 'found' : 'not found'}`);
      return exists;
    } catch (error) {
      logger.error(`Failed to validate device ${deviceId}`, error);
      return false;
    }
  }
}
