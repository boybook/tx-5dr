import { useRef, useState, useCallback, useEffect } from 'react';
import { getWebSocketUrl } from '../utils/config';
import { createWorkletMonitorNode, ScriptProcessorFallbackNode } from '../utils/audio-monitor-fallback';
import type { AudioMonitorNode, MonitorStatsData } from '../utils/audio-monitor-fallback';
import { OpusMonitorDecoder, canDecodeOpus } from '../audio/OpusMonitorDecoder';
import { createLogger } from '../utils/logger';

const logger = createLogger('useAudioMonitorPlayback');

/** Target sample rate for audio playback (browser standard) */
const TARGET_SAMPLE_RATE = 48000;

/** Interval for AudioContext suspend check (ms) */
const SUSPEND_CHECK_INTERVAL = 3000;

export interface UseAudioMonitorPlaybackOptions {
  /**
   * WS path for binary audio data (relative to WS base).
   * e.g. '/ws/audio-monitor' or '/ws/openwebrx-listen'
   */
  wsPath: string;
}

export interface UseAudioMonitorPlaybackReturn {
  /** Whether audio is currently playing */
  isPlaying: boolean;
  /** Start audio playback (must be called from user gesture for AudioContext) */
  start: () => Promise<void>;
  /** Stop audio playback and release resources */
  stop: () => void;
  /** Monitor stats from the AudioWorklet/ScriptProcessor */
  stats: MonitorStatsData | null;
  /** Set playback volume in dB (-60 to +20) */
  setVolume: (db: number) => void;
  /** Current codec negotiated with server ('opus' | 'pcm') */
  codec: 'opus' | 'pcm';
}

/**
 * Reusable hook for audio monitor playback.
 * Handles AudioContext + AudioWorklet/ScriptProcessor initialization,
 * binary WS connection, Opus/PCM decoding, and resource cleanup.
 *
 * Used by both RadioControl (engine audio monitor) and OpenWebRXSettings (listen preview).
 */
