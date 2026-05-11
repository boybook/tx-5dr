import { createRequire } from 'module';
import { existsSync, statSync } from 'node:fs';
import { audioToDeepCWSpectrogramTensor, type DeepCWInputType } from './DeepCWFeatureExtractor.js';
import type { CWDecoderCharacterSpan, CWDecoderWordSpaceSpan } from '../cw-decoder/types.js';

interface DeepCWOnnxMetadata {
  isTensor?: boolean;
  type?: string;
  shape?: readonly unknown[];
}

interface DeepCWOnnxSession {
  inputNames: string[];
  outputNames: string[];
  inputMetadata?: DeepCWOnnxMetadata[];
  outputMetadata?: DeepCWOnnxMetadata[];
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}

export interface CWDecoderWorkerRequest {
  id: number;
  audio: Float32Array;
  sampleRate: number;
  modelPath?: string | null;
  runtimeBackend?: 'cpu' | 'cuda' | 'coreml' | 'directml' | 'wasm' | 'webgpu';
  modelSize?: 'tiny' | 'small';
  language?: string;
  targetFreqHz?: number;
  filterWidthHz?: number;
}

export interface CWDecoderWorkerResult {
  id: number;
  text: string;
  confidence: number;
  displayText?: string;
  plainText?: string;
  wordSpaceSpans?: CWDecoderWordSpaceSpan[];
  characterSpans?: CWDecoderCharacterSpan[];
}

export interface CWDecoderRuntimeProbe {
  available: boolean;
  error: string | null;
}

