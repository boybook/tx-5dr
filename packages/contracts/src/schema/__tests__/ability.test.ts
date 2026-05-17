import { describe, expect, it } from 'vitest';
import {
  buildRadioFrequencyPermissionGrants,
  buildAbilityRules,
  getPresetFrequenciesFromFrequencyGrants,
  getRangesFromFrequencyGrants,
  Permission,
  PERMISSION_GROUPS,
  PERMISSION_RULE_MAP,
} from '../ability.js';
import { UserRole } from '../auth.schema.js';

describe('ability contracts', () => {
  it('maps CW decoder permissions to separate control and config capabilities', () => {
    expect(PERMISSION_RULE_MAP[Permission.CW_DECODER_CONTROL]).toEqual({
      action: 'execute',
      subject: 'CWDecoder',
    });
    expect(PERMISSION_RULE_MAP[Permission.CW_DECODER_CONFIG]).toEqual({
      action: 'update',
      subject: 'CWDecoderConfig',
    });
  });

  it('keeps CW decoder permissions delegatable instead of granting them to every operator', () => {
    expect(buildAbilityRules({ role: UserRole.OPERATOR, operatorIds: ['op1'] }))
      .not.toContainEqual({ action: 'execute', subject: 'CWDecoder' });

    expect(buildAbilityRules({
      role: UserRole.OPERATOR,
      operatorIds: ['op1'],
      permissionGrants: [{ permission: Permission.CW_DECODER_CONTROL }],
    })).toContainEqual({ action: 'execute', subject: 'CWDecoder' });
  });

  it('exposes CW permissions in the token permission groups', () => {
    const cwGroup = PERMISSION_GROUPS.find(group => group.key === 'cw');
    expect(cwGroup?.permissions).toEqual([
      Permission.CW_DECODER_CONTROL,
      Permission.CW_DECODER_CONFIG,
    ]);
  });

  it('builds preset and range frequency grants as separate OR rules', () => {
    const grants = buildRadioFrequencyPermissionGrants(
      [7_050_000, 7_050_000],
      [{ minFrequency: 14_000_000, maxFrequency: 14_350_000 }],
    );

    expect(grants).toEqual([
      {
        permission: Permission.RADIO_SET_FREQUENCY,
        conditions: { frequency: { $in: [7_050_000] } },
      },
      {
        permission: Permission.RADIO_SET_FREQUENCY,
        conditions: { frequency: { $gte: 14_000_000, $lte: 14_350_000 } },
      },
    ]);
  });

  it('uses an unconditional frequency grant when no preset or range restriction is provided', () => {
    expect(buildRadioFrequencyPermissionGrants([], [])).toEqual([
      { permission: Permission.RADIO_SET_FREQUENCY },
    ]);
  });

  it('rejects invalid preset frequency restrictions instead of allowing all frequencies', () => {
    expect(() => buildRadioFrequencyPermissionGrants([Number.NaN], []))
      .toThrow('presetFrequencies[0]');
    expect(() => buildRadioFrequencyPermissionGrants([0], []))
      .toThrow('presetFrequencies[0]');
  });

  it('rejects invalid range restrictions instead of allowing all frequencies', () => {
    expect(() => buildRadioFrequencyPermissionGrants([], [{ minFrequency: Number.NaN, maxFrequency: 14_350_000 }]))
      .toThrow('ranges[0].minFrequency');
    expect(() => buildRadioFrequencyPermissionGrants([], [{ minFrequency: 14_350_000, maxFrequency: 14_000_000 }]))
      .toThrow('ranges[0]');
  });

  it('restores preset and range restrictions from existing frequency grants', () => {
    const grants = [
      {
        permission: Permission.RADIO_SET_FREQUENCY,
        conditions: { frequency: { $in: [7_050_000, 14_270_000] } },
      },
      {
        permission: Permission.RADIO_SET_FREQUENCY,
        conditions: { frequency: { $gte: 14_000_000, $lte: 14_350_000 } },
      },
    ];

    expect(getPresetFrequenciesFromFrequencyGrants(grants)).toEqual([7_050_000, 14_270_000]);
    expect(getRangesFromFrequencyGrants(grants)).toEqual([
      { band: '20m', minFrequency: 14_000_000, maxFrequency: 14_350_000 },
    ]);
  });
});