export function useAudioMonitorPlayback(
  options: UseAudioMonitorPlaybackOptions
): UseAudioMonitorPlaybackReturn {
  const { wsPath } = options;

  const [isPlaying, setIsPlaying] = useState(false);
  const [stats, setStats] = useState<MonitorStatsData | null>(null);
  const [codec, setCodec] = useState<'opus' | 'pcm'>('pcm');

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioMonitorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const opusDecoderRef = useRef<OpusMonitorDecoder | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const codecRef = useRef<'opus' | 'pcm'>('pcm');
  const isInitializingRef = useRef(false);
  const suspendCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup everything
  const cleanup = useCallback(() => {
    // Stop suspend check timer
    if (suspendCheckTimerRef.current) {
      clearInterval(suspendCheckTimerRef.current);
      suspendCheckTimerRef.current = null;
    }

    // Close WS
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }

    // Dispose audio nodes
    workletNodeRef.current?.dispose();
    workletNodeRef.current = null;

    gainNodeRef.current?.disconnect();
    gainNodeRef.current = null;

    opusDecoderRef.current?.destroy();
    opusDecoderRef.current = null;

    // Close AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    isInitializingRef.current = false;
    codecRef.current = 'pcm';
    setCodec('pcm');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const start = useCallback(async () => {
    if (isPlaying || isInitializingRef.current) return;
    isInitializingRef.current = true;

    try {
      // 1. Create AudioContext (must be in user gesture handler)
      const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      let monitorNode: AudioMonitorNode;

      if (audioContext.audioWorklet) {
        await audioContext.audioWorklet.addModule('/audio-monitor-worklet.js');
        const workletNode = new AudioWorkletNode(audioContext, 'audio-monitor-processor');
        monitorNode = createWorkletMonitorNode(workletNode);
        logger.debug('AudioWorklet initialized');
      } else {
        logger.debug('AudioWorklet unavailable, falling back to ScriptProcessorNode');
        monitorNode = new ScriptProcessorFallbackNode(audioContext);
      }

      // 2. Connect gain node
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 1.0;
      monitorNode.getOutputNode().connect(gainNode);
      gainNode.connect(audioContext.destination);

      // 3. Stats callback
      monitorNode.onStats((s) => setStats(s));

      audioContextRef.current = audioContext;
      workletNodeRef.current = monitorNode;
      gainNodeRef.current = gainNode;

      // 4. Initialize Opus decoder if supported
      if (canDecodeOpus()) {
        try {
          const decoder = new OpusMonitorDecoder(TARGET_SAMPLE_RATE, 1);
          await decoder.init();
          opusDecoderRef.current = decoder;
          logger.debug('Opus decoder initialized');
        } catch (err) {
          logger.warn('Opus decoder init failed, using PCM', err);
          opusDecoderRef.current = null;
        }
      }

      // 5. Connect binary WS
      const clientId = `listen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const canOpus = !!opusDecoderRef.current;
      codecRef.current = canOpus ? 'opus' : 'pcm';
      setCodec(codecRef.current);

      const wsBaseUrl = getWebSocketUrl();
      const wsUrl = wsBaseUrl.replace(/\/ws\/?$/, `${wsPath}?clientId=${clientId}&codec=${codecRef.current}`);
      logger.info('Connecting audio WS', { url: wsUrl });

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      // Set ALL handlers synchronously BEFORE any events can fire,
      // matching the old RadioService pattern to avoid missing messages.
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          // JSON message (codec negotiation)
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'codec') {
              codecRef.current = msg.codec;
              setCodec(msg.codec);
              logger.debug('Codec negotiated', { codec: msg.codec });
            }
          } catch { /* ignore */ }
          return;
        }

        // Binary audio data
        const buffer = event.data as ArrayBuffer;
        if (!workletNodeRef.current) return;

        // Resume AudioContext if suspended (browser may suspend for power saving)
        if (audioContextRef.current?.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {});
        }

        const receiveTime = performance.now();

        if (codecRef.current === 'opus' && opusDecoderRef.current) {
          opusDecoderRef.current.decode(buffer).then((pcm) => {
            if (pcm.length > 0 && workletNodeRef.current) {
              workletNodeRef.current.postAudioData(
                pcm.buffer as ArrayBuffer,
                TARGET_SAMPLE_RATE,
                receiveTime
              );
            }
          });
        } else {
          workletNodeRef.current.postAudioData(buffer, TARGET_SAMPLE_RATE, receiveTime);
        }
      };

      ws.onclose = () => {
        logger.info('Audio WS disconnected');
        // Clean up and update state so UI reflects disconnection
        if (wsRef.current === ws) {
          wsRef.current = null;
          cleanup();
          setIsPlaying(false);
          setStats(null);
        }
      };

      ws.onerror = (err) => {
        logger.error('Audio WS error', err);
      };

      // Wait for WS open using addEventListener (won't override onerror/onclose)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS connection timeout')), 5000);

        const onOpen = () => {
          clearTimeout(timeout);
          ws.removeEventListener('error', onError);
          resolve();
        };
        const onError = () => {
          clearTimeout(timeout);
          ws.removeEventListener('open', onOpen);
          reject(new Error('WS connection failed'));
        };

        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
      });

      wsRef.current = ws;

      // 6. Start periodic AudioContext suspend check
      // Browsers may suspend AudioContext for power saving; this ensures recovery.
      // The old code did this implicitly via the control WS metadata events (every ~20ms).
      suspendCheckTimerRef.current = setInterval(() => {
        if (audioContextRef.current?.state === 'suspended') {
          logger.debug('AudioContext suspended, attempting resume');
          audioContextRef.current.resume().catch(() => {});
        }
      }, SUSPEND_CHECK_INTERVAL);

      setIsPlaying(true);
      logger.info('Audio playback started');

    } catch (error) {
      logger.error('Failed to start audio playback', error);
      cleanup();
      throw error;
    } finally {
      isInitializingRef.current = false;
    }
  }, [isPlaying, wsPath, cleanup]);

  const stop = useCallback(() => {
    cleanup();
    setIsPlaying(false);
    setStats(null);
    logger.info('Audio playback stopped');
  }, [cleanup]);

  const setVolume = useCallback((db: number) => {
    if (gainNodeRef.current && audioContextRef.current) {
      const gain = Math.pow(10, db / 20);
      gainNodeRef.current.gain.setTargetAtTime(
        gain,
        audioContextRef.current.currentTime,
        0.05
      );
    }
  }, []);

  return { isPlaying, start, stop, stats, setVolume, codec };
}
