import { z } from 'zod';
import { UserRole } from './auth.schema.js';

// ===== Actions =====

export type AppAction = 'manage' | 'read' | 'create' | 'update' | 'delete' | 'execute';

// ===== Subjects =====

/**
 * Domain subjects - entity-level access with instance conditions
 * - Operator: condition { id: string }
 * - Transmission: condition { operatorId: string }
 * - Token / AuthConfig: admin-only management
 */
export type DomainSubject =
  | 'Operator'
  | 'Transmission'
  | 'Token'
  | 'AuthConfig';

/**
 * Capability subjects - delegatable atomic permissions
 * Each Permission enum value maps to exactly one CapabilitySubject
 */
export type CapabilitySubject =
  | 'RadioFrequency'
  | 'RadioTuner'
  | 'RadioTune'
  | 'RadioConfig'
  | 'RadioReconnect'
  | 'RadioControl'
  | 'RadioPower'
  | 'RigctldBridge'
  | 'Engine'
  | 'ModeSwitch'
  | 'CWDecoder'
  | 'CWDecoderConfig'
  | 'SettingsDecodeWindows'
  | 'SettingsFrequencyPresets'
  | 'StationInfo';

export type AppSubject = DomainSubject | CapabilitySubject | 'all';

/** CASL generic type parameter: [Action, Subject] */
export type AppAbilities = [AppAction, AppSubject];

// ===== Permission enum (storage & UI identifier) =====

export enum Permission {
  RADIO_SET_FREQUENCY = 'radio:set_frequency',
  RADIO_SET_TUNER = 'radio:set_tuner',
  RADIO_TUNE = 'radio:tune',
  RADIO_CONFIG = 'radio:config',
  RADIO_RECONNECT = 'radio:reconnect',
  /** 统一电台控制能力写命令（AF增益、静噪、发射功率等）*/
  RADIO_CONTROL = 'radio:control',
  /** 电台电源管理（开机/关机）— 独立于 RADIO_CONTROL，影响物理设备可达性 */
  RADIO_POWER = 'radio:power',
  /** 启停 rigctld TCP 桥接（允许外部软件如 N1MM / WSJT-X 接入当前电台）*/
  RIGCTLD_BRIDGE = 'rigctld:bridge',
  ENGINE_START_STOP = 'engine:start_stop',
  MODE_SWITCH = 'mode:switch',
  CW_DECODER_CONTROL = 'cw:decoder_control',
  CW_DECODER_CONFIG = 'cw:decoder_config',
  SETTINGS_DECODE_WINDOWS = 'settings:decode_windows',
  SETTINGS_FREQUENCY_PRESETS = 'settings:frequency_presets',
  STATION_UPDATE = 'station:update',
}

export const PermissionSchema = z.nativeEnum(Permission);

// ===== Permission → CASL rule mapping =====

export const PERMISSION_RULE_MAP: Record<Permission, { action: AppAction; subject: CapabilitySubject }> = {
  [Permission.RADIO_SET_FREQUENCY]: { action: 'execute', subject: 'RadioFrequency' },
  [Permission.RADIO_SET_TUNER]: { action: 'execute', subject: 'RadioTuner' },
  [Permission.RADIO_TUNE]: { action: 'execute', subject: 'RadioTune' },
  [Permission.RADIO_CONFIG]: { action: 'update', subject: 'RadioConfig' },
  [Permission.RADIO_RECONNECT]: { action: 'execute', subject: 'RadioReconnect' },
  [Permission.RADIO_CONTROL]: { action: 'execute', subject: 'RadioControl' },
  [Permission.RADIO_POWER]: { action: 'execute', subject: 'RadioPower' },
  [Permission.RIGCTLD_BRIDGE]: { action: 'execute', subject: 'RigctldBridge' },
  [Permission.ENGINE_START_STOP]: { action: 'execute', subject: 'Engine' },
  [Permission.MODE_SWITCH]: { action: 'execute', subject: 'ModeSwitch' },
  [Permission.CW_DECODER_CONTROL]: { action: 'execute', subject: 'CWDecoder' },
  [Permission.CW_DECODER_CONFIG]: { action: 'update', subject: 'CWDecoderConfig' },
  [Permission.SETTINGS_DECODE_WINDOWS]: { action: 'update', subject: 'SettingsDecodeWindows' },
  [Permission.SETTINGS_FREQUENCY_PRESETS]: { action: 'update', subject: 'SettingsFrequencyPresets' },
  [Permission.STATION_UPDATE]: { action: 'update', subject: 'StationInfo' },
};

