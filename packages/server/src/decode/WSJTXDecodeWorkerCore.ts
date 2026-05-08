/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DecodeRequest, DecodeResult } from '@tx5dr/core';
import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DecodeWorkerCore');
const DEFAULT_NATIVE_THREADS = 1;
const MAX_NATIVE_THREADS = 4;

function parseNativeThreads(value: string | undefined): number {
  if (!value) return DEFAULT_NATIVE_THREADS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_NATIVE_THREADS;
  return Math.min(Math.max(parsed, 1), MAX_NATIVE_THREADS);
}

export class WSJTXDecodeWorkerCore {
  private readonly lib: WSJTXLib;
  private readonly nativeThreads: number;

  constructor(nativeThreads: number = parseNativeThreads(process.env.TX5DR_DECODE_NATIVE_THREADS)) {
    this.nativeThreads = Math.min(Math.max(nativeThreads, 1), MAX_NATIVE_THREADS);
    this.lib = new WSJTXLib({ maxThreads: this.nativeThreads });
    logger.info('decode worker core initialized', { nativeThreads: this.nativeThreads });
  }

  async decode(request: DecodeRequest): Promise<DecodeResult> {
    const startTime = performance.now();
    const originalAudioData = new Float32Array(request.pcm);

    let resampledAudioData: Float32Array;
    if (request.sampleRate && request.sampleRate !== 12000) {
      logger.warn(`Unexpected sample rate ${request.sampleRate}Hz, resampling to 12kHz`);
      resampledAudioData = await resampleAudioProfessional(
        originalAudioData,
        request.sampleRate,
        12000,
        1,
      );
    } else {
      resampledAudioData = originalAudioData;
    }

    const apContext = request.apContext;
    const baseFrequency = apContext ? apContext.frequencyHz : 0;
    const decodeMode = request.mode === 'FT4' ? WSJTXMode.FT4 : WSJTXMode.FT8;
    const audioInt16 = await this.lib.convertAudioFormat(resampledAudioData, 'int16') as Int16Array;
    const rawResult = await this.lib.decode(decodeMode, audioInt16, {
      frequency: baseFrequency,
      txFrequency: baseFrequency,
      threads: this.nativeThreads,
      apDecode: Boolean(apContext),
      decodeDepth: 1,
      myCall: apContext?.myCall,
      myGrid: apContext?.myGrid,
      dxCall: apContext?.dxCall,
      dxGrid: apContext?.dxGrid,
      qsoProgress: apContext?.qsoProgress ?? 0,
    });

    const messages = rawResult.messages as any[];
    const frames = (messages || []).map((msg: any) => ({
      message: msg.text,
      snr: msg.snr,
      dt: msg.deltaTime,
      freq: msg.deltaFrequency || 0,
      confidence: 1.0,
    }));

    const processingTimeMs = performance.now() - startTime;
    const decodeResult: DecodeResult = {
      slotId: request.slotId,
      windowIdx: request.windowIdx,
      frames,
      timestamp: request.timestamp,
      processingTimeMs,
      windowOffsetMs: request.windowOffsetMs || 0,
    };

    logger.debug('decode complete', {
      slotId: request.slotId,
      windowIdx: request.windowIdx,
      apDecode: Boolean(apContext),
      apOperatorId: apContext?.operatorId,
      apCurrentSlot: apContext?.currentSlot,
      apQsoProgress: apContext?.qsoProgress,
      signals: decodeResult.frames.length,
      processingTimeMs: Number(processingTimeMs.toFixed(2)),
    });

    return decodeResult;
  }
}
