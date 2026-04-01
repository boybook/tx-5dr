import type { HamlibConfig, SerialConfig, SerialConnectionConfig } from '@tx5dr/contracts';

const SERIAL_CONFIG_TO_BACKEND_TOKEN: Record<keyof SerialConfig, string> = {
  data_bits: 'serial_data_bits',
  stop_bits: 'serial_stop_bits',
  serial_parity: 'serial_parity',
  serial_handshake: 'serial_handshake',
  rts_state: 'rts_state',
  dtr_state: 'dtr_state',
  rate: 'serial_speed',
  timeout: 'timeout',
  retry: 'retry',
  write_delay: 'write_delay',
  post_write_delay: 'post_write_delay',
};

function toBackendValue(value: string | number | boolean | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return String(value);
}

export function buildBackendConfig(
  serial?: Partial<SerialConnectionConfig>,
  options?: {
    pttMethod?: string;
    pttPort?: string;
  }
): Record<string, string> {
  const backendConfig: Record<string, string> = { ...(serial?.backendConfig ?? {}) };

  if (serial?.path && !backendConfig.rig_pathname) {
    backendConfig.rig_pathname = serial.path;
  }

  const serialConfig = serial?.serialConfig;
  if (serialConfig) {
    (Object.entries(SERIAL_CONFIG_TO_BACKEND_TOKEN) as Array<[keyof SerialConfig, string]>).forEach(([legacyKey, backendKey]) => {
      if (backendConfig[backendKey] !== undefined) {
        return;
      }

      const value = toBackendValue(serialConfig[legacyKey]);
      if (value !== undefined) {
        backendConfig[backendKey] = value;
      }
    });
  }

  if (options?.pttMethod === 'dtr' || options?.pttMethod === 'rts') {
    const pttPath = options.pttPort || backendConfig.ptt_pathname || backendConfig.rig_pathname;
    if (pttPath) {
      backendConfig.ptt_pathname = pttPath;
    }
  }

  return backendConfig;
}

export function normalizeSerialConnectionConfig(serial?: Partial<SerialConnectionConfig>): SerialConnectionConfig | undefined {
  if (!serial) {
    return undefined;
  }

  const backendConfig = buildBackendConfig(serial);
  const normalizedPath = serial.path || backendConfig.rig_pathname || '';

  return {
    path: normalizedPath,
    rigModel: serial.rigModel ?? 0,
    serialConfig: serial.serialConfig,
    backendConfig,
  };
}

export function normalizeHamlibConfig(config: HamlibConfig): HamlibConfig {
  if (config.type !== 'serial') {
    return config;
  }

  return {
    ...config,
    serial: normalizeSerialConnectionConfig(config.serial),
  };
}
