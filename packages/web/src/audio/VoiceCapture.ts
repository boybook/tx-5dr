/**
 * VoiceCapture - Microphone capture + Opus encoding + WebSocket transmission
 *
 * Captures audio from getUserMedia, processes through AudioWorklet,
 * encodes to Opus via WebCodecs AudioEncoder, and sends binary frames
 * over a dedicated WebSocket connection.
 *
 * Lifecycle:
 *   1. start() - Opens mic, initializes AudioWorklet + Opus encoder + WS
 *   2. setPTTActive(true) - Begins sending encoded frames to server
 *   3. setPTTActive(false) - Stops sending (mic stays open to avoid re-permission)
 *   4. stop() - Releases all resources
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('VoiceCapture');

/** Opus encoding parameters */
const OPUS_SAMPLE_RATE = 48000;
const OPUS_FRAME_DURATION_MS = 20;
const OPUS_FRAME_SIZE = (OPUS_SAMPLE_RATE * OPUS_FRAME_DURATION_MS) / 1000; // 960 samples
const OPUS_BITRATE = 24000; // 24 kbps - good quality for voice

export interface VoiceCaptureOptions {
  /** WebSocket URL for voice audio binary stream */
  wsUrl: string;
  /** Called when capture state changes */
  onStateChange?: (state: VoiceCaptureState) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

export type VoiceCaptureState = 'idle' | 'starting' | 'capturing' | 'error';

export class VoiceCapture {
  private options: VoiceCaptureOptions;
  private state: VoiceCaptureState = 'idle';
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private ws: WebSocket | null = null;
  private pttActive = false;

  // Opus encoding via WebCodecs
  private audioEncoder: AudioEncoder | null = null;
  private pcmBuffer: Float32Array = new Float32Array(0);

  constructor(options: VoiceCaptureOptions) {
    this.options = options;
  }

  get captureState(): VoiceCaptureState {
    return this.state;
  }

  get isPTTActive(): boolean {
    return this.pttActive;
  }

  /**
   * Start microphone capture and initialize all resources.
   * The mic stays open but audio is only sent when PTT is active.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      logger.warn('VoiceCapture already started');
      return;
    }

    this.setState('starting');

    try {
      // 1. Get microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: OPUS_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      logger.info('Microphone access granted');

      // 2. Create AudioContext at Opus sample rate
      this.audioContext = new AudioContext({ sampleRate: OPUS_SAMPLE_RATE });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // 3. Initialize AudioWorklet for capture
      await this.initWorklet();

      // 4. Initialize Opus encoder (WebCodecs or fallback)
      await this.initEncoder();

      // 5. Connect WebSocket for binary audio
      this.initWebSocket();

      this.setState('capturing');
      logger.info('Voice capture started');
    } catch (error) {
      logger.error('Failed to start voice capture:', error);
      this.setState('error');
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.cleanup();
      throw error;
    }
  }

  /**
   * Stop capture and release all resources.
   */
  stop(): void {
    if (this.state === 'idle') return;

    logger.info('Stopping voice capture');
    this.pttActive = false;

    // Signal worklet to stop forwarding
    this.workletNode?.port.postMessage({ type: 'stop' });

    this.cleanup();
    this.setState('idle');
  }

  /**
   * Control whether captured audio is sent to the server.
   * The mic stays open regardless of PTT state.
   */
  setPTTActive(active: boolean): void {
    this.pttActive = active;

    if (active) {
      // Start forwarding audio frames from worklet
      this.workletNode?.port.postMessage({ type: 'start' });
      logger.debug('PTT activated, sending audio');
    } else {
      // Stop forwarding audio frames
      this.workletNode?.port.postMessage({ type: 'stop' });
      // Clear the PCM buffer to avoid sending stale audio on next PTT
      this.pcmBuffer = new Float32Array(0);
      logger.debug('PTT deactivated, stopped sending');
    }
  }

  private setState(state: VoiceCaptureState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private async initWorklet(): Promise<void> {
    if (!this.audioContext || !this.sourceNode) return;

    try {
      // Load the worklet module
      const workletUrl = new URL('./voice-capture-worklet.ts', import.meta.url);
      await this.audioContext.audioWorklet.addModule(workletUrl.href);

      this.workletNode = new AudioWorkletNode(this.audioContext, 'voice-capture-processor');

      // Listen for PCM frames from the worklet
      this.workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === 'pcmFrame' && this.pttActive) {
          this.handlePCMFrame(event.data.data as Float32Array);
        }
      };

      // Connect: source -> worklet (worklet doesn't output to speakers)
      this.sourceNode.connect(this.workletNode);
      // Connect to destination to keep the graph alive (with zero gain)
      // Some browsers stop processing if the graph isn't connected to destination
      this.workletNode.connect(this.audioContext.destination);

      logger.debug('AudioWorklet initialized');
    } catch (error) {
      // Fallback: use ScriptProcessorNode if AudioWorklet is not available
      logger.warn('AudioWorklet not available, using ScriptProcessor fallback:', error);
      this.initScriptProcessorFallback();
    }
  }

