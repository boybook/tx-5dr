import { describe, it, expect } from 'vitest';
import { FT8MessageType as InlinedType } from '../ft8-message-type.js';
import { FT8MessageType as ContractsType } from '@tx5dr/contracts';

describe('FT8MessageType inlining', () => {
  it('must match the contracts source of truth', () => {
    expect(InlinedType).toStrictEqual(ContractsType);
  });
});
