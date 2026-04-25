import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServerCpuProfileManager } from '../ServerCpuProfileManager.js';

async function createPaths(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const paths = {
    configDir: path.join(root, 'config'),
    dataDir: path.join(root, 'data'),
    logsDir: path.join(root, 'logs'),
    cacheDir: path.join(root, 'cache'),
  };

  await Promise.all(Object.values(paths).map((dir) => mkdir(dir, { recursive: true })));
  return paths;
}

describe('ServerCpuProfileManager', () => {
  it('arms, starts and completes a guided capture', async () => {
    const paths = await createPaths('tx5dr-cpu-profile-');
    const manager = await ServerCpuProfileManager.create({
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      paths,
      hasDockerEnvFile: false,
    });

    const armed = await manager.armGuidedCapture();
    expect(armed.state).toBe('armed');
    expect(armed.captureId).toBeTruthy();

    const build = await manager.buildServerNodeArgs();
    expect(build.args).toContain('--cpu-prof');
    expect(build.launchSession?.source).toBe('guided-capture');
    expect(build.launchSession?.profilePath).toContain('.cpuprofile');

    await writeFile(build.launchSession!.profilePath!, 'profile');
    await manager.completeLaunchSession({
      launchSession: build.launchSession,
      exitCode: 0,
      signal: null,
    });

    const completed = await manager.getStatus();
    expect(completed.state).toBe('completed');
    expect(completed.profilePath).toBe(build.launchSession?.profilePath ?? null);
  });

  it('marks a clean exit without output as missing', async () => {
    const paths = await createPaths('tx5dr-cpu-profile-missing-');
    const manager = await ServerCpuProfileManager.create({
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      paths,
      hasDockerEnvFile: false,
    });

    await manager.armGuidedCapture();
    const build = await manager.buildServerNodeArgs();
    await manager.completeLaunchSession({
      launchSession: build.launchSession,
      exitCode: 0,
      signal: null,
    });

    const status = await manager.getStatus();
    expect(status.state).toBe('missing');
  });

  it('marks a non-zero exit without output as interrupted', async () => {
    const paths = await createPaths('tx5dr-cpu-profile-interrupted-');
    const manager = await ServerCpuProfileManager.create({
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      paths,
      hasDockerEnvFile: false,
    });

    await manager.armGuidedCapture();
    const build = await manager.buildServerNodeArgs();
    await manager.completeLaunchSession({
      launchSession: build.launchSession,
      exitCode: 1,
      signal: null,
    });

    const status = await manager.getStatus();
    expect(status.state).toBe('interrupted');
  });

  it('prefers env override over guided capture state', async () => {
    const paths = await createPaths('tx5dr-cpu-profile-env-');
    const manager = await ServerCpuProfileManager.create({
      env: {
        NODE_ENV: 'production',
        TX5DR_SERVER_CPU_PROFILE: '1',
        TX5DR_SERVER_CPU_PROFILE_NAME: 'forced-profile.cpuprofile',
      } as NodeJS.ProcessEnv,
      paths,
      hasDockerEnvFile: false,
    });

    const status = await manager.getStatus();
    expect(status.state).toBe('env-override');
    expect(status.source).toBe('env-override');

    const build = await manager.buildServerNodeArgs();
    expect(build.args).toContain('--cpu-prof');
    expect(build.args.some((arg) => arg.includes('forced-profile.cpuprofile'))).toBe(true);
  });
});
