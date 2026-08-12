import { describe, expect, it } from 'vitest';
import { resolveLogbookPageParameters } from '../../components/logbook/logbookRecoveryPolicy';

describe('logbook page parameters', () => {
  it.each([
    ['?operatorId=operator-1', { operatorId: 'operator-1', logBookId: '', valid: true }],
    ['?logBookId=BA8BLK', { operatorId: '', logBookId: 'BA8BLK', valid: true }],
    ['?operatorId=operator-1&logBookId=BA8BLK', { operatorId: 'operator-1', logBookId: 'BA8BLK', valid: true }],
    ['', { operatorId: '', logBookId: '', valid: false }],
  ])('resolves %s', (search, expected) => {
    expect(resolveLogbookPageParameters(search)).toEqual(expected);
  });
});
