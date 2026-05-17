import { describe, expect, it } from 'vitest';
import { Permission, UserRole } from '@tx5dr/contracts';
import { buildAbility, canWithData } from '../ability.js';

describe('frequency permission ability', () => {
  it('allows only explicitly granted preset frequencies with $in conditions', () => {
    const ability = buildAbility({
      role: UserRole.OPERATOR,
      permissionGrants: [{
        permission: Permission.RADIO_SET_FREQUENCY,
        conditions: { frequency: { $in: [7_050_000] } },
      }],
    });

    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 7_050_000 })).toBe(true);
    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 14_270_000 })).toBe(false);
  });

  it('allows frequency changes within inclusive $gte/$lte ranges', () => {
    const ability = buildAbility({
      role: UserRole.OPERATOR,
      permissionGrants: [{
        permission: Permission.RADIO_SET_FREQUENCY,
        conditions: { frequency: { $gte: 14_000_000, $lte: 14_350_000 } },
      }],
    });

    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 14_000_000 })).toBe(true);
    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 14_270_000 })).toBe(true);
    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 14_350_000 })).toBe(true);
    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 14_500_000 })).toBe(false);
  });

  it('treats multiple radio frequency grants as OR conditions', () => {
    const ability = buildAbility({
      role: UserRole.OPERATOR,
      permissionGrants: [
        {
          permission: Permission.RADIO_SET_FREQUENCY,
          conditions: { frequency: { $in: [7_050_000] } },
        },
        {
          permission: Permission.RADIO_SET_FREQUENCY,
          conditions: { frequency: { $gte: 14_000_000, $lte: 14_350_000 } },
        },
      ],
    });

    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 7_050_000 })).toBe(true);
    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 14_270_000 })).toBe(true);
    expect(canWithData(ability, 'execute', 'RadioFrequency', { frequency: 145_000_000 })).toBe(false);
  });

  it('keeps unconditional frequency grants and admin access unrestricted', () => {
    const operatorAbility = buildAbility({
      role: UserRole.OPERATOR,
      permissionGrants: [{ permission: Permission.RADIO_SET_FREQUENCY }],
    });
    const adminAbility = buildAbility({ role: UserRole.ADMIN });

    expect(canWithData(operatorAbility, 'execute', 'RadioFrequency', { frequency: 145_000_000 })).toBe(true);
    expect(canWithData(adminAbility, 'execute', 'RadioFrequency', { frequency: 999_000_000 })).toBe(true);
  });
});
