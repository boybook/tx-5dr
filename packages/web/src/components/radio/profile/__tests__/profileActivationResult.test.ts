import { describe, expect, it } from 'vitest';
import { assessProfileActivation } from '../profileActivationResult';

describe('assessProfileActivation', () => {
  it('accepts complete success and legacy success responses', () => {
    expect(assessProfileActivation({ success: true, engineRunning: true })).toEqual({ success: true });
    expect(assessProfileActivation({ success: true })).toEqual({ success: true });
  });

  it('rejects explicit failure and engine restart partial failure', () => {
    expect(assessProfileActivation({ success: false, error: 'restart failed' })).toEqual({
      success: false,
      error: 'restart failed',
    });
    expect(assessProfileActivation({ success: true, engineRunning: false, error: 'offline' })).toEqual({
      success: false,
      error: 'offline',
    });
  });
});