export function probeDeepCWRuntime(modelPath?: string | null): CWDecoderRuntimeProbe {
  const require = createRequire(import.meta.url);
  try {
    require.resolve('onnxruntime-node');
  } catch (error) {
    return { available: false, error: `onnxruntime-node is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!modelPath) {
    return { available: false, error: 'DeepCW model path is not configured' };
  }
  try {
    if (!existsSync(modelPath) || !statSync(modelPath).isFile()) {
      return { available: false, error: `DeepCW model file not found: ${modelPath}` };
    }
  } catch (error) {
    return { available: false, error: `DeepCW model file is not readable: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { available: true, error: null };
}

let cachedSession: unknown | null = null;
let cachedSessionKey = '';

export async function runDeepCWDecode(request: CWDecoderWorkerRequest): Promise<CWDecoderWorkerResult> {
  const probe = probeDeepCWRuntime(request.modelPath);
  if (!probe.available) {
    throw new Error(probe.error ?? 'DeepCW runtime is unavailable');
  }
  if (request.sampleRate !== 9_600) {
    throw new Error(`DeepCW worker expects 9600 Hz PCM, received ${request.sampleRate} Hz`);
  }

  const require = createRequire(import.meta.url);
  const ort = require('onnxruntime-node') as {
    Tensor: new (type: string, data: Float32Array | Uint16Array, dims: readonly number[]) => unknown;
    InferenceSession: {
      create: (modelPath: string, options?: Record<string, unknown>) => Promise<DeepCWOnnxSession>;
    };
  };
  const session = await getSession(ort, request);
  validateDeepCWSessionMetadata(session, request.language === 'ja' ? 'ja' : 'en');
  const inputType = getModelInputType(session);
  const spectrogram = audioToDeepCWSpectrogramTensor(
    request.audio,
    inputType,
    typeof request.targetFreqHz === 'number' ? request.targetFreqHz : 800,
    typeof request.filterWidthHz === 'number' ? request.filterWidthHz : 800,
  );
  if (!spectrogram) {
    return { id: request.id, text: '', confidence: 0 };
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error('DeepCW ONNX model is missing input or output metadata');
  }
  const tensor = new ort.Tensor(spectrogram.type, spectrogram.data, spectrogram.dims);
  const results = await session.run({ [inputName]: tensor });
  const output = results[outputName];
  if (!output) {
    throw new Error(`DeepCW ONNX output not found: ${outputName}`);
  }

  const decoded = decodeDeepCWOutput(output.data, output.dims, request.language === 'ja' ? 'ja' : 'en');
  return { id: request.id, ...decoded };
}

async function getSession(ort: {
  InferenceSession: {
    create: (modelPath: string, options?: Record<string, unknown>) => Promise<DeepCWOnnxSession>;
  };
}, request: CWDecoderWorkerRequest) {
  const modelPath = request.modelPath!;
  const backend = request.runtimeBackend ?? 'cpu';
  const key = `${modelPath}|${backend}`;
  if (cachedSession && cachedSessionKey === key) {
    return cachedSession as Awaited<ReturnType<typeof ort.InferenceSession.create>>;
  }
  const providers = backend === 'cpu' ? ['cpu'] : [normalizeExecutionProvider(backend), 'cpu'];
  cachedSession = await ort.InferenceSession.create(modelPath, {
    executionProviders: providers,
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  cachedSessionKey = key;
  return cachedSession as Awaited<ReturnType<typeof ort.InferenceSession.create>>;
}

function normalizeExecutionProvider(backend: NonNullable<CWDecoderWorkerRequest['runtimeBackend']>): string {
  if (backend === 'directml') return 'dml';
  return backend;
}

function getModelInputType(session: DeepCWOnnxSession): DeepCWInputType {
  const inputType = session.inputMetadata?.[0]?.type;
  if (inputType === 'float16' || inputType === 'float32') {
    return inputType;
  }
  throw new Error(`Unsupported DeepCW ONNX input type: ${inputType ?? 'unknown'}`);
}

function validateDeepCWSessionMetadata(session: DeepCWOnnxSession, lang: 'en' | 'ja'): void {
  const input = session.inputMetadata?.[0];
  const output = session.outputMetadata?.[0];
  if (input?.isTensor === false || output?.isTensor === false) {
    throw new Error('DeepCW ONNX model input/output metadata must be tensor metadata');
  }

  const inputShape = input?.shape;
  if (inputShape && inputShape[1] !== 1) {
    throw new Error(`Unexpected DeepCW ONNX input channel dimension: ${String(inputShape[1])}`);
  }
  if (inputShape && inputShape[3] !== 65) {
    throw new Error(`Unexpected DeepCW ONNX input frequency bins: ${String(inputShape[3])}`);
  }

  const outputShape = output?.shape;
  const expectedClasses = (lang === 'ja' ? JA_VOCABULARY.length : EN_VOCABULARY.length) + 1;
  if (outputShape && outputShape[2] !== expectedClasses) {
    throw new Error(`Unexpected DeepCW ONNX output class count: ${String(outputShape[2])}, expected ${expectedClasses}`);
  }
}

const EN_VOCABULARY = [
  ',', '.', '/', '0', '1', '2', '3', '4', '5', '6',
  '7', '8', '9', '?', 'A', 'B', 'C', 'D', 'E', 'F',
  'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
  'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', ' ',
] as const;

const JA_VOCABULARY = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '?', '、', '」', '゛', '゜', 'ア', 'イ', 'ウ', 'エ', 'オ',
  'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ',
  'タ', 'チ', 'ツ', 'テ', 'ト', 'ナ', 'ニ', 'ヌ', 'ネ', 'ノ',
  'ハ', 'ヒ', 'フ', 'ヘ', 'ホ', 'マ', 'ミ', 'ム', 'メ', 'モ',
  'ヤ', 'ユ', 'ヨ', 'ラ', 'リ', 'ル', 'レ', 'ロ', 'ワ', 'ヰ',
  'ヱ', 'ヲ', 'ン', 'ー', '（', '）', ' ',
] as const;

export interface DeepCWDecodedOutput {
  text: string;
  confidence: number;
  displayText: string;
  plainText: string;
  wordSpaceSpans: CWDecoderWordSpaceSpan[];
  characterSpans: CWDecoderCharacterSpan[];
}

export function decodeDeepCWOutput(data: unknown, dims: readonly number[], lang: 'en' | 'ja'): DeepCWDecodedOutput {
  const values = data as ArrayLike<number>;
  const isFloat16 = data instanceof Uint16Array;
  const batchSize = Number(dims[0] ?? 0);
  const timeSteps = Number(dims[1] ?? 0);
  const classes = Number(dims[2] ?? 0);
  if (batchSize < 1 || timeSteps < 1 || classes < 1) {
    return emptyDecodedOutput();
  }

  const vocabulary = lang === 'ja' ? JA_VOCABULARY : EN_VOCABULARY;
  const blankIndex = vocabulary.length;
  let scoreSum = 0;
  const predIndices: number[] = [];

  for (let t = 0; t < timeSteps; t += 1) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    const offset = t * classes;
    for (let c = 0; c < classes; c += 1) {
      const raw = values[offset + c];
      const value = raw == null
        ? Number.NEGATIVE_INFINITY
        : isFloat16
          ? float16BitsToFloat32(raw)
          : Number(raw);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = c;
      }
    }
    scoreSum += Number.isFinite(bestValue) ? bestValue : 0;
    predIndices.push(bestIndex);
  }

  const averageScore = scoreSum / timeSteps;
  const confidence = averageScore <= 0 ? Math.exp(averageScore) : averageScore;
  const plainText = decodeCtcPlain(predIndices, vocabulary, blankIndex);
  return {
    text: plainText.replace(/\s+/g, ' ').trim(),
    confidence: Math.max(0, Math.min(1, confidence)),
    displayText: decodeCtcForDisplay(predIndices, vocabulary, blankIndex),
    plainText,
    wordSpaceSpans: getWordSpaceSpans(predIndices, vocabulary),
    characterSpans: getCharacterSpans(predIndices, vocabulary, blankIndex),
  };
}

function emptyDecodedOutput(): DeepCWDecodedOutput {
  return {
    text: '',
    confidence: 0,
    displayText: '',
    plainText: '',
    wordSpaceSpans: [],
    characterSpans: [],
  };
}

function decodeCtcPlain(predIndices: number[], vocabulary: readonly string[], blankIndex: number): string {
  const decodedChars: string[] = [];
  let previousIndex: number | null = null;

  for (const index of predIndices) {
    if (index === blankIndex) {
      previousIndex = null;
      continue;
    }
    if (index === previousIndex) {
      continue;
    }
    previousIndex = index;
    decodedChars.push(vocabulary[index] ?? '');
  }

  return decodedChars.join('');
}

function decodeCtcForDisplay(predIndices: number[], vocabulary: readonly string[], blankIndex: number): string {
  const decodedChars: string[] = [];
  let previousIndex: number | null = null;

  for (const index of predIndices) {
    if (index === blankIndex) {
      decodedChars.push(' ');
      previousIndex = null;
      continue;
    }
    if (index === previousIndex) {
      decodedChars.push(' ');
      continue;
    }
    previousIndex = index;
    decodedChars.push(vocabulary[index] ?? ' ');
  }

  return decodedChars.join('');
}

function getWordSpaceSpans(predIndices: number[], vocabulary: readonly string[]): CWDecoderWordSpaceSpan[] {
  const spaceIndex = vocabulary.indexOf(' ');
  if (spaceIndex < 0) return [];

  const spans: CWDecoderWordSpaceSpan[] = [];
  let currentStart = -1;
  predIndices.forEach((index, frameIndex) => {
    if (index === spaceIndex) {
      if (currentStart < 0) currentStart = frameIndex;
      return;
    }
    if (currentStart >= 0) {
      spans.push({ startFrame: currentStart, endFrame: frameIndex - 1 });
      currentStart = -1;
    }
  });

  if (currentStart >= 0) {
    spans.push({ startFrame: currentStart, endFrame: predIndices.length - 1 });
  }
  return spans;
}

function getCharacterSpans(predIndices: number[], vocabulary: readonly string[], blankIndex: number): CWDecoderCharacterSpan[] {
  const spans: CWDecoderCharacterSpan[] = [];
  let previousIndex: number | null = null;
  let activeSpanIndex = -1;

  predIndices.forEach((index, frameIndex) => {
    if (index === blankIndex) {
      previousIndex = null;
      activeSpanIndex = -1;
      return;
    }
    if (index === previousIndex) {
      if (activeSpanIndex >= 0) {
        spans[activeSpanIndex]!.endFrame = frameIndex;
      }
      return;
    }

    previousIndex = index;
    const char = vocabulary[index] ?? '';
    if (!char) {
      activeSpanIndex = -1;
      return;
    }
    spans.push({ char, startFrame: frameIndex, endFrame: frameIndex });
    activeSpanIndex = spans.length - 1;
  });

  return spans;
}

function float16BitsToFloat32(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) {
    return fraction === 0 ? sign * 0 : sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}
