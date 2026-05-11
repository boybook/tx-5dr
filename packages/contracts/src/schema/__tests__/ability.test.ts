import { describe, expect, it } from 'vitest';
import {
  buildAbilityRules,
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
});
