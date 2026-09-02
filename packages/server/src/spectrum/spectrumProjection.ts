import type { SpectrumFrame, SpectrumFrameSupplement, SpectrumViewport } from '@tx5dr/contracts';

// Frames are immutable objects emitted by SpectrumCoordinator. Keep the
// decoded wire buffer weakly keyed by frame identity so different client
// viewports share the same decode as well as the projection cache in WSServer.
const decodedFrameCache = new WeakMap<SpectrumFrame, Int16Array>();
const decodedSupplementCache = new WeakMap<SpectrumFrameSupplement, Int16Array>();

function decodeInt16(frame: SpectrumFrame): Int16Array {
  const cached = decodedFrameCache.get(frame);
  if (cached) return cached;
  const bytes = Buffer.from(frame.binaryData.data, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = Math.min(frame.binaryData.format.length, Math.floor(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT));
  const values = new Int16Array(length);
  for (let index = 0; index < length; index += 1) values[index] = view.getInt16(index * 2, true);
  decodedFrameCache.set(frame, values);
  return values;
}

function decodeSupplement(supplement: SpectrumFrameSupplement): Int16Array {
  const cached = decodedSupplementCache.get(supplement);
  if (cached) return cached;
  const bytes = Buffer.from(supplement.binaryData.data, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = Math.min(supplement.binaryData.format.length, Math.floor(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT));
  const values = new Int16Array(length);
  for (let index = 0; index < length; index++) values[index] = view.getInt16(index * 2, true);
  decodedSupplementCache.set(supplement, values);
  return values;
}

function sampleAt(values: Int16Array, range: { min: number; max: number }, frequency: number): number | null {
  if (values.length === 0 || range.max <= range.min || frequency < range.min || frequency > range.max) return null;
  const position = ((frequency - range.min) / (range.max - range.min)) * (values.length - 1);
  const left = Math.floor(position);
  const right = Math.min(values.length - 1, left + 1);
  const factor = position - left;
  return Math.round(values[left]! + (values[right]! - values[left]!) * factor);
}

export function projectSpectrumFrame(frame: SpectrumFrame, viewport: SpectrumViewport | null): SpectrumFrame {
  if (!viewport || frame.kind !== 'radio-sdr') return frame;
  const sourceRange = frame.frequencyRange;
  const sourceSpan = sourceRange.max - sourceRange.min;
  const targetSpan = viewport.max - viewport.min;
  if (sourceSpan <= 0 || targetSpan <= 0) return frame;
  const source = decodeInt16(frame);
  const supplement = frame.supplement;
  const supplementValues = supplement ? decodeSupplement(supplement) : null;
  if (source.length === 0) return frame;

  const scale = frame.binaryData.format.scale ?? 1;
  const offset = frame.binaryData.format.offset ?? 0;
  const fillValue = scale !== 0 && frame.meta.level ? Math.round((frame.meta.level.min - offset) / scale) : 0;
  const output = new Int16Array(viewport.displayBinCount);
  for (let index = 0; index < output.length; index += 1) {
    const frequency = viewport.min + (index * targetSpan) / Math.max(output.length - 1, 1);
    const primary = sampleAt(source, sourceRange, frequency);
    const fallback = supplement && supplementValues
      ? sampleAt(supplementValues, supplement.frequencyRange, frequency)
      : null;
    output[index] = primary ?? fallback ?? fillValue;
  }

  return {
    ...frame,
    frequencyRange: { min: viewport.min, max: viewport.max },
    binaryData: {
      ...frame.binaryData,
      data: Buffer.from(output.buffer).toString('base64'),
      format: { ...frame.binaryData.format, length: output.length },
    },
    meta: {
      ...frame.meta,
      nativeFrequencyRange: frame.meta.nativeFrequencyRange ?? sourceRange,
      displayBinCount: output.length,
      spanHz: targetSpan,
    },
  };
}
