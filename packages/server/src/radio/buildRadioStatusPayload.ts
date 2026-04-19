import type {
  CoreCapabilityDiagnostics,
  CoreRadioCapabilities,
  MeterCapabilities,
  RadioInfo,
  ReconnectProgress,
  TunerCapabilities,
  WSRadioStatusChangedMessage,
} from '@tx5dr/contracts';
import type { RadioConnectionStatus } from '@tx5dr/contracts';

const UNSUPPORTED_METER_CAPABILITIES: MeterCapabilities = {
  strength: false,
  swr: false,
  alc: false,
  power: false,
  powerWatts: false,
};

type RadioStatusPayload = WSRadioStatusChangedMessage['data'];

interface RadioStatusSource {
  getConfig(): RadioStatusPayload['radioConfig'];
  getConnectionHealth(): NonNullable<RadioStatusPayload['connectionHealth']>;
  getCoreCapabilities(): CoreRadioCapabilities | undefined;
  getCoreCapabilityDiagnostics(): CoreCapabilityDiagnostics | undefined;
  getMeterCapabilities(): MeterCapabilities | undefined;
}

interface BuildRadioStatusPayloadOptions {
  connected: boolean;
  status: RadioConnectionStatus;
  radioManager: RadioStatusSource;
  radioInfo: RadioInfo | null;
  radioConfig?: RadioStatusPayload['radioConfig'];
  connectionHealth?: RadioStatusPayload['connectionHealth'];
  coreCapabilities?: CoreRadioCapabilities;
  coreCapabilityDiagnostics?: CoreCapabilityDiagnostics;
  meterCapabilities?: MeterCapabilities;
  tunerCapabilities?: TunerCapabilities;
  reason?: string;
  message?: string;
  recommendation?: string;
  reconnectProgress?: ReconnectProgress | null;
}

export function buildRadioStatusPayload(options: BuildRadioStatusPayloadOptions): RadioStatusPayload {
  const {
    connected,
    status,
    radioManager,
    radioInfo,
    radioConfig,
    connectionHealth,
    coreCapabilities,
    coreCapabilityDiagnostics,
    meterCapabilities,
    tunerCapabilities,
    reason,
    message,
    recommendation,
    reconnectProgress,
  } = options;

  return {
    connected,
    status,
    radioInfo,
    radioConfig: radioConfig ?? radioManager.getConfig(),
    reason,
    message,
    recommendation,
    reconnectProgress: reconnectProgress ?? undefined,
    connectionHealth: connectionHealth ?? radioManager.getConnectionHealth(),
    coreCapabilities: coreCapabilities ?? radioManager.getCoreCapabilities(),
    coreCapabilityDiagnostics: coreCapabilityDiagnostics ?? radioManager.getCoreCapabilityDiagnostics(),
    meterCapabilities: connected
      ? (meterCapabilities ?? radioManager.getMeterCapabilities() ?? UNSUPPORTED_METER_CAPABILITIES)
      : undefined,
    tunerCapabilities,
  };
}
