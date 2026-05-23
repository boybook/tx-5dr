import { describe, expect, it } from 'vitest';

import { NATIVE_MODULES, runNativeModulePreflight } from '../check-native-modules.js';

describe('native module preflight list', () => {
  it('includes onnxruntime-node so Windows VC runtime issues surface at startup', () => {
    expect(NATIVE_MODULES).toContain('onnxruntime-node');
  });

  it('returns success when all modules import', async () => {
    const lines: string[] = [];
    const ok = await runNativeModulePreflight({
      importer: async () => ({}),
      writeLine: (line) => lines.push(line),
    });

    expect(ok).toBe(true);
    expect(lines).toContain('DONE');
    expect(lines.some((line) => line.startsWith('FAIL:'))).toBe(false);
  });

  it('returns failure when a required module import fails', async () => {
    const lines: string[] = [];
    const ok = await runNativeModulePreflight({
      importer: async (moduleName) => {
        if (moduleName === 'audify') {
          throw new Error('GLIBCXX_3.4.32 not found');
        }
        return {};
      },
      writeLine: (line) => lines.push(line),
    });

    expect(ok).toBe(false);
    expect(lines).toContain('FAIL:audify:GLIBCXX_3.4.32 not found');
    expect(lines).toContain('DONE');
  });

  it('returns success when only a degradable module import fails', async () => {
    const lines: string[] = [];
    const ok = await runNativeModulePreflight({
      importer: async (moduleName) => {
        if (moduleName === 'node-datachannel') {
          throw new Error('optional realtime transport failed');
        }
        return {};
      },
      writeLine: (line) => lines.push(line),
    });

    expect(ok).toBe(true);
    expect(lines).toContain('FAIL:node-datachannel:optional realtime transport failed');
    expect(lines).toContain('DONE');
  });
});