// ===== PermissionGrant (stored on token) =====

export const PermissionGrantSchema = z.object({
  permission: PermissionSchema,
  /** MongoDB-style conditions for CASL, e.g. { frequency: { $in: [14074000] } } */
  conditions: z.record(z.unknown()).optional(),
});

export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

// ===== Frequency permission helpers =====

export interface FrequencyPermissionRange {
  band?: string;
  minFrequency: number;
  maxFrequency: number;
}

export const FREQUENCY_PERMISSION_BAND_RANGES: Record<string, FrequencyPermissionRange> = {
  '160m': { band: '160m', minFrequency: 1_800_000, maxFrequency: 2_000_000 },
  '80m': { band: '80m', minFrequency: 3_500_000, maxFrequency: 4_000_000 },
  '60m': { band: '60m', minFrequency: 5_000_000, maxFrequency: 5_500_000 },
  '40m': { band: '40m', minFrequency: 7_000_000, maxFrequency: 7_300_000 },
  '30m': { band: '30m', minFrequency: 10_100_000, maxFrequency: 10_150_000 },
  '20m': { band: '20m', minFrequency: 14_000_000, maxFrequency: 14_350_000 },
  '17m': { band: '17m', minFrequency: 18_068_000, maxFrequency: 18_168_000 },
  '15m': { band: '15m', minFrequency: 21_000_000, maxFrequency: 21_450_000 },
  '12m': { band: '12m', minFrequency: 24_890_000, maxFrequency: 24_990_000 },
  '10m': { band: '10m', minFrequency: 28_000_000, maxFrequency: 29_700_000 },
  '6m': { band: '6m', minFrequency: 50_000_000, maxFrequency: 54_000_000 },
  '2m': { band: '2m', minFrequency: 144_000_000, maxFrequency: 148_000_000 },
  '70cm': { band: '70cm', minFrequency: 420_000_000, maxFrequency: 450_000_000 },
};

function getFrequencyCondition(grant: PermissionGrant): Record<string, unknown> | null {
  if (grant.permission !== Permission.RADIO_SET_FREQUENCY) return null;
  const frequency = grant.conditions?.frequency;
  if (!frequency || typeof frequency !== 'object' || Array.isArray(frequency)) return null;
  return frequency as Record<string, unknown>;
}

