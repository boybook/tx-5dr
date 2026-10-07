import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { RecordingService } from '../RecordingService.js';
import type { AudioStreamEvents, AudioStreamManager } from '../AudioStreamManager.js';
import type { RecordingSettings } from '@tx5dr/contracts';

function createManager(): EventEmitter<AudioStreamEvents> {
  return new EventEmitter<AudioStreamEvents>();
}

function rxFrame(samples: Float32Array) {
  return {
    samples,
    sampleRate: 24000,
    channels: 1,
    timestamp: Date.now(),
    sequence: 1,
    sourceKind: 'simulation' as const,
  };
}

describe('RecordingService', () => {
  const directories: string[] = [];
  const services: RecordingService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.dispose()));
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function setup(overrides: Partial<RecordingSettings> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'tx5dr-recording-test-'));
    directories.push(directory);
    const manager = createManager();
    const settings: RecordingSettings = {
      prefix: 'recording',
      format: 'wav',
      sampleRate: 24000,
      bitDepth: 16,
      source: 'rx',
      directory,
      ...overrides,
    };
    const service = new RecordingService(
      manager as unknown as AudioStreamManager,
      directory,
      () => settings,
    );
    services.push(service);
    return { manager, service, directory };
  }

  function recordingFile(files: string[], extension: 'wav' | 'mp3', prefix = 'recording'): string {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const file = files.find(item => new RegExp(`^${escapedPrefix}-\\d{8}-\\d{6}-\\d{6}\\.${extension}$`).test(item));
    if (!file) throw new Error(`Missing ${extension} recording file`);
    return file;
  }

  it('finalizes WAV and exposes completed file in list', async () => {
    const { manager, service, directory } = await setup();
    await service.start();
    manager.emit('nativeAudioInputData', rxFrame(new Float32Array([0.25, -0.25])));
    const status = await service.stop();

    expect(status.recording).toBe(false);
    const files = await readdir(directory);
    const fileName = recordingFile(files, 'wav');
    expect(fileName).toMatch(/^recording-\d{8}-\d{6}-000001\.wav$/);
    expect(files).toEqual(['.index.json', fileName]);
    const output = await readFile(join(directory, fileName));
    expect(output.toString('ascii', 0, 4)).toBe('RIFF');
    expect(output.readUInt32LE(24)).toBe(24000);
    expect(output.readInt16LE(44)).toBeCloseTo(8192, -1);
    expect(output.readInt16LE(46)).toBeCloseTo(-8192, -1);
    expect((await service.list())[0]?.fileName).toBe(fileName);
  });

  it('keeps numbering and removes stale temporary files', async () => {
    const { service, directory } = await setup();
    await writeFile(join(directory, 'recording-000001.wav.part'), Buffer.from('partial'));
    await service.start();
    await service.stop();
    await service.start();
    await service.stop();

    expect((await readdir(directory)).filter(file => file.endsWith('.part'))).toEqual([]);
    const files = (await readdir(directory)).filter(file => file.endsWith('.wav')).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^recording-\d{8}-\d{6}-000001\.wav$/);
    expect(files[1]).toMatch(/^recording-\d{8}-\d{6}-000002\.wav$/);
  });

  it('uses configurable filename prefix', async () => {
    const { manager, service, directory } = await setup({ prefix: 'station-a' });
    await service.start();
    manager.emit('nativeAudioInputData', rxFrame(new Float32Array([0.1])));
    await service.stop();

    const fileName = recordingFile(await readdir(directory), 'wav', 'station-a');
    expect(fileName).toMatch(/^station-a-\d{8}-\d{6}-000001\.wav$/);
    expect((await service.list())[0]?.fileName).toBe(fileName);
  });

  it('does not retain RX-only audio forever when source is both', async () => {
    const { manager, service, directory } = await setup({ source: 'both' });
    await service.start();
    manager.emit('nativeAudioInputData', rxFrame(new Float32Array([0.25, -0.25])));
    await service.stop();

    const output = await readFile(join(directory, recordingFile(await readdir(directory), 'wav')));
    expect(output.readInt16LE(44)).toBeCloseTo(8192, -1);
    expect(output.readInt16LE(46)).toBeCloseTo(-8192, -1);
  });

  it('writes a usable MP3 through the bundled lamejs encoder', async () => {
    const { manager, service, directory } = await setup({ format: 'mp3' });
    expect(service.isMp3Supported()).toBe(true);
    await service.start();
    manager.emit('nativeAudioInputData', rxFrame(new Float32Array(1152).fill(0.2)));
    await service.stop();

    const output = await readFile(join(directory, recordingFile(await readdir(directory), 'mp3')));
    expect(output.length).toBeGreaterThan(100);
    expect(output[0]).toBeGreaterThanOrEqual(0);
    expect((await readdir(directory)).some(file => file.endsWith('.part'))).toBe(false);
  });
});
