import type { SpectrumFrame } from '@tx5dr/contracts';
import type { IcomScopeFrame } from 'icom-wlan-node';
import type { SpectrumLine } from 'hamlib';

export const SPECTRUM_DISPLAY_BIN_COUNT = 1024;

export function resampleBins(input: ArrayLike<number>, targetLength: number): Int16Array {
  if (targetLength <= 0) {
    return new Int16Array(0);
  }

  if (input.length === 0) {
    return new Int16Array(targetLength);
  }

  if (input.length === targetLength) {
    return Int16Array.from(Array.from(input, value => Math.round(Number(value))));
  }

  const output = new Int16Array(targetLength);
  const maxIndex = input.length - 1;

  for (let i = 0; i < targetLength; i++) {
    const sourcePos = (i * maxIndex) / Math.max(targetLength - 1, 1);
    const left = Math.floor(sourcePos);
    const right = Math.min(left + 1, maxIndex);
    const factor = sourcePos - left;
    const leftValue = Number(input[left]);
    const rightValue = Number(input[right]);
    output[i] = Math.round(leftValue + (rightValue - leftValue) * factor);
  }

  return output;
}

export function int16ArrayToBase64(data: Int16Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

export function normalizeSpectrumFrame(
  frame: Omit<SpectrumFrame, 'binaryData'> & {
    binaryData: {
      data: Int16Array;
      scale?: number;
      offset?: number;
    };
  }
): SpectrumFrame {
  return {
    ...frame,
    binaryData: {
      data: int16ArrayToBase64(frame.binaryData.data),
      format: {
        type: 'int16',
        length: frame.binaryData.data.length,
        scale: frame.binaryData.scale,
        offset: frame.binaryData.offset,
      },
    },
  };
}

export function createRadioSpectrumFrame(
  scopeFrame: IcomScopeFrame,
  profileId: string | null,
  radioModel?: string
): SpectrumFrame {
  const resampledPixels = resampleBins(scopeFrame.pixels, SPECTRUM_DISPLAY_BIN_COUNT);
  const spanHz = scopeFrame.endFreqHz - scopeFrame.startFreqHz;

  return normalizeSpectrumFrame({
    timestamp: Date.now(),
    kind: 'radio-sdr',
    frequencyRange: {
      min: scopeFrame.startFreqHz,
      max: scopeFrame.endFreqHz,
    },
    binaryData: {
      data: resampledPixels,
      scale: 1,
      offset: 0,
    },
    meta: {
      sourceBinCount: scopeFrame.pixels.length,
      displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
      centerFrequency: scopeFrame.startFreqHz + spanHz / 2,
      spanHz,
      profileId,
      radioModel,
    },
  });
}

export function createHamlibRadioSpectrumFrame(
  spectrumLine: SpectrumLine,
  profileId: string | null,
  radioModel?: string
): SpectrumFrame {
  const sourceData = spectrumLine.data.subarray(0, spectrumLine.dataLength);
  const resampledPixels = resampleBins(sourceData, SPECTRUM_DISPLAY_BIN_COUNT);

  return normalizeSpectrumFrame({
    timestamp: spectrumLine.timestamp || Date.now(),
    kind: 'radio-sdr',
    frequencyRange: {
      min: spectrumLine.lowEdgeFreq,
      max: spectrumLine.highEdgeFreq,
    },
    binaryData: {
      data: resampledPixels,
      scale: 1,
      offset: 0,
    },
    meta: {
      sourceBinCount: sourceData.length,
      displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
      centerFrequency: spectrumLine.centerFreq,
      spanHz: spectrumLine.spanHz,
      profileId,
      radioModel,
    },
  });
}
