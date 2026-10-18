/** Encode the existing checkpoint JSON in short slices, without changing its disk format. */
export async function encodeCheckpoint(checkpoint: object, known: ReadonlySet<string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let text = '';
  let sliceStarted = performance.now();
  const append = (part: string) => {
    text += part;
    if (text.length >= 32 * 1024) { chunks.push(Buffer.from(text)); text = ''; }
  };
  function* encode(value: unknown): Generator<void, void> {
    if (value instanceof Set || Array.isArray(value)) {
      append('['); let separator = '';
      for (const item of value) {
        append(separator); separator = ',';
        yield* encode(item === undefined ? null : item);
        yield;
      }
      append(']');
    } else if (value && typeof value === 'object') {
      append('{'); let separator = '';
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) continue;
        append(separator + JSON.stringify(key) + ':'); separator = ',';
        yield* encode(item);
        yield;
      }
      append('}');
    } else {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new TypeError('Invalid checkpoint value');
      append(encoded);
    }
  }
  const work = encode({ ...checkpoint, known });
  let count = 0;
  let step = work.next();
  while (!step.done) {
    if (++count % 64 === 0 && performance.now() - sliceStarted >= 5) {
      await new Promise<void>(resolve => setImmediate(resolve));
      sliceStarted = performance.now();
    }
    step = work.next();
  }
  if (text) chunks.push(Buffer.from(text));
  return Buffer.concat(chunks);
}
