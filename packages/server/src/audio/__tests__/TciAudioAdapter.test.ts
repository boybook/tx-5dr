import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { TciAudioAdapter } from '../TciAudioAdapter.js';

class MockTciConnection extends EventEmitter {
  startAudioStream = vi.fn().mockResolvedValue(undefined);
  stopAudioStream = vi.fn().mockResolvedValue(undefined);
  beginTxAudio = vi.fn();
  waitForTxAudioDrain = vi.fn().mockResolvedValue(undefined);
  endTxAudio = vi.fn();
  sendAudio = vi.fn().mockResolvedValue(undefined);
  getAudioSampleRate = vi.fn(() => 12000);
}

describe('TciAudioAdapter', () => {
  it('converts RX PCM16 frames to Float32 samples and controls stream lifecycle', async () => {
    const connection = new MockTciConnection();
    const adapter = new TciAudioAdapter(connection as never);
    const frames: Float32Array[] = [];
    adapter.on('audioData', (samples) => frames.push(samples));

    adapter.startReceiving();
    await Promise.resolve();
    const pcm16 = Buffer.alloc(4);
    pcm16.writeInt16LE(0, 0);
    pcm16.writeInt16LE(16384, 2);
    connection.emit('audioFrame', pcm16);

    expect(connection.startAudioStream).toHaveBeenCalledWith('rx-input');
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!)).toEqual([0, 0.5]);
    expect(adapter.isReceivingAudio()).toBe(true);

    adapter.stopReceiving();
    await Promise.resolve();
    expect(connection.stopAudioStream).toHaveBeenCalledWith('rx-input');
    expect(adapter.isReceivingAudio()).toBe(false);
  });

  it('controls TCI TX audio lifecycle separately from RX receiving', async () => {
    const connection = new MockTciConnection();
    const adapter = new TciAudioAdapter(connection as never);

    await adapter.startOutput();
    await adapter.beginTransmission();
    await adapter.drainTransmission(250);
    await adapter.endTransmission();
    await adapter.stopOutput();

    expect(connection.startAudioStream).toHaveBeenCalledWith('tx-output');
    expect(connection.beginTxAudio).toHaveBeenCalledOnce();
    expect(connection.waitForTxAudioDrain).toHaveBeenCalledWith(250);
    expect(connection.endTxAudio).toHaveBeenCalledOnce();
    expect(connection.stopAudioStream).toHaveBeenCalledWith('tx-output');
  });

  it('sends TX Float32 samples through the TCI connection', async () => {
    const connection = new MockTciConnection();
    const adapter = new TciAudioAdapter(connection as never);
    const samples = new Float32Array([0.25, -0.25]);

    await adapter.sendAudio(samples);

    expect(connection.sendAudio).toHaveBeenCalledWith(samples);
    expect(adapter.getSampleRate()).toBe(12000);
  });
});
