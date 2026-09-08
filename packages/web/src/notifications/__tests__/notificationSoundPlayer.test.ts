import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationSoundPlayer } from '../notificationSoundPlayer';

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = 'suspended';
  destination = {};
  gain = { gain: { value: 1 }, connect: vi.fn() };
  sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  constructor() { FakeAudioContext.instances.push(this); }
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  createGain = () => this.gain;
  decodeAudioData = vi.fn(async () => ({}));
  createBufferSource = () => {
    const source = { buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
    this.sources.push(source);
    return source;
  };
}

describe('notification sound player', () => {
  let player: NotificationSoundPlayer;
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) })));
    player = new NotificationSoundPlayer();
  });
  afterEach(() => { player.dispose(); vi.unstubAllGlobals(); });

  it('creates audio only on activation and never queues locked or unprepared events', async () => {
    expect(player.play('glass')).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);
    const unlock = player.unlock();
    const context = FakeAudioContext.instances[0];
    expect(context.resume).toHaveBeenCalledOnce();
    await unlock;
    expect(player.play('glass')).toBe(false);
    await player.prepare('glass');
    expect(context.sources).toHaveLength(0);
    expect(player.getStatus()).toBe('ready');
    expect(player.play('glass')).toBe(true);
  });

  it('caches assets and previews using local volume, replacing any current sound', async () => {
    player.setVolume(0.3);
    expect(await player.preview('pluck')).toBe(true);
    const context = FakeAudioContext.instances[0];
    expect(context.gain.gain.value).toBe(0.3);
    await player.preview('pluck');
    expect(fetch).toHaveBeenCalledOnce();
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    player.setVolume(0);
    expect(player.play('pluck')).toBe(false);
    expect(context.sources[1].stop).toHaveBeenCalledOnce();
  });

  it('reports missing assets and supports an explicit retry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    expect(await player.preview('glass')).toBe(false);
    expect(player.getStatus()).toBe('error');
    expect(await player.preview('glass')).toBe(true);
    expect(player.getStatus()).toBe('ready');
  });

  it('handles unavailable audio and denied activation without throwing', async () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(await player.unlock()).toBe(false);
    expect(player.getStatus()).toBe('unsupported');
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await player.unlock();
    const context = FakeAudioContext.instances[0];
    context.state = 'suspended';
    context.resume.mockRejectedValueOnce(new Error('NotAllowedError'));
    expect(await player.unlock()).toBe(false);
    expect(player.getStatus()).toBe('locked');
  });

  it('cancels an in-flight preview when turned off, and ignores asset completion after disposal', async () => {
    let resolveResponse!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
    const preview = player.preview('confirmation');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const context = FakeAudioContext.instances[0];
    player.stop();
    player.dispose();
    resolveResponse({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) } as Response);
    expect(await preview).toBe(false);
    expect(context.sources).toHaveLength(0);
    expect(context.close).toHaveBeenCalledOnce();
    expect(player.getStatus()).toBe('locked');
  });
});