function normalizeFrequency(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function requireFrequency(value: unknown, label: string): number {
  const frequency = normalizeFrequency(value);
  if (frequency === null) {
    throw new Error(`${label} must be a finite positive frequency in Hz`);
  }
  return frequency;
}

export function getPresetFrequenciesFromFrequencyGrants(grants: PermissionGrant[] | undefined): number[] {
  const result: number[] = [];
  const seen = new Set<number>();

  for (const grant of grants ?? []) {
    const condition = getFrequencyCondition(grant);
    const values = condition?.$in;
    if (!Array.isArray(values)) continue;

    for (const value of values) {
      const frequency = normalizeFrequency(value);
      if (frequency !== null && !seen.has(frequency)) {
        seen.add(frequency);
        result.push(frequency);
      }
    }
  }

  return result;
}

export function getRangesFromFrequencyGrants(grants: PermissionGrant[] | undefined): FrequencyPermissionRange[] {
  const result: FrequencyPermissionRange[] = [];

  for (const grant of grants ?? []) {
    const condition = getFrequencyCondition(grant);
    const minFrequency = normalizeFrequency(condition?.$gte);
    const maxFrequency = normalizeFrequency(condition?.$lte);
    if (minFrequency === null || maxFrequency === null || minFrequency > maxFrequency) continue;

    result.push({
      minFrequency,
      maxFrequency,
      band: inferFrequencyPermissionBand(minFrequency, maxFrequency),
    });
  }

  return result;
}

export function inferFrequencyPermissionBand(minFrequency: number, maxFrequency: number): string | undefined {
  const entry = Object.entries(FREQUENCY_PERMISSION_BAND_RANGES)
    .find(([, range]) => range.minFrequency === minFrequency && range.maxFrequency === maxFrequency);
  return entry?.[0];
}

export function buildRadioFrequencyPermissionGrants(
  presetFrequencies: number[],
  ranges: FrequencyPermissionRange[],
): PermissionGrant[] {
  const grants: PermissionGrant[] = [];
  const normalizedPresetFrequencies = [...new Set(presetFrequencies.map((value, index) => requireFrequency(value, `presetFrequencies[${index}]`)))];

  if (normalizedPresetFrequencies.length > 0) {
    grants.push({
      permission: Permission.RADIO_SET_FREQUENCY,
      conditions: {
        frequency: { $in: normalizedPresetFrequencies },
      },
    });
  }

  for (const [index, range] of ranges.entries()) {
    const minFrequency = requireFrequency(range.minFrequency, `ranges[${index}].minFrequency`);
    const maxFrequency = requireFrequency(range.maxFrequency, `ranges[${index}].maxFrequency`);
    if (minFrequency > maxFrequency) {
      throw new Error(`ranges[${index}] minFrequency must be less than or equal to maxFrequency`);
    }

    grants.push({
      permission: Permission.RADIO_SET_FREQUENCY,
      conditions: {
        frequency: {
          $gte: minFrequency,
          $lte: maxFrequency,
        },
      },
    });
  }

  return grants.length > 0
    ? grants
    : [{ permission: Permission.RADIO_SET_FREQUENCY }];
}

// ===== Raw rule type (pure data, no CASL dependency) =====

export interface RawRule {
  action: AppAction | AppAction[];
  subject: AppSubject | AppSubject[];
  conditions?: Record<string, unknown>;
  inverted?: boolean;
}

// ===== Ability rules builder =====

/**
 * Build CASL-compatible rules from role + operatorIds + permission grants.
 * Three layers stacked:
 *   Layer 1: Role-based defaults
 *   Layer 2: Operator data scope (operatorIds → conditions)
 *   Layer 3: Custom permission grants
 *
 * Returns pure JSON — server/web each call createMongoAbility() with these rules.
 */
export function buildAbilityRules(params: {
  role: UserRole;
  operatorIds?: string[];
  permissionGrants?: PermissionGrant[];
}): RawRule[] {
  const { role, operatorIds = [], permissionGrants = [] } = params;

  // ADMIN: full access
  if (role === UserRole.ADMIN) {
    return [{ action: 'manage', subject: 'all' }];
  }

  const rules: RawRule[] = [];

  // Layer 1: role defaults
  rules.push({ action: 'read', subject: 'all' });

  if (role === UserRole.OPERATOR) {
    // Operators can manage their own operators and transmissions
    if (operatorIds.length > 0) {
      rules.push(
        { action: 'manage', subject: 'Operator', conditions: { id: { $in: operatorIds } } },
        { action: 'manage', subject: 'Transmission', conditions: { operatorId: { $in: operatorIds } } },
      );
    }
    // Operators can create new operators (maxOperators checked separately)
    rules.push({ action: 'create', subject: 'Operator' });
  }

  // Layer 2: custom permission grants
  for (const grant of permissionGrants) {
    const mapping = PERMISSION_RULE_MAP[grant.permission];
    if (mapping) {
      rules.push({
        action: mapping.action,
        subject: mapping.subject,
        ...(grant.conditions ? { conditions: grant.conditions } : {}),
      });
    }
  }

  return rules;
}

// ===== Permission groups (for UI) =====

export interface PermissionGroupDef {
  key: string;
  permissions: Permission[];
}

export const PERMISSION_GROUPS: PermissionGroupDef[] = [
  {
    key: 'radio',
    permissions: [
      Permission.RADIO_SET_FREQUENCY,
      Permission.RADIO_SET_TUNER,
      Permission.RADIO_TUNE,
      Permission.RADIO_CONFIG,
      Permission.RADIO_RECONNECT,
      Permission.RADIO_CONTROL,
      Permission.RADIO_POWER,
      Permission.RIGCTLD_BRIDGE,
    ],
  },
  { key: 'engine', permissions: [Permission.ENGINE_START_STOP] },
  { key: 'mode', permissions: [Permission.MODE_SWITCH] },
  {
    key: 'cw',
    permissions: [
      Permission.CW_DECODER_CONTROL,
      Permission.CW_DECODER_CONFIG,
    ],
  },
  {
    key: 'settings',
    permissions: [
      Permission.SETTINGS_DECODE_WINDOWS,
      Permission.SETTINGS_FREQUENCY_PRESETS,
    ],
  },
  { key: 'station', permissions: [Permission.STATION_UPDATE] },
];

/** Permissions that support condition constraints (UI shows condition editor) */
export const CONDITIONAL_PERMISSIONS: Partial<Record<Permission, {
  conditionField: string;
  conditionOperator: '$in';
  labelKey: string;
}>> = {
  [Permission.RADIO_SET_FREQUENCY]: {
    conditionField: 'frequency',
    conditionOperator: '$in',
    labelKey: 'auth:permissions.frequencyRestriction',
  },
};
