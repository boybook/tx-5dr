import { describe, expect, it } from 'vitest';
import {
  makeDeepCWBackendDescriptor,
  resolveDeepCWModelPath,
  resolveDeepCWRuntimeBackends,
} from '../DigitalRadioEngine.js';

describe('resolveDeepCWModelPath', () => {
  it('resolves Linux service models from the app root when cwd is server dist', () => {
    const expected = '/usr/share/tx5dr/resources/models/deepcw/en_tiny.onnx';

    const resolved = resolveDeepCWModelPath(
      { language: 'en', modelSize: 'tiny' },
      {
        cwd: '/usr/share/tx5dr/packages/server/dist',
        env: {},
        moduleDir: '/usr/share/tx5dr/packages/server/dist',
        exists: (candidate) => candidate === expected,
      },
    );

    expect(resolved).toBe(expected);
  });

  it('resolves Docker models from the app root when cwd is server dist', () => {
    const expected = '/app/resources/models/deepcw/en_tiny.onnx';

    const resolved = resolveDeepCWModelPath(
      { language: 'en', modelSize: 'tiny' },
      {
        cwd: '/app/packages/server/dist',
        env: {},
        moduleDir: '/app/packages/server/dist',
        exists: (candidate) => candidate === expected,
      },
    );

    expect(resolved).toBe(expected);
  });

  it('prefers TX5DR_DEEPCW_MODEL_PATH over bundled model candidates', () => {
    const configured = '/custom/deepcw/custom.onnx';

    const resolved = resolveDeepCWModelPath(
      { language: 'en', modelSize: 'small' },
      {
        cwd: '/usr/share/tx5dr/packages/server/dist',
        env: { TX5DR_DEEPCW_MODEL_PATH: configured },
        moduleDir: '/usr/share/tx5dr/packages/server/dist',
        exists: () => false,
      },
    );

    expect(resolved).toBe(configured);
  });

  it('keeps APP_RESOURCES semantics for Electron bundles', () => {
    const appResources = '/Applications/TX-5DR.app/Contents/Resources';
    const expected = `${appResources}/models/deepcw/en_small.onnx`;

    const resolved = resolveDeepCWModelPath(
      { language: 'en', modelSize: 'small' },
      {
        cwd: '/Applications/TX-5DR.app/Contents/Resources/app.asar',
        env: { APP_RESOURCES: appResources },
        moduleDir: '/Applications/TX-5DR.app/Contents/Resources/app.asar/packages/server/dist',
        exists: (candidate) => candidate === expected,
      },
    );

    expect(resolved).toBe(expected);
  });
});

describe('resolveDeepCWRuntimeBackends', () => {
  it('exposes CoreML on macOS', () => {
    expect(resolveDeepCWRuntimeBackends({ platform: 'darwin', arch: 'arm64' })).toEqual(['cpu', 'coreml']);
  });

  it('exposes CUDA and WebGPU on Linux x64', () => {
    expect(resolveDeepCWRuntimeBackends({ platform: 'linux', arch: 'x64' })).toEqual(['cpu', 'cuda', 'webgpu']);
  });

  it('keeps CPU as the portable fallback on unknown platforms', () => {
    expect(resolveDeepCWRuntimeBackends({ platform: 'freebsd', arch: 'x64' })).toEqual(['cpu']);
  });

  it('uses the same runtime backend list for DeepCW descriptors', () => {
    const descriptor = makeDeepCWBackendDescriptor({
      available: true,
      runtimeBackend: 'cuda',
    });

    expect(descriptor.runtimeBackends).toEqual(resolveDeepCWRuntimeBackends());
    expect(descriptor.runtime).toBe('cuda');
  });
});
