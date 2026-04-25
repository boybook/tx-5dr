import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as nodeWav from 'node-wav';
import { VoiceKeyerManager } from '../VoiceKeyerManager.js';

const tempDirs: string[] = [];

function makeWav(durationSec = 1, sampleRate = 16000): Buffer {
  const samples = new Float32Array(Math.round(durationSec * sampleRate));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((i / sampleRate) * Math.PI * 2 * 440) * 0.2;
  }
  return nodeWav.encode([samples], { sampleRate, float: false, bitDepth: 16 });
}

async function createManager() {
  const root = await mkdtemp(join(tmpdir(), 'tx5dr-voice-keyer-'));
  tempDirs.push(root);
  const voiceSessionManager = {
    startTransmit: vi.fn().mockResolvedValue({ success: true }),
    stopTransmit: vi.fn().mockResolvedValue(true),
  };
  const audioStreamManager = {
    playAudio: vi.fn().mockResolvedValue(undefined),
    stopCurrentPlayback: vi.fn().mockResolvedValue(0),
  };
  const manager = new VoiceKeyerManager({
    voiceSessionManager: voiceSessionManager as any,
    audioStreamManager: audioStreamManager as any,
    storageRootDir: root,
  });
  return { manager, root, voiceSessionManager, audioStreamManager };
}

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('VoiceKeyerManager', () => {
  it('separates panels by normalized callsign', async () => {
    const { manager } = await createManager();

    await manager.saveSlotAudio('bg5drb', '1', makeWav());
    const first = await manager.getPanel('BG5DRB');
    const second = await manager.getPanel('K1ABC');

    expect(first.callsign).toBe('BG5DRB');
    expect(first.slots[0]?.hasAudio).toBe(true);
    expect(second.callsign).toBe('K1ABC');
    expect(second.slots[0]?.hasAudio).toBe(false);
    expect(first.slots[0]?.repeatEnabled).toBe(false);
  });

  it('keeps repeat disabled by default and persists repeat settings per callsign', async () => {
    const { manager } = await createManager();

    const initial = await manager.getPanel('BG5DRB');
    const updated = await manager.updateSlot('BG5DRB', '1', { repeatEnabled: true, repeatIntervalSec: 17 });
    const other = await manager.getPanel('K1ABC');

    expect(initial.slots[0]?.repeatEnabled).toBe(false);
    expect(updated.slots[0]?.repeatEnabled).toBe(true);
    expect(updated.slots[0]?.repeatIntervalSec).toBe(17);
    expect(other.slots[0]?.repeatEnabled).toBe(false);
  });

  it('keeps hidden slot recordings when slot count is reduced', async () => {
    const { manager } = await createManager();

    await manager.saveSlotAudio('BG5DRB', '9', makeWav());
    const reduced = await manager.updatePanel('BG5DRB', 8);
    const restored = await manager.updatePanel('BG5DRB', 10);

    expect(reduced.slotCount).toBe(8);
    expect(reduced.slots[8]?.hasAudio).toBe(true);
    expect(restored.slotCount).toBe(10);
    expect(restored.slots[8]?.hasAudio).toBe(true);
  });

  it('writes valid wav audio and rejects out-of-range durations', async () => {
    const { manager } = await createManager();

    const panel = await manager.saveSlotAudio('BG5DRB', '1', makeWav(1));
    const audioPath = await manager.getSlotAudioPathForRead('BG5DRB', '1');
    const decoded = nodeWav.decode(await readFile(audioPath));

    expect(panel.slots[0]?.durationMs).toBeGreaterThanOrEqual(900);
    expect(decoded.sampleRate).toBe(16000);
    await expect(manager.saveSlotAudio('BG5DRB', '2', makeWav(0.1))).rejects.toThrow(/between 0.5s and 120s/);
  });

  it('surfaces PTT lock failures without playing audio', async () => {
    const { manager, voiceSessionManager, audioStreamManager } = await createManager();
    voiceSessionManager.startTransmit.mockResolvedValueOnce({ success: false, reason: 'locked' });
    const statuses: string[] = [];
    manager.on('voiceKeyerStatusChanged', status => statuses.push(status.mode));

    await manager.saveSlotAudio('BG5DRB', '1', makeWav());
    await manager.play({ callsign: 'BG5DRB', slotId: '1', repeat: false, connectionId: 'c1', label: 'Op' });
    await vi.waitFor(() => expect(statuses).toContain('error'));

    expect(audioStreamManager.playAudio).not.toHaveBeenCalled();
    expect(manager.getStatus().error).toContain('locked');
  });

  describe('manual PTT overrides repeat CQ', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('clears repeat countdown during manual PTT and restarts a full interval after release', async () => {
      const { manager, voiceSessionManager } = await createManager();
      await manager.saveSlotAudio('BG5DRB', '1', makeWav());
      await manager.updateSlot('BG5DRB', '1', { repeatEnabled: true, repeatIntervalSec: 4 });

      await manager.play({ callsign: 'BG5DRB', slotId: '1', repeat: true, connectionId: 'c1', label: 'Op' });
      await vi.waitFor(() => expect(manager.getStatus().mode).toBe('playing'));
      await vi.advanceTimersByTimeAsync(PTT_AUDIO_WINDOW_MS);
      await vi.waitFor(() => expect(manager.getStatus().mode).toBe('repeat-waiting'));

      const firstCountdown = manager.getStatus().nextRunAt;
      expect(firstCountdown).toEqual(expect.any(Number));
      expect(voiceSessionManager.startTransmit).toHaveBeenCalledTimes(1);

      manager.setManualPttActive(true);
      expect(manager.getStatus().nextRunAt).toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(voiceSessionManager.startTransmit).toHaveBeenCalledTimes(1);

      manager.setManualPttActive(false);
      await vi.waitFor(() => expect(manager.getStatus().nextRunAt).toEqual(expect.any(Number)));
      const restartedCountdown = manager.getStatus().nextRunAt!;
      expect(restartedCountdown).toBeGreaterThan(Date.now() + 3_500);

      await vi.advanceTimersByTimeAsync(3_999);
      expect(voiceSessionManager.startTransmit).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(voiceSessionManager.startTransmit).toHaveBeenCalledTimes(2));
    });

    it('stops active playback when manual PTT starts', async () => {
      const { manager, voiceSessionManager, audioStreamManager } = await createManager();
      await manager.saveSlotAudio('BG5DRB', '1', makeWav());
      await manager.updateSlot('BG5DRB', '1', { repeatEnabled: true, repeatIntervalSec: 4 });

      await manager.play({ callsign: 'BG5DRB', slotId: '1', repeat: true, connectionId: 'c1', label: 'Op' });
      await vi.waitFor(() => expect(manager.getStatus().mode).toBe('playing'));

      manager.setManualPttActive(true);
      await vi.waitFor(() => expect(manager.getStatus().mode).toBe('idle'));

      expect(audioStreamManager.stopCurrentPlayback).toHaveBeenCalled();
      expect(voiceSessionManager.stopTransmit).toHaveBeenCalledWith('voice-keyer:c1');
    });
  });
});

const PTT_AUDIO_WINDOW_MS = 150 + 500;
