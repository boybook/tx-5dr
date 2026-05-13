import { describe, expect, it } from 'vitest';

import { NATIVE_MODULES } from '../check-native-modules.js';

describe('native module preflight list', () => {
  it('includes onnxruntime-node so Windows VC runtime issues surface at startup', () => {
    expect(NATIVE_MODULES).toContain('onnxruntime-node');
  });
});
