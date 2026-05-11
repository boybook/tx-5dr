export class FloatRingBuffer {
  private readonly buffer: Float32Array;
  private writeIndex = 0;
  private length = 0;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('FloatRingBuffer capacity must be positive');
    }
    this.buffer = new Float32Array(Math.floor(capacity));
  }

  get capacity(): number {
    return this.buffer.length;
  }

  get size(): number {
    return this.length;
  }

  clear(): void {
    this.writeIndex = 0;
    this.length = 0;
    this.buffer.fill(0);
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i += 1) {
      this.buffer[this.writeIndex] = samples[i] ?? 0;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.length = Math.min(this.length + 1, this.capacity);
    }
  }

  latest(count: number): Float32Array {
    const n = Math.max(0, Math.min(Math.floor(count), this.length));
    const out = new Float32Array(n);
    const start = (this.writeIndex - n + this.capacity) % this.capacity;
    for (let i = 0; i < n; i += 1) {
      out[i] = this.buffer[(start + i) % this.capacity] ?? 0;
    }
    return out;
  }
}
