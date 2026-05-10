import { describe, expect, it } from 'vitest';

import { isPrepareShutdownSuccess } from '../prepareShutdown.js';

describe('prepare-shutdown response parsing', () => {
  it('accepts only 2xx responses with success true', () => {
    expect(isPrepareShutdownSuccess(200, '{"success":true}')).toBe(true);
    expect(isPrepareShutdownSuccess(204, '{"success":true}')).toBe(true);
  });

  it('rejects 2xx responses without success true', () => {
    expect(isPrepareShutdownSuccess(200, '{"success":false,"errors":[]}')).toBe(false);
    expect(isPrepareShutdownSuccess(200, '{}')).toBe(false);
  });

  it('rejects non-2xx responses and malformed bodies', () => {
    expect(isPrepareShutdownSuccess(500, '{"success":true}')).toBe(false);
    expect(isPrepareShutdownSuccess(200, '{')).toBe(false);
    expect(isPrepareShutdownSuccess(200, '')).toBe(false);
    expect(isPrepareShutdownSuccess(undefined, '{"success":true}')).toBe(false);
  });
});