  private initScriptProcessorFallback(): void {
    if (!this.audioContext || !this.sourceNode) return;

    // ScriptProcessorNode with 4096 buffer size for 20ms frames at 48kHz
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processorNode = (this.audioContext as any).createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.pttActive) return;

      const inputData = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(inputData.length);
      copy.set(inputData);
      this.handlePCMFrame(copy);
    };

    this.sourceNode.connect(processorNode);
    processorNode.connect(this.audioContext.destination);

    // Store as workletNode for unified cleanup (duck typing)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.workletNode = processorNode as any;
  }

  private async initEncoder(): Promise<void> {
    // Check for WebCodecs AudioEncoder support
    if (typeof AudioEncoder !== 'undefined') {
      try {
        this.audioEncoder = new AudioEncoder({
          output: (chunk: EncodedAudioChunk) => {
            this.handleEncodedChunk(chunk);
          },
          error: (error: DOMException) => {
            logger.error('AudioEncoder error:', error);
          },
        });

        this.audioEncoder.configure({
          codec: 'opus',
          sampleRate: OPUS_SAMPLE_RATE,
          numberOfChannels: 1,
          bitrate: OPUS_BITRATE,
        });

        logger.info('WebCodecs AudioEncoder initialized (Opus)');
        return;
      } catch (error) {
        logger.warn('WebCodecs AudioEncoder initialization failed, will send raw PCM:', error);
      }
    }

    // Fallback: no encoder available, will send raw PCM
    logger.info('WebCodecs AudioEncoder not available, using raw PCM mode');
    this.audioEncoder = null;
  }

  /**
   * Handle raw PCM frames from the worklet.
   * Accumulates samples to form complete Opus frames (960 samples at 48kHz = 20ms).
   */
  private handlePCMFrame(pcmData: Float32Array): void {
    if (!this.pttActive) return;

    // Append to buffer
    const newBuffer = new Float32Array(this.pcmBuffer.length + pcmData.length);
    newBuffer.set(this.pcmBuffer);
    newBuffer.set(pcmData, this.pcmBuffer.length);
    this.pcmBuffer = newBuffer;

    // Process complete Opus frames
    while (this.pcmBuffer.length >= OPUS_FRAME_SIZE) {
      const frame = this.pcmBuffer.slice(0, OPUS_FRAME_SIZE);
      this.pcmBuffer = this.pcmBuffer.slice(OPUS_FRAME_SIZE);

      if (this.audioEncoder && this.audioEncoder.state === 'configured') {
        // Encode with WebCodecs
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: OPUS_SAMPLE_RATE,
          numberOfFrames: OPUS_FRAME_SIZE,
          numberOfChannels: 1,
          timestamp: performance.now() * 1000, // microseconds
          data: frame,
        });
        this.audioEncoder.encode(audioData);
        audioData.close();
      } else {
        // Fallback: send raw PCM as Int16LE
        this.sendRawPCM(frame);
      }
    }
  }

  /**
   * Handle Opus-encoded chunks from WebCodecs AudioEncoder.
   */
  private handleEncodedChunk(chunk: EncodedAudioChunk): void {
    if (!this.pttActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.ws.send(data.buffer);
  }

  /**
   * Fallback: convert Float32 PCM to Int16LE and send.
   */
  private sendRawPCM(frame: Float32Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const int16 = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    this.ws.send(int16.buffer);
  }

  private initWebSocket(): void {
    const { wsUrl } = this.options;
    logger.info('Connecting voice audio WebSocket:', wsUrl);

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      logger.info('Voice audio WebSocket connected');
    };

    this.ws.onerror = (event) => {
      logger.error('Voice audio WebSocket error:', event);
    };

    this.ws.onclose = () => {
      logger.info('Voice audio WebSocket closed');
    };
  }

  private cleanup(): void {
    // Disconnect and close worklet
    try {
      this.workletNode?.disconnect();
    } catch {
      // ignore
    }
    this.workletNode = null;

    // Close source node
    try {
      this.sourceNode?.disconnect();
    } catch {
      // ignore
    }
    this.sourceNode = null;

    // Close AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;

    // Stop media tracks
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // Close encoder
    if (this.audioEncoder && this.audioEncoder.state !== 'closed') {
      try {
        this.audioEncoder.close();
      } catch {
        // ignore
      }
    }
    this.audioEncoder = null;

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Clear buffer
    this.pcmBuffer = new Float32Array(0);
  }
}
