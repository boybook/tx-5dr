import { describe, expect, it, vi } from 'vitest';

const build = vi.hoisted(() => ({ distribution: 'linux-service' }));
vi.mock('../../generated/buildInfo.js', () => ({ SERVER_BUILD_INFO: build }));
import { resolveRuntimeDistribution } from '../runtime-distribution.js';

describe('packaged runtime distribution', () => {
  it('keeps a Server package on the CLI update path inside a container', () => {
    build.distribution = 'linux-service';
    expect(resolveRuntimeDistribution('/custom/server-data', {
      env: { NODE_ENV: 'production' }, hasDockerEnvFile: true,
    })).toBe('linux-service');
  });

  it('keeps an official Docker image on the image update path with a custom data directory', () => {
    build.distribution = 'docker';
    expect(resolveRuntimeDistribution('/var/lib/tx5dr', {
      env: { NODE_ENV: 'production' }, hasDockerEnvFile: false,
    })).toBe('docker');
  });

  it('retains environment detection for an unpackaged development build', () => {
    build.distribution = 'web-dev';
    expect(resolveRuntimeDistribution('/var/lib/tx5dr', {
      env: { NODE_ENV: 'production' }, hasDockerEnvFile: false,
    })).toBe('linux-service');
  });
});
