/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DecodeRequest, DecodeResult } from '@tx5dr/core';
import { WSJTXLib, WSJTXMode, type WSJTXDecodeSession, type WSJTXDecodeStage, type DecodeOptions } from 'wsjtx-lib';
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
  private activeSession: { id: string; mode: WSJTXMode; depth: number; session: WSJTXDecodeSession } | null = null;
  private activeAudioContext: {
    sessionId: string;
    sourceSampleRate: number;
    sourceLength: number;
    sourceAudio: Float32Array;
    int16Audio: Int16Array;
  } | null = null;

  constructor(nativeThreads: number = parseNativeThreads(process.env.TX5DR_DECODE_NATIVE_THREADS)) {
    this.nativeThreads = Math.min(Math.max(nativeThreads, 1), MAX_NATIVE_THREADS);
    this.lib = new WSJTXLib({ maxThreads: this.nativeThreads });
    logger.info('decode worker core initialized', { nativeThreads: this.nativeThreads });
  }

  async decode(request: DecodeRequest): Promise<DecodeResult> {
    const startTime = performance.now();
    const apContext = request.apContext;
    const baseFrequency = apContext ? apContext.frequencyHz : 0;
    const decodeMode = request.mode === 'FT4' ? WSJTXMode.FT4 : WSJTXMode.FT8;
    const slotUtc = request.slotUtcSeconds === undefined
      ? undefined
      : (() => {
          const date = new Date(request.slotUtcSeconds * 1000);
          return date.getUTCHours() * 10000 + date.getUTCMinutes() * 100 + date.getUTCSeconds();
        })();
    const decodeDepth = request.decodeDepth ?? 3;
    if (!Number.isInteger(decodeDepth) || decodeDepth < 1 || decodeDepth > 3) {
      throw new Error('decodeDepth must be 1, 2, or 3');
    }

    const staged = Boolean(request.decodeSessionId && request.decodeStage !== undefined && !request.lateRetry);
    if (staged) {
      const sessionId = request.decodeSessionId!;
      if (this.activeSession?.id !== sessionId) {
        this.activeSession?.session.endDecodeSession();
        const session = this.lib.beginDecodeSession({
          sessionId,
          mode: decodeMode,
          decodeDepth: decodeDepth as 1 | 2 | 3,
          ...(slotUtc !== undefined ? { slotUtc } : {}),
        });
        this.activeSession = { id: sessionId, mode: decodeMode, depth: decodeDepth, session };
        this.activeAudioContext = null;
      }
      const activeSession = this.activeSession;
      if (!activeSession) throw new Error('Decode session was not initialized');
      if (activeSession.mode !== decodeMode || activeSession.depth !== decodeDepth) {
        throw new Error('Decode session mode and depth must remain stable within a slot');
      }
      if (activeSession.session.isStageDuplicate(request.decodeStage as WSJTXDecodeStage)) {
        if (request.decodeFinalWindow) {
          activeSession.session.endDecodeSession();
          this.activeSession = null;
          this.activeAudioContext = null;
        }
        const duplicateResult: DecodeResult = {
          slotId: request.slotId,
          windowIdx: request.windowIdx,
          frames: [],
          timestamp: request.timestamp,
          processingTimeMs: performance.now() - startTime,
          nativeProcessingTimeMs: 0,
          decodeDepth,
          ...(request.decisionDeadlineMs !== undefined ? { late: Date.now() > request.decisionDeadlineMs } : {}),
          decodeStage: request.decodeStage,
          windowOffsetMs: request.windowOffsetMs || 0,
        };
        logger.debug('duplicate staged decode skipped before audio preprocessing', {
          slotId: request.slotId,
          stage: request.decodeStage,
          windowIdx: request.windowIdx,
        });
        return duplicateResult;
      }
    } else {
      this.activeSession?.session.endDecodeSession();
      this.activeSession = null;
      this.activeAudioContext = null;
    }

    const originalAudioData = new Float32Array(request.pcm);
    const sourceSampleRate = request.sampleRate || 12000;
    let audioInt16: Int16Array;
    let reusedAudioPrefix = false;
    if (staged && sourceSampleRate === 12000 && this.activeSession && this.activeAudioContext
      && this.activeAudioContext.sessionId === request.decodeSessionId
      && this.activeAudioContext.sourceSampleRate === sourceSampleRate
      && originalAudioData.length >= this.activeAudioContext.sourceLength
      && Buffer.from(originalAudioData.buffer, originalAudioData.byteOffset,
        this.activeAudioContext.sourceLength * Float32Array.BYTES_PER_ELEMENT).equals(
        Buffer.from(this.activeAudioContext.sourceAudio.buffer, this.activeAudioContext.sourceAudio.byteOffset,
          this.activeAudioContext.sourceAudio.byteLength))) {
      const previous = this.activeAudioContext;
      const tail = originalAudioData.subarray(previous.sourceLength);
      if (tail.length === 0) {
        audioInt16 = previous.int16Audio;
        reusedAudioPrefix = true;
      } else {
        const convertedTail = await this.lib.convertAudioFormat(tail, 'int16') as Int16Array;
        audioInt16 = new Int16Array(previous.int16Audio.length + convertedTail.length);
        audioInt16.set(previous.int16Audio);
        audioInt16.set(convertedTail, previous.int16Audio.length);
        this.activeAudioContext = {
          sessionId: request.decodeSessionId!,
          sourceSampleRate,
          sourceLength: originalAudioData.length,
          sourceAudio: originalAudioData.slice(),
          int16Audio: audioInt16,
        };
        reusedAudioPrefix = true;
      }
    } else {
      this.activeAudioContext = null;
      let resampledAudioData: Float32Array;
      if (sourceSampleRate !== 12000) {
        logger.warn(`Unexpected sample rate ${sourceSampleRate}Hz, resampling to 12kHz`);
        resampledAudioData = await resampleAudioProfessional(
          originalAudioData,
          sourceSampleRate,
          12000,
          1,
        );
      } else {
        resampledAudioData = originalAudioData;
      }
      audioInt16 = await this.lib.convertAudioFormat(resampledAudioData, 'int16') as Int16Array;
      if (staged && this.activeSession && sourceSampleRate === 12000) {
        this.activeAudioContext = {
          sessionId: request.decodeSessionId!,
          sourceSampleRate,
          sourceLength: originalAudioData.length,
          sourceAudio: originalAudioData.slice(),
          int16Audio: audioInt16,
        };
      }
    }
    if (reusedAudioPrefix) {
      logger.debug('reused staged decode audio prefix', {
        slotId: request.slotId,
        sessionId: request.decodeSessionId,
        sampleCount: audioInt16.length,
      });
    }

    const nativeStart = performance.now();
    const decodeOptions: DecodeOptions = {
      frequency: baseFrequency,
      txFrequency: baseFrequency,
      threads: this.nativeThreads,
      apDecode: Boolean(apContext),
      decodeDepth,
      ...(apContext?.myCall ? { myCall: apContext.myCall } : {}),
      ...(apContext?.myGrid ? { myGrid: apContext.myGrid } : {}),
      ...(apContext?.dxCall ? { dxCall: apContext.dxCall } : {}),
      ...(apContext?.dxGrid ? { dxGrid: apContext.dxGrid } : {}),
      qsoProgress: apContext?.qsoProgress ?? 0,
      ...(request.nagain || request.lateRetry ? { nagain: true } : {}),
      ...(request.emeDelayMs ? { emeDelayMs: request.emeDelayMs } : {}),
    };

    let messages: any[];
    let nativeProcessingTimeMs: number | undefined;
    let decodeStats: DecodeResult['decodeStats'];
    if (staged) {
      const activeSession = this.activeSession;
      if (!activeSession) throw new Error('Decode session was not initialized');
      const result = await activeSession.session.decodeStage(audioInt16, request.decodeStage as WSJTXDecodeStage, decodeOptions);
      messages = result.newMessages as any[];
      nativeProcessingTimeMs = result.processingTimeMs;
      decodeStats = result.stats;
      if (request.decodeFinalWindow) {
        activeSession.session.endDecodeSession();
        this.activeSession = null;
        this.activeAudioContext = null;
      }
    } else {
      const result = await this.lib.decode(decodeMode, audioInt16, decodeOptions);
      messages = result.messages as any[];
      nativeProcessingTimeMs = result.processingTimeMs;
      decodeStats = result.stats;
    }

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
      nativeProcessingTimeMs: nativeProcessingTimeMs ?? performance.now() - nativeStart,
      decodeDepth,
      ...(request.decisionDeadlineMs !== undefined ? { late: Date.now() > request.decisionDeadlineMs } : {}),
      ...(request.decodeStage !== undefined ? { decodeStage: request.decodeStage } : {}),
      ...(decodeStats ? { decodeStats } : {}),
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
