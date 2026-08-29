export interface FrameAudioIdentity {
  frameId: string;
  revision: number;
}

export interface EncodedTrack {
  operatorId: string;
  streamId: string;
  trackId: string;
  audioFrequencyHz: number;
  audioData: Float32Array;
  sampleRate: number;
  slotStartMs: number;
  requestId?: string;
  encodedAt: number;
}

export interface FrameAudioSnapshot extends FrameAudioIdentity {
  slotId: string;
  txDialShiftHz: number;
  tracks: ReadonlyMap<string, EncodedTrack>;
}

interface MutableFrameAudio extends FrameAudioIdentity {
  slotId: string;
  txDialShiftHz: number;
  tracks: Map<string, EncodedTrack>;
}

function frameKey(identity: FrameAudioIdentity): string {
  return `${identity.frameId}:${identity.revision}`;
}

export class FrameAudioRepository {
  private readonly frames = new Map<string, MutableFrameAudio>();
  private readonly retainedKeys = new Set<string>();

  constructor(private readonly maxFrames = 256) {}

  putTrack(
    identity: FrameAudioIdentity & { slotId: string },
    track: EncodedTrack,
    txDialShiftHz: number,
  ): boolean {
    const key = frameKey(identity);
    let frame = this.frames.get(key);
    if (!frame) {
      frame = {
        frameId: identity.frameId,
        revision: identity.revision,
        slotId: identity.slotId,
        txDialShiftHz,
        tracks: new Map(),
      };
      this.frames.set(key, frame);
    }
    const existing = frame.tracks.get(track.trackId);
    if (existing?.requestId && track.requestId === existing.requestId) return false;
    frame.slotId = identity.slotId;
    frame.txDialShiftHz = txDialShiftHz;
    frame.tracks.set(track.trackId, track);
    this.prune();
    return true;
  }

  getSnapshot(identity: FrameAudioIdentity): FrameAudioSnapshot | null {
    const frame = this.frames.get(frameKey(identity));
    if (!frame) return null;
    return {
      frameId: frame.frameId,
      revision: frame.revision,
      slotId: frame.slotId,
      txDialShiftHz: frame.txDialShiftHz,
      tracks: new Map(frame.tracks),
    };
  }

  cloneFrame(
    source: FrameAudioIdentity,
    target: FrameAudioIdentity & { slotId: string },
    retainedTrackIds: readonly string[],
  ): FrameAudioSnapshot | null {
    const sourceFrame = this.frames.get(frameKey(source));
    if (!sourceFrame) return null;
    const tracks = new Map<string, EncodedTrack>();
    for (const trackId of retainedTrackIds) {
      const track = sourceFrame.tracks.get(trackId);
      if (track) tracks.set(track.trackId, track);
    }
    const cloned: MutableFrameAudio = {
      frameId: target.frameId,
      revision: target.revision,
      slotId: target.slotId,
      txDialShiftHz: sourceFrame.txDialShiftHz,
      tracks,
    };
    this.frames.set(frameKey(target), cloned);
    this.prune();
    return this.getSnapshot(target);
  }

  removeFrame(identity: FrameAudioIdentity): number {
    const key = frameKey(identity);
    const frame = this.frames.get(key);
    if (!frame) return 0;
    this.frames.delete(key);
    this.retainedKeys.delete(key);
    return frame.tracks.size;
  }

  retain(identity: FrameAudioIdentity): void {
    this.retainedKeys.add(frameKey(identity));
  }

  release(identity: FrameAudioIdentity): void {
    this.retainedKeys.delete(frameKey(identity));
    this.prune();
  }

  clearUnretained(): number {
    let removed = 0;
    for (const [key, frame] of this.frames) {
      if (this.retainedKeys.has(key)) continue;
      removed += frame.tracks.size;
      this.frames.delete(key);
    }
    return removed;
  }

  private prune(): void {
    if (this.frames.size <= this.maxFrames) return;
    for (const key of this.frames.keys()) {
      if (this.frames.size <= this.maxFrames) break;
      if (this.retainedKeys.has(key)) continue;
      this.frames.delete(key);
    }
  }
}
