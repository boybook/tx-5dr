import type { HamlibConfig } from './radio.schema.js';

/**
 * Radios known to support `rig_set_powerstat(RIG_POWER_ON)` via Hamlib.
 * Matching happens on mfgName + modelName (case-insensitive, substring/regex).
 *
 * Because node-hamlib does not expose `rig_get_caps`, we cannot introspect
 * per-model powerstat support at runtime. Instead we maintain a conservative
 * allow-list of radios for which powerstat is verified to work; UI only
 * surfaces the "power on" button for these models. The server still falls
 * back to the actual Hamlib return value — an unsupported model receives a
 * user-friendly error if the allow-list is bypassed.
 *
 * To add a new model: add an entry with the mfgName returned by
 * `HamLib.getSupportedRigs()` and a pattern that matches its modelName.
 */
export interface PowerCapableRigEntry {
  mfg: string | RegExp;
  model: string | RegExp;
}

export const POWER_CAPABLE_RIGS: ReadonlyArray<PowerCapableRigEntry> = [
  // Icom modern transceivers (CI-V 0x18 command)
  { mfg: /^icom$/i, model: /^IC-?705$/i },
  { mfg: /^icom$/i, model: /^IC-?7300$/i },
  { mfg: /^icom$/i, model: /^IC-?7610$/i },
  { mfg: /^icom$/i, model: /^IC-?7100$/i },
  { mfg: /^icom$/i, model: /^IC-?7851$/i },
  { mfg: /^icom$/i, model: /^IC-?9700$/i },
  { mfg: /^icom$/i, model: /^IC-?R8600$/i },

  // Kenwood
  { mfg: /^kenwood$/i, model: /^TS-590SG?$/i },
  { mfg: /^kenwood$/i, model: /^TS-890$/i },
  { mfg: /^kenwood$/i, model: /^TS-990$/i },

  // Yaesu
  { mfg: /^yaesu$/i, model: /^FT-991A?$/i },
  { mfg: /^yaesu$/i, model: /^FTDX-?10$/i },
  { mfg: /^yaesu$/i, model: /^FTDX-?101(MP|D)?$/i },
  { mfg: /^yaesu$/i, model: /^FT-?710$/i },
];

export function isRigModelPowerCapable(mfgName: string, modelName: string): boolean {
  return POWER_CAPABLE_RIGS.some((entry) => {
    const mfgOk =
      typeof entry.mfg === 'string'
        ? entry.mfg.toLowerCase() === mfgName.toLowerCase()
        : entry.mfg.test(mfgName);
    const modelOk =
      typeof entry.model === 'string'
        ? entry.model.toLowerCase() === modelName.toLowerCase()
        : entry.model.test(modelName);
    return mfgOk && modelOk;
  });
}

export type PowerSupportReason =
  | 'model-unsupported'
  | 'network-mode-no-wake'
  | 'none-mode';

export interface PowerSupportDecision {
  /** Whether the UI should surface a "power on" control. */
  canPowerOn: boolean;
  /** Whether the UI should surface a "power off" control. */
  canPowerOff: boolean;
  /** Machine-readable reason when `canPowerOn` is false. */
  reason?: PowerSupportReason;
}

/**
 * Decide whether power control should be surfaced for a given Profile radio config.
 *
 * For serial mode, the caller must provide the rig's mfgName/modelName
 * (resolved via `HamLib.getSupportedRigs()` server-side). For network mode
 * the rig model is not known ahead of time (rigctld proxies any radio) —
 * `power on` is never offered because a remote rigctld running on the radio
 * is unreachable when the radio is powered off. `power off` is still offered
 * in case the rigctld process runs on a separate host.
 */
export function decidePowerSupport(
  config: HamlibConfig,
  rigInfo?: { mfgName: string; modelName: string }
): PowerSupportDecision {
  switch (config.type) {
    case 'none':
      return { canPowerOn: false, canPowerOff: false, reason: 'none-mode' };
    case 'network':
      return { canPowerOn: false, canPowerOff: true, reason: 'network-mode-no-wake' };
    case 'icom-wlan':
      // ICOM WLAN 的 CI-V-over-UDP 通道在电台关机后无法维持；即便已连接
      // 发送 powerstat(off) 也不能可靠恢复。整体不暴露电源控制。
      return { canPowerOn: false, canPowerOff: false, reason: 'model-unsupported' };
    case 'serial': {
      if (!rigInfo) {
        return { canPowerOn: false, canPowerOff: false, reason: 'model-unsupported' };
      }
      const supported = isRigModelPowerCapable(rigInfo.mfgName, rigInfo.modelName);
      return supported
        ? { canPowerOn: true, canPowerOff: true }
        : { canPowerOn: false, canPowerOff: false, reason: 'model-unsupported' };
    }
    default:
      return { canPowerOn: false, canPowerOff: false, reason: 'model-unsupported' };
  }
}
